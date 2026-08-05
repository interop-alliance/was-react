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
 *   `If-None-Match: *` when the resource has no metadata yet); a metadata
 *   CLEAR (the new state carries no `custom`) writes the cleared state rather
 *   than being skipped.
 *
 * Content is written before metadata on a create, because the server rejects a
 * `/meta` write to a resource that does not yet exist.
 *
 * RxDB's push contract asks only for *conflicts* back (the current master state
 * of each rejected row), so a successful write's new `version` / `metaVersion`
 * is reported out-of-band: the response ETag of each accepted write is captured
 * and handed to the optional `onWriteAccepted` callback, which writes the acked
 * revision back into the local row (see `createWasReplication`). Without that
 * write-back the local `version` would stay one revision behind the server and
 * every subsequent conditional write would send a stale `If-Match` and 412. The
 * write-back only touches the revision fields (never `data` / `updatedAt`), so
 * the follow-up push cycle it triggers finds nothing changed to write and
 * settles -- no re-push loop.
 */
import type { WithDeleted } from 'rxdb/plugins/core'
import type { Json, MasterState, SyncedDoc, WasSyncPort } from './types.js'
import { WasSyncAuthError, WasSyncConflictError } from './types.js'

/**
 * The acked server revisions of one row's accepted writes: the new content
 * `version` (from a `PUT /:id` or `DELETE /:id` response ETag) and/or the new
 * `metaVersion` (from a `PUT /:id/meta` response ETag). Absent fields mean the
 * corresponding write did not run or its response carried no ETag.
 */
export interface PushWriteAck {
  id: string
  version?: number
  metaVersion?: number
}

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
 * Maps a re-read master state into the RxDB conflict entry for one row.
 */
function masterToConflict(
  id: string,
  master: MasterState
): WithDeleted<SyncedDoc> {
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
  if (master.epoch !== undefined) {
    conflict.epoch = master.epoch
  }
  return conflict
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
  return masterToConflict(id, master)
}

/**
 * Sends one local change to the remote Collection as up to two conditional
 * writes (content, then metadata). Returns the master-state conflict entry on a
 * `412` at either step, or the accepted writes' acked revisions on success
 * (`ack: null` when no response carried a revision). A conflict on the
 * metadata half still returns the content half's earned ack alongside the
 * conflict entry, so an accepted content version is never discarded.
 *
 * @param options {object}
 * @param options.port {WasSyncPort}
 * @param options.newDocumentState {WithDeleted<SyncedDoc>}
 * @param [options.assumedMasterState] {WithDeleted<SyncedDoc>}
 * @returns {Promise<{ conflict: WithDeleted<SyncedDoc> | null,
 *   ack: PushWriteAck | null }>}
 */
async function pushRow({
  port,
  newDocumentState,
  assumedMasterState
}: {
  port: WasSyncPort
  newDocumentState: WithDeleted<SyncedDoc>
  assumedMasterState?: WithDeleted<SyncedDoc>
}): Promise<{
  conflict: WithDeleted<SyncedDoc> | null
  ack: PushWriteAck | null
}> {
  const { id } = newDocumentState
  const assumedVersion = assumedMasterState?.version
  const isCreate = assumedMasterState === undefined
  const ack: PushWriteAck = { id }
  const hasAck = () =>
    ack.version !== undefined || ack.metaVersion !== undefined

  // Builds the conflict outcome for a 412 at either half, PRESERVING any ack
  // already earned: a content write accepted before a `/meta` 412 must keep its
  // acked `version` (and feed it to the re-read fallback), or the local row
  // keeps the pre-write version and every later conditional write sends a
  // stale `If-Match`.
  const conflictResult = async () => {
    const conflict = await assembleConflict({
      port,
      id,
      fallbackUpdatedAt: newDocumentState.updatedAt,
      fallbackVersion: ack.version ?? assumedVersion ?? newDocumentState.version
    })
    return { conflict, ack: hasAck() ? ack : null }
  }

  try {
    if (newDocumentState._deleted) {
      // Delete supersedes any metadata write: drop the content, tombstone wins.
      const ackedVersion = await port.deleteContent({
        id,
        ...(assumedVersion !== undefined && {
          ifMatch: formatEtag(assumedVersion)
        })
      })
      if (ackedVersion !== undefined) {
        ack.version = ackedVersion
      }
      return { conflict: null, ack: ack.version !== undefined ? ack : null }
    }

    // Content half: write on create, or when the content body changed. For a
    // content-addressed collection the update case never fires (an immutable
    // body for a stable id), but it is handled for generality.
    const contentChanged =
      isCreate || !bodiesEqual(newDocumentState.data, assumedMasterState?.data)
    if (contentChanged) {
      const ackedVersion = await port.putContent({
        id,
        data: newDocumentState.data ?? null,
        ...(newDocumentState.epoch !== undefined && {
          epoch: newDocumentState.epoch
        }),
        ...(isCreate
          ? { ifNoneMatch: true }
          : assumedVersion !== undefined && {
              ifMatch: formatEtag(assumedVersion)
            })
      })
      if (ackedVersion !== undefined) {
        ack.version = ackedVersion
      }
    }
  } catch (err) {
    if (err instanceof WasSyncConflictError) {
      return await conflictResult()
    }
    // Any non-conflict error (network, 5xx, auth) propagates so RxDB retries
    // the whole batch with backoff.
    throw err
  }

  // Metadata half: write when the metadata changed -- including a CLEAR (the
  // new state carries no `custom` while the assumed master does; `putMeta`
  // with no `custom` writes the cleared state). On a create this runs after
  // the content write (the resource must exist first). Its own try/catch so a
  // rejection here can never discard an ack the content half already earned.
  const metadataChanged = !bodiesEqual(
    newDocumentState.custom,
    assumedMasterState?.custom
  )
  if (metadataChanged) {
    try {
      const assumedMetaVersion = assumedMasterState?.metaVersion
      const ackedMetaVersion = await port.putMeta({
        id,
        ...(newDocumentState.custom !== undefined && {
          custom: newDocumentState.custom
        }),
        ...(assumedMetaVersion !== undefined
          ? { ifMatch: formatEtag(assumedMetaVersion) }
          : { ifNoneMatch: true })
      })
      if (ackedMetaVersion !== undefined) {
        ack.metaVersion = ackedMetaVersion
      }
    } catch (err) {
      if (err instanceof WasSyncConflictError) {
        return await conflictResult()
      }
      // Corroborate before condemnation: under WAS 404-masking a `/meta` 404
      // is ambiguous -- expired access, or an ordinary race with a remote
      // delete (a PUT to the `/meta` of a nonexistent resource legitimately
      // 404s). An independent request decides: re-read the master off the
      // changes feed. A feed read that is itself denied rethrows its own auth
      // error (access genuinely expired, so the controller escalates); a feed
      // that answers with an absent/deleted master confirms the delete race,
      // and the row is resolved with that tombstone as the conflict entry
      // (the conflict handler reconciles it) instead of flipping the whole
      // session to "access expired" and wedging the batch in RxDB's retries.
      if (err instanceof WasSyncAuthError && err.status === 404) {
        const master = await port.get({ id })
        if (master === null || master.deleted) {
          const conflict = master
            ? masterToConflict(id, master)
            : {
                id,
                updatedAt: newDocumentState.updatedAt,
                version:
                  ack.version ?? assumedVersion ?? newDocumentState.version,
                _deleted: true
              }
          return { conflict, ack: hasAck() ? ack : null }
        }
        // The resource is alive and readable while its `/meta` write 404s:
        // the write itself was rejected, so the auth signal stands.
      }
      throw err
    }
  }

  return { conflict: null, ack: hasAck() ? ack : null }
}

/**
 * Builds the RxDB push handler that fans a batch of local changes out to
 * conditional WAS writes and returns the conflicting rows' master states.
 *
 * Rows are pushed concurrently; if any non-conflict error is thrown the whole
 * batch rejects (RxDB re-sends it later), matching RxDB's all-or-nothing retry.
 *
 * Each accepted write's acked server revision(s) are handed to
 * `onWriteAccepted` (when supplied) as soon as that row's writes settle, so the
 * caller can write the new `version` / `metaVersion` back into the local row
 * and keep subsequent conditional writes' `If-Match` in step with the server.
 *
 * @param port {WasSyncPort}
 * @param [onWriteAccepted] {(ack: PushWriteAck) => Promise<void>}
 * @returns {(rows: Array<{ newDocumentState: WithDeleted<SyncedDoc>,
 *   assumedMasterState?: WithDeleted<SyncedDoc> }>) =>
 *   Promise<WithDeleted<SyncedDoc>[]>}
 */
export function createPushHandler(
  port: WasSyncPort,
  onWriteAccepted?: (ack: PushWriteAck) => Promise<void>
) {
  return async function push(
    rows: Array<{
      newDocumentState: WithDeleted<SyncedDoc>
      assumedMasterState?: WithDeleted<SyncedDoc>
    }>
  ): Promise<WithDeleted<SyncedDoc>[]> {
    const results = await Promise.all(
      rows.map(async row => {
        const result = await pushRow({
          port,
          newDocumentState: row.newDocumentState,
          assumedMasterState: row.assumedMasterState
        })
        if (result.ack !== null && onWriteAccepted !== undefined) {
          await onWriteAccepted(result.ack)
        }
        return result
      })
    )
    return results
      .map(result => result.conflict)
      .filter(
        (conflict): conflict is WithDeleted<SyncedDoc> => conflict !== null
      )
  }
}
