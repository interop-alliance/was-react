/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The app-side seam between the generic sync adapter and `@interop/was-client`.
 * Implements the `WasSyncBasePort` interface (query + conditional writes) for one
 * remote WAS Collection using the raw, signed `was.request()` escape hatch. The
 * 412 conflict re-read (`get`) is supplied separately by `withFeedMasterRead`,
 * which resolves the master state from the changes-feed body -- origin-
 * independent, unlike a cross-origin `GET` ETag header.
 *
 * Using `request()` (rather than the `Resource` / `Collection` handles) is
 * deliberate: it moves the stored body VERBATIM, bypassing the encryption codec.
 * The `changes` feed already ships opaque stored bodies (plaintext for a
 * plaintext collection, the EDV envelope for an encrypted one), and the push
 * side must write those same bytes back unchanged -- running them through
 * `resource.put()` would re-encrypt an already-encrypted envelope. Encrypt /
 * decrypt stays a read/write-time concern above this layer; this port is
 * collection-agnostic and never touches keys.
 *
 * Conditional writes ride the server's monotonic `version` (content) and
 * `metaVersion` (metadata) ETags, which the reference server enforces uniformly
 * for plaintext and encrypted resources alike -- so there is no plaintext-vs-
 * encrypted fork here.
 */
import { readEtag, writeHeaders, type WasClient } from '@interop/was-client'
import { errorStatus, parseEtag } from '@interop/was-client/sync'
import type { IZcap } from '@interop/data-integrity-core'
import { collectionPath } from '../grants.js'
import {
  WasSyncAuthError,
  WasSyncConflictError,
  type SyncCheckpoint,
  type WasSyncBasePort,
  type WireDoc
} from './types.js'

/**
 * Normalizes an unknown caught error into a display string: the `Error`'s
 * `message` when it is one, else its `String(...)` coercion. Shared by the
 * remote store's descriptor PUT and the session activation error path.
 *
 * @param err {unknown}
 * @returns {string}
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Maps a raw `was.request()` rejection to the sync layer's typed errors: `412`
 * to {@link WasSyncConflictError} (a lost-update conflict) and `401` / `403` /
 * `404` to {@link WasSyncAuthError} (expired/revoked storage access). Every
 * other error is returned unchanged so RxDB's retry/backoff handles it. Returns
 * the error to throw (the caller re-throws) rather than throwing itself.
 *
 * `404` counts as access denied because a WAS server masks a failed capability
 * invocation as `404` ("URL not found or invalid authorization") rather than
 * `403`, so an unauthorized caller cannot probe which resources exist. On the
 * sync paths the invoked space and collection are known to exist (the session
 * synced them), so a `404` means the invocation itself was rejected -- the
 * revoked/expired-grant signal. The one route where `404` is routine --
 * deleting an already-absent resource -- inspects the preserved `status` on the
 * mapped error and stays a success (see `deleteContent`).
 *
 * @param err {unknown}
 * @returns {unknown}
 */
function toPortError(err: unknown): unknown {
  const status = errorStatus(err)
  if (status === 412) {
    return new WasSyncConflictError()
  }
  if (status === 401 || status === 403 || status === 404) {
    return new WasSyncAuthError(status)
  }
  return err
}

/**
 * Builds a `WasSyncPort` bound to a single Space + Collection on the remote WAS
 * server, backed by the session's signed `WasClient`.
 *
 * @param options {object}
 * @param options.was {WasClient}       the session client (holds the signer)
 * @param options.spaceId {string}
 * @param options.collectionId {string}   the WAS collection id (e.g. `public-credentials`)
 * @param [options.capability] {IZcap}   the delegated session capability for
 *   this collection (a restored `delegated` tier session); absent in the full
 *   tier, where requests invoke root capabilities
 * @returns {WasSyncBasePort}
 */
export function createWasSyncPort({
  was,
  spaceId,
  collectionId,
  capability
}: {
  was: WasClient
  spaceId: string
  collectionId: string
  capability?: IZcap
}): WasSyncBasePort {
  const basePath = collectionPath({ spaceId, collectionId })
  const resourcePath = (id: string) => `${basePath}/${encodeURIComponent(id)}`

  /**
   * Runs a conditional write, mapping the server's `412 precondition-failed`
   * into the core's `WasSyncConflictError` and a `401` / `403` into
   * `WasSyncAuthError` (see {@link toPortError}), and letting all else propagate.
   * Returns the accepted write's new revision parsed from the response ETag
   * (`version` for content writes, `metaVersion` for `/meta` writes), or
   * `undefined` when the response carries no ETag.
   */
  const conditionalWrite = async (
    // Typed off readEtag's parameter (was-client's HttpResponse) so the type
    // needn't be imported from @interop/http-client, which is not a direct
    // dependency here.
    run: () => Promise<Parameters<typeof readEtag>[0]>
  ): Promise<number | undefined> => {
    try {
      const response = await run()
      // `readEtag` reports an absent header as `undefined`; `parseEtag` reads
      // the `null` spelling of the same thing.
      return parseEtag(readEtag(response) ?? null)
    } catch (err) {
      throw toPortError(err)
    }
  }

  return {
    async query({ checkpoint, limit }) {
      try {
        const response = await was.request({
          capability,
          path: `${basePath}/query`,
          method: 'POST',
          json: {
            profile: 'changes',
            ...(checkpoint !== undefined && { checkpoint }),
            limit
          }
        })
        return response.data as {
          documents: WireDoc[]
          checkpoint: SyncCheckpoint | null
        }
      } catch (err) {
        // Map a pull-path auth rejection (401/403, or the masked 404) to
        // WasSyncAuthError too, so expired/revoked access is recognised
        // whether it surfaces on the pull or the push side.
        throw toPortError(err)
      }
    },

    async putContent({ id, data, ifMatch, ifNoneMatch, epoch }) {
      return conditionalWrite(() =>
        was.request({
          capability,
          path: resourcePath(id),
          method: 'PUT',
          json: data as object,
          // `epoch` rides as the `WAS-Key-Epoch` header so the server's stamp
          // stays in step with the envelope (an absent epoch clears any prior
          // stamp, per the `key-epochs` feature).
          headers: writeHeaders({
            precondition: { ifMatch, ifNoneMatch },
            epoch
          })
        })
      )
    },

    async deleteContent({ id, ifMatch }) {
      try {
        return await conditionalWrite(() =>
          was.request({
            capability,
            path: resourcePath(id),
            method: 'DELETE',
            headers: writeHeaders({ precondition: { ifMatch } })
          })
        )
      } catch (err) {
        // A 404 means the resource is already absent -- the row was created
        // and deleted locally before ever being pushed, or another device
        // deleted it first. Either way the tombstone's goal state holds, so
        // report success (no acked revision) instead of rejecting the batch,
        // which RxDB would otherwise retry forever. (A masked auth-failure 404
        // is swallowed here too -- indistinguishable by design -- but revoked
        // access still surfaces within one pull-poll interval, where 404 maps
        // to WasSyncAuthError.) The mapped error keeps the raw `status`, so
        // this check works on the WasSyncAuthError conditionalWrite now throws
        // for a 404.
        if (errorStatus(err) === 404) {
          return undefined
        }
        throw err
      }
    },

    async putMeta({ id, custom, ifMatch, ifNoneMatch }) {
      return conditionalWrite(() =>
        was.request({
          capability,
          path: `${resourcePath(id)}/meta`,
          method: 'PUT',
          // The `/meta` PUT is a full replacement of `custom`: a body with no
          // `custom` member writes the CLEARED state (the server clears every
          // property the body omits), which is how a metadata clear replicates.
          json: custom === undefined ? {} : { custom },
          headers: writeHeaders({ precondition: { ifMatch, ifNoneMatch } })
        })
      )
    }
  }
}
