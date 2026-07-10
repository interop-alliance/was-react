/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The push side of the WAS replication adapter: fans each local change out to
 * conditional WAS writes and assembles the RxDB conflict entry when the server
 * rejects a write with `412`.
 *
 * A single RxDB document spans two independently-versioned sub-resources: the
 * content (`data` / `version`, at `PUT/DELETE /:id`) and the metadata (`custom`
 * / `metaVersion`, at `PUT /:id/meta`). This handler diffs the new local state
 * against the assumed master to route each half:
 *
 * - content changed -> `PUT /:id` (`If-Match: "<version>"`) or, on create,
 *   `PUT /:id` (`If-None-Match: *`); a delete -> `DELETE /:id`.
 * - metadata changed -> `PUT /:id/meta` (`If-Match: "<metaVersion>"`, or
 *   `If-None-Match: *` when the resource has no metadata yet).
 *
 * Content is written before metadata on a create, because the server rejects a
 * `/meta` write to a resource that does not yet exist.
 *
 * RxDB's push contract asks only for *conflicts* back (the current master state
 * of each rejected row); a successful write's new `version` / `metaVersion` is
 * not returned here -- it is picked up on the next pull, where our own write
 * echoes back as a remote change (idempotent, since the bodies are
 * byte-identical). We deliberately do not capture the `204` ETag to short-circuit
 * that echo: doing so would require a side write to the local revision fields
 * from inside the push handler, which risks a re-push loop, for no correctness
 * gain on immutable content-addressed collections.
 */
import type { WithDeleted } from 'rxdb/plugins/core'
import type { Json, MasterState, SyncedDoc, WasSyncPort } from './types.js'
import { WasSyncConflictError } from './types.js'

/**
 * Formats a master revision (`version` or `metaVersion`) as the quoted strong
 * ETag the server compares `If-Match` against (revision `3` becomes `"3"`).
 *
 * @param revision {number}
 * @returns {string}
 */
export function formatEtag(revision: number): string {
  return `"${revision}"`
}

/**
 * Structural equality over two opaque bodies, by canonical-free JSON string.
 * Used only to decide whether the content or the metadata half changed and thus
 * which endpoint(s) to write. Content-addressed collections never mutate `data`
 * for a given id (so the content half only fires on create/delete), and a real
 * metadata edit re-encrypts to fresh bytes, so this coarse comparison is
 * sufficient for routing.
 *
 * @param left {Json | undefined}
 * @param right {Json | undefined}
 * @returns {boolean}
 */
function bodiesEqual(left: Json | undefined, right: Json | undefined): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
}

/**
 * Builds the RxDB conflict entry (the real current master state) for a row whose
 * conditional write was rejected with `412`. Re-reads the resource; when it is
 * genuinely absent (a delete/delete race) the master is a tombstone synthesized
 * from what we know locally.
 *
 * @param options {object}
 * @param options.port {WasSyncPort}
 * @param options.id {string}
 * @param options.fallbackUpdatedAt {string}   used if the resource is now absent
 * @param options.fallbackVersion {number}     used if the resource is now absent
 * @returns {Promise<WithDeleted<SyncedDoc>>}
 */
async function assembleConflict({
  port,
  id,
  fallbackUpdatedAt,
  fallbackVersion
}: {
  port: WasSyncPort
  id: string
  fallbackUpdatedAt: string
  fallbackVersion: number
}): Promise<WithDeleted<SyncedDoc>> {
  const master: MasterState | null = await port.get({ id })
  if (master === null) {
    return {
      id,
      updatedAt: fallbackUpdatedAt,
      version: fallbackVersion,
      _deleted: true
    }
  }
  const conflict: WithDeleted<SyncedDoc> = {
    id,
    updatedAt: master.updatedAt,
    version: master.version,
    _deleted: master.deleted
  }
  if (master.data !== undefined) {
    conflict.data = master.data
  }
  if (master.metaVersion !== undefined) {
    conflict.metaVersion = master.metaVersion
  }
  if (master.custom !== undefined) {
    conflict.custom = master.custom
  }
  return conflict
}

/**
 * Sends one local change to the remote Collection as up to two conditional
 * writes (content, then metadata). Returns the master-state conflict entry on a
 * `412` at either step, or `null` on success.
 *
 * @param options {object}
 * @param options.port {WasSyncPort}
 * @param options.newDocumentState {WithDeleted<SyncedDoc>}
 * @param [options.assumedMasterState] {WithDeleted<SyncedDoc>}
 * @returns {Promise<WithDeleted<SyncedDoc> | null>}
 */
async function pushRow({
  port,
  newDocumentState,
  assumedMasterState
}: {
  port: WasSyncPort
  newDocumentState: WithDeleted<SyncedDoc>
  assumedMasterState?: WithDeleted<SyncedDoc>
}): Promise<WithDeleted<SyncedDoc> | null> {
  const { id } = newDocumentState
  const assumedVersion = assumedMasterState?.version
  const isCreate = assumedMasterState === undefined
  try {
    if (newDocumentState._deleted) {
      // Delete supersedes any metadata write: drop the content, tombstone wins.
      await port.deleteContent({
        id,
        ...(assumedVersion !== undefined && {
          ifMatch: formatEtag(assumedVersion)
        })
      })
      return null
    }

    // Content half: write on create, or when the content body changed. For a
    // content-addressed collection the update case never fires (an immutable
    // body for a stable id), but it is handled for generality.
    const contentChanged =
      isCreate || !bodiesEqual(newDocumentState.data, assumedMasterState?.data)
    if (contentChanged) {
      await port.putContent({
        id,
        data: newDocumentState.data ?? null,
        ...(isCreate
          ? { ifNoneMatch: true }
          : assumedVersion !== undefined && {
              ifMatch: formatEtag(assumedVersion)
            })
      })
    }

    // Metadata half: write when the resource has metadata and it changed. On a
    // create this runs after the content write (the resource must exist first).
    const metadataChanged = !bodiesEqual(
      newDocumentState.custom,
      assumedMasterState?.custom
    )
    if (newDocumentState.custom !== undefined && metadataChanged) {
      const assumedMetaVersion = assumedMasterState?.metaVersion
      await port.putMeta({
        id,
        custom: newDocumentState.custom,
        ...(assumedMetaVersion !== undefined
          ? { ifMatch: formatEtag(assumedMetaVersion) }
          : { ifNoneMatch: true })
      })
    }

    return null
  } catch (err) {
    if (err instanceof WasSyncConflictError) {
      return assembleConflict({
        port,
        id,
        fallbackUpdatedAt: newDocumentState.updatedAt,
        fallbackVersion: assumedVersion ?? newDocumentState.version
      })
    }
    // Any non-conflict error (network, 5xx, auth) propagates so RxDB retries
    // the whole batch with backoff.
    throw err
  }
}

/**
 * Builds the RxDB push handler that fans a batch of local changes out to
 * conditional WAS writes and returns the conflicting rows' master states.
 *
 * Rows are pushed concurrently; if any non-conflict error is thrown the whole
 * batch rejects (RxDB re-sends it later), matching RxDB's all-or-nothing retry.
 *
 * @param port {WasSyncPort}
 * @returns {(rows: Array<{ newDocumentState: WithDeleted<SyncedDoc>,
 *   assumedMasterState?: WithDeleted<SyncedDoc> }>) =>
 *   Promise<WithDeleted<SyncedDoc>[]>}
 */
export function createPushHandler(port: WasSyncPort) {
  return async function push(
    rows: Array<{
      newDocumentState: WithDeleted<SyncedDoc>
      assumedMasterState?: WithDeleted<SyncedDoc>
    }>
  ): Promise<WithDeleted<SyncedDoc>[]> {
    const results = await Promise.all(
      rows.map(row =>
        pushRow({
          port,
          newDocumentState: row.newDocumentState,
          assumedMasterState: row.assumedMasterState
        })
      )
    )
    return results.filter(
      (conflict): conflict is WithDeleted<SyncedDoc> => conflict !== null
    )
  }
}
