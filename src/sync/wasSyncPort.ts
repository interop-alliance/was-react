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
import type { IZcap } from '@interop/data-integrity-core'
import {
  WasSyncAuthError,
  WasSyncConflictError,
  type SyncCheckpoint,
  type WasSyncBasePort,
  type WireDoc
} from './types.js'

/**
 * Extracts an HTTP status from a raw ky/ezcap error. `was.request()` rejects on
 * any non-2xx with `err.status` set (see `@interop/http-client`'s error
 * normaliser); this reads it defensively from either location. Shared with the
 * remote store's marker PUT and the dev-grant provisioner, which need the raw
 * status for diagnostics rather than the mapped sync error.
 *
 * @param err {unknown}
 * @returns {number | undefined}
 */
export function errorStatus(err: unknown): number | undefined {
  return (
    (err as { status?: number }).status ??
    (err as { response?: { status?: number } }).response?.status
  )
}

/**
 * Normalizes an unknown caught error into a display string: the `Error`'s
 * `message` when it is one, else its `String(...)` coercion. Shared by the
 * remote store's marker PUT and the session activation error path.
 *
 * @param err {unknown}
 * @returns {string}
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Maps a raw `was.request()` rejection to the sync layer's typed errors: `412`
 * to {@link WasSyncConflictError} (a lost-update conflict) and `401` / `403` to
 * {@link WasSyncAuthError} (expired/revoked storage access). Every other error
 * is returned unchanged so RxDB's retry/backoff handles it. Returns the error to
 * throw (the caller re-throws) rather than throwing itself.
 *
 * @param err {unknown}
 * @returns {unknown}
 */
function toPortError(err: unknown): unknown {
  const status = errorStatus(err)
  if (status === 412) {
    return new WasSyncConflictError()
  }
  if (status === 401 || status === 403) {
    return new WasSyncAuthError(status)
  }
  return err
}

/**
 * Parses a quoted strong ETag (`"3"`, as read by `readEtag`) into its numeric
 * revision, or `undefined` when the header was absent (the resource has no such
 * revision yet).
 *
 * @param etag {string | undefined}
 * @returns {number | undefined}
 */
function parseEtag(etag: string | undefined): number | undefined {
  if (etag === undefined) {
    return undefined
  }
  const revision = Number(etag.replace(/"/g, ''))
  return Number.isFinite(revision) ? revision : undefined
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
  const collectionPath = `/space/${spaceId}/${collectionId}`
  const resourcePath = (id: string) =>
    `${collectionPath}/${encodeURIComponent(id)}`

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
      return parseEtag(readEtag(response))
    } catch (err) {
      throw toPortError(err)
    }
  }

  return {
    async query({ checkpoint, limit }) {
      try {
        const response = await was.request({
          capability,
          path: `${collectionPath}/query`,
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
        // Map a pull-path 401/403 to WasSyncAuthError too, so expired access is
        // recognised whether it surfaces on the pull or the push side.
        throw toPortError(err)
      }
    },

    async putContent({ id, data, ifMatch, ifNoneMatch }) {
      return conditionalWrite(() =>
        was.request({
          capability,
          path: resourcePath(id),
          method: 'PUT',
          json: data as object,
          headers: writeHeaders({ precondition: { ifMatch, ifNoneMatch } })
        })
      )
    },

    async deleteContent({ id, ifMatch }) {
      return conditionalWrite(() =>
        was.request({
          capability,
          path: resourcePath(id),
          method: 'DELETE',
          headers: writeHeaders({ precondition: { ifMatch } })
        })
      )
    },

    async putMeta({ id, custom, ifMatch, ifNoneMatch }) {
      return conditionalWrite(() =>
        was.request({
          capability,
          path: `${resourcePath(id)}/meta`,
          method: 'PUT',
          json: { custom },
          headers: writeHeaders({ precondition: { ifMatch, ifNoneMatch } })
        })
      )
    }
  }
}
