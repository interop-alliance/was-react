/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The app-side seam between the generic sync adapter and `@interop/was-client`.
 * Implements the `WasSyncPort` interface for one remote WAS Collection using the
 * raw, signed `was.request()` escape hatch.
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
import type { WasClient } from '@interop/was-client'
import type { IZcap } from '@interop/data-integrity-core'
import {
  WasSyncConflictError,
  type Json,
  type MasterState,
  type SyncCheckpoint,
  type WasSyncPort,
  type WireDoc
} from './types.js'

/**
 * Extracts an HTTP status from a raw ky/ezcap error. `was.request()` rejects on
 * any non-2xx with `err.status` set (see `@interop/http-client`'s error
 * normaliser); this reads it defensively from either location.
 *
 * @param err {unknown}
 * @returns {number | undefined}
 */
function errorStatus(err: unknown): number | undefined {
  return (
    (err as { status?: number }).status ??
    (err as { response?: { status?: number } }).response?.status
  )
}

/**
 * Parses a quoted strong ETag (`"3"`) into its numeric revision, or `undefined`
 * when the header is absent (the resource has no such revision yet).
 *
 * @param etag {string | null}
 * @returns {number | undefined}
 */
function parseEtag(etag: string | null): number | undefined {
  if (!etag) {
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
 * @returns {WasSyncPort}
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
}): WasSyncPort {
  const collectionPath = `/space/${spaceId}/${collectionId}`
  const resourcePath = (id: string) =>
    `${collectionPath}/${encodeURIComponent(id)}`

  /**
   * Builds the conditional-write headers from the port's precondition options.
   */
  const writeHeaders = ({
    ifMatch,
    ifNoneMatch
  }: {
    ifMatch?: string
    ifNoneMatch?: boolean
  }): Record<string, string> | undefined => {
    const headers: Record<string, string> = {}
    if (ifMatch !== undefined) {
      headers['if-match'] = ifMatch
    }
    if (ifNoneMatch) {
      headers['if-none-match'] = '*'
    }
    return Object.keys(headers).length > 0 ? headers : undefined
  }

  /**
   * Runs a conditional write, mapping the server's `412 precondition-failed`
   * into the core's `WasSyncConflictError` and letting all else propagate.
   * Returns the accepted write's new revision parsed from the response ETag
   * (`version` for content writes, `metaVersion` for `/meta` writes), or
   * `undefined` when the response carries no ETag.
   */
  const conditionalWrite = async (
    run: () => Promise<{ headers: { get(name: string): string | null } }>
  ): Promise<number | undefined> => {
    try {
      const response = await run()
      return parseEtag(response.headers.get('etag'))
    } catch (err) {
      if (errorStatus(err) === 412) {
        throw new WasSyncConflictError()
      }
      throw err
    }
  }

  return {
    async query({ checkpoint, limit }) {
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
    },

    async putContent({ id, data, ifMatch, ifNoneMatch }) {
      return conditionalWrite(() =>
        was.request({
          capability,
          path: resourcePath(id),
          method: 'PUT',
          json: data as object,
          headers: writeHeaders({ ifMatch, ifNoneMatch })
        })
      )
    },

    async deleteContent({ id, ifMatch }) {
      return conditionalWrite(() =>
        was.request({
          capability,
          path: resourcePath(id),
          method: 'DELETE',
          headers: writeHeaders({ ifMatch })
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
          headers: writeHeaders({ ifMatch, ifNoneMatch })
        })
      )
    },

    async get({ id }): Promise<MasterState | null> {
      // Content re-read: raw GET returns the stored body verbatim (no decrypt)
      // and the content `version` in the ETag. A 404 means the resource is gone
      // (or tombstoned) -- report absent so the core synthesizes a tombstone.
      let contentResponse
      try {
        contentResponse = await was.request({
          capability,
          path: resourcePath(id),
          method: 'GET'
        })
      } catch (err) {
        if (errorStatus(err) === 404) {
          return null
        }
        throw err
      }

      const master: MasterState = {
        version: parseEtag(contentResponse.headers.get('etag')) ?? 0,
        // Filled from the `/meta` body's server-managed `updatedAt` below; the
        // change feed remains the authority on ordering, so this only feeds the
        // one-off conflict entry and is corrected on the next pull.
        updatedAt: '',
        deleted: false,
        data: contentResponse.data as Json
      }

      // Metadata re-read: the `/meta` body carries the server-managed
      // `updatedAt` plus the user-writable `custom` (opaque), and its own
      // `metaVersion` ETag (absent until metadata has been written).
      try {
        const metaResponse = await was.request({
          capability,
          path: `${resourcePath(id)}/meta`,
          method: 'GET'
        })
        const metaBody = metaResponse.data as
          { updatedAt?: string; custom?: Json } | undefined
        if (metaBody?.updatedAt) {
          master.updatedAt = metaBody.updatedAt
        }
        const metaVersion = parseEtag(metaResponse.headers.get('etag'))
        if (metaVersion !== undefined) {
          master.metaVersion = metaVersion
        }
        if (metaBody?.custom !== undefined) {
          master.custom = metaBody.custom
        }
      } catch (err) {
        // Metadata is optional; only a hard error (not 404) should propagate.
        if (errorStatus(err) !== 404) {
          throw err
        }
      }

      return master
    }
  }
}
