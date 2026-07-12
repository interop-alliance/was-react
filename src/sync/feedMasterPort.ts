/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The `get` half of a {@link WasSyncPort}: resolves a resource's current master
 * state (for the 412 conflict re-read) from the CHANGES-FEED BODY. Wraps a
 * {@link WasSyncBasePort} (query + conditional writes) and adds the `get` the
 * conflict assembler needs, producing a full {@link WasSyncPort}.
 *
 * Why the feed body rather than a `GET` ETag header: the mutable-head model
 * settles a 412 by re-reading the resource's current `version` and comparing
 * payloads (LWW). A raw `GET` reads that `version` from the response's `etag`
 * header -- which a browser hides on a CROSS-ORIGIN response unless the server
 * sends `Access-Control-Expose-Headers: etag`. A server that does not expose it
 * would make a cross-origin re-read report `version: 0`, so the loser of a push
 * race would re-push forever with a stale `If-Match` and never converge. The
 * `changes` feed carries `version` (and `data`, `_deleted`, ...) in the JSON
 * BODY, which CORS never strips, so resolving the master from the feed is both
 * correct and origin-independent. Normal pull/push are unaffected (they already
 * read `version` from the feed body).
 */
import type {
  Json,
  MasterState,
  SyncCheckpoint,
  WasSyncBasePort,
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
 * Wraps a base port with a `get` that resolves the master state from the changes
 * feed. `query`, `putContent`, `deleteContent`, and `putMeta` pass straight
 * through.
 *
 * @param base {WasSyncBasePort}
 * @returns {WasSyncPort}
 */
export function withFeedMasterRead(base: WasSyncBasePort): WasSyncPort {
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
        // Reached the end of the feed without finding it: the resource is
        // genuinely absent (a delete/delete race), so report `null` and let the
        // conflict assembler synthesize a tombstone.
        if (next === null || documents.length === 0) {
          return null
        }
        checkpoint = next
      }
      // The page budget ran out before the feed's end. The feed is keyset-
      // ordered ascending on `updatedAt`, so a just-conflicted resource sits at
      // the tail -- the least-reachable position -- and may well be past the
      // cap. Reporting `null` here would fabricate a false tombstone in the
      // conflict assembler and drop the winner's payload. Throw instead: RxDB
      // treats a thrown push-handler error as retryable, so the whole
      // replication cycle retries rather than diverging.
      throw new Error(
        `Feed master re-read for resource "${id}" exhausted its ` +
          `${MAX_PAGES}-page scan budget without reaching the end of the ` +
          `changes feed; retrying.`
      )
    }
  }
}
