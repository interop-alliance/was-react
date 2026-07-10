/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * A thin adapter over a {@link WasSyncPort} that resolves a resource's current
 * master state (for the 412 conflict re-read) from the CHANGES-FEED BODY rather
 * than the base port's `GET` ETag header.
 *
 * Why this exists: the mutable-head model settles a 412 by re-reading the
 * resource's current `version` and comparing payloads (LWW). The verbatim
 * `wasSyncPort.get()` reads that `version` from the response's `etag` header --
 * which a browser hides on a CROSS-ORIGIN response unless the server sends
 * `Access-Control-Expose-Headers: etag`. A server that does not expose it makes
 * cross-origin `get()` report `version: 0`, which makes the loser of a push race
 * re-push forever with a stale `If-Match` and never converge. The `changes` feed
 * carries `version` (and `data`, `_deleted`, ...) in the JSON BODY, which CORS
 * never strips, so resolving the master from the feed is both correct and
 * origin-independent. Normal pull/push are unaffected (they already read
 * `version` from the feed body), so only `get` is overridden.
 */
import type {
  Json,
  MasterState,
  SyncCheckpoint,
  WasSyncPort,
  WireDoc
} from './types.js'

// A generous page cap so a pathological feed cannot spin forever; conflicts are
// rare and the dev/e2e feed is small, so a full scan is acceptable.
const MAX_PAGES = 50
const PAGE_SIZE = 500

/**
 * Builds a `MasterState` from a `changes`-feed document (all fields in-body).
 */
function toMasterState(doc: WireDoc): MasterState {
  const master: MasterState = {
    version: doc.version,
    updatedAt: doc.updatedAt,
    deleted: doc._deleted
  }
  if (doc.data !== undefined) {
    master.data = doc.data as Json
  }
  if (doc.metaVersion !== undefined) {
    master.metaVersion = doc.metaVersion
  }
  if (doc.custom !== undefined) {
    master.custom = doc.custom as Json
  }
  return master
}

/**
 * Wraps a base port so its `get` resolves the master state from the changes feed.
 * `query`, `putContent`, `deleteContent`, and `putMeta` pass straight through.
 *
 * @param base {WasSyncPort}
 * @returns {WasSyncPort}
 */
export function withFeedMasterRead(base: WasSyncPort): WasSyncPort {
  return {
    query: base.query.bind(base),
    putContent: base.putContent.bind(base),
    deleteContent: base.deleteContent.bind(base),
    putMeta: base.putMeta.bind(base),
    async get({ id }): Promise<MasterState | null> {
      let checkpoint: SyncCheckpoint | undefined
      for (let page = 0; page < MAX_PAGES; page++) {
        const { documents, checkpoint: next } = await base.query({
          ...(checkpoint !== undefined && { checkpoint }),
          limit: PAGE_SIZE
        })
        const found = documents.find(doc => doc.id === id)
        if (found) {
          return toMasterState(found)
        }
        if (next === null || documents.length === 0) {
          break
        }
        checkpoint = next
      }
      return null
    }
  }
}
