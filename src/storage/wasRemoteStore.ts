/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * WasRemoteStore (delegated-only): the relying-party view of the user's WAS
 * Space, stripped to the RP model -- this app NEVER provisions the Space, never
 * derives the spaceId, and never touches the `id` collection or DID publishing.
 * It receives a set of wallet-delegated zcaps, reads the server URL + space id
 * straight out of their `invocationTarget`s ({@link parseGrants}), and holds:
 *
 * - a `WasClient` wrapping the app's own `ZcapClient` (its invocation signer is
 *   the seed-derived controller the grants were delegated to);
 * - per-collection capability routing, so each sync request invokes the exact
 *   collection grant;
 * - a best-effort encryption-marker PUT (whether a delegated collection-scoped
 *   RW zcap authorizes writing the collection description). It is non-fatal
 *   either way -- envelopes replicate into an unmarked (plaintext) collection
 *   just the same. A PUBLIC collection is never marked: public implies
 *   plaintext, so the marker PUT is skipped outright;
 * - the sibling best-effort `indexes` declaration PUT for public collections
 *   that declare equality-indexed attributes, plus the equality query verb
 *   itself ({@link WasRemoteStore.queryCollectionByEquality}): the canonical
 *   sorted `filter[attr]=value` GET on the collection list endpoint, parsed
 *   into the `{ documents, hasMore, cursor? }` page shape.
 */
import type { ZcapClient } from '@interop/ezcap'
import type { IZcap } from '@interop/data-integrity-core'
import { WasClient } from '@interop/was-client'
import { createEdvEncryption } from '@interop/was-client/edv'
import { errorStatus, errorMessage } from '../sync/index.js'
import type { WasCollectionConfig } from '../config.js'
import type { ParsedGrants } from '../grants.js'

/**
 * The outcome of a best-effort encryption-marker PUT, for diagnostics.
 */
export interface MarkerResult {
  collectionId: string
  ok: boolean
  status?: number
  error?: string
  /**
   * True when no PUT was attempted because the collection is public
   * (plaintext); reported as `ok` since the goal state -- no marker -- holds.
   */
  skipped?: boolean
}

/**
 * One page of equality-query results: the shared shape of the GET
 * `filter[attr]=value` filter and the POST `equality` query profile. `data` is
 * the stored JSON content (absent for a blob resource); `custom` is the
 * resource's custom metadata object, present when it has one. The opaque
 * `cursor` continues the page walk when `hasMore` is true.
 */
export interface EqualityQueryPage {
  documents: Array<{ id: string; data?: unknown; custom?: unknown }>
  hasMore: boolean
  cursor?: string
}

export class WasRemoteStore {
  public readonly was: WasClient
  public readonly serverUrl: string
  public readonly spaceId: string
  readonly #byCollectionId: Record<string, IZcap>
  // Per WAS collection id: the effective visibility + declared equality
  // indexes (the registry guarantees one declaration per id).
  readonly #configById: Map<
    string,
    { visibility: 'private' | 'public'; indexes?: string[] }
  >

  private constructor({
    was,
    parsed,
    configById
  }: {
    was: WasClient
    parsed: ParsedGrants
    configById: Map<
      string,
      { visibility: 'private' | 'public'; indexes?: string[] }
    >
  }) {
    this.was = was
    this.serverUrl = parsed.serverUrl
    this.spaceId = parsed.spaceId
    this.#byCollectionId = parsed.byCollectionId
    this.#configById = configById
  }

  /**
   * Builds a delegated remote store from a parsed grant set and the app's
   * ZcapClient (whose invocation signer is the controller the grants target).
   * The EDV encryption provider is a no-op keystore: replication moves opaque
   * envelopes verbatim, and encrypt/decrypt is a local read/write concern.
   *
   * @param options {object}
   * @param options.parsed {ParsedGrants}
   * @param options.zcapClient {ZcapClient}
   * @param [options.collections] {WasCollectionConfig[]}   the collection
   *   registry; entries with `visibility: 'public'` are never marked encrypted
   * @returns {WasRemoteStore}
   */
  static fromGrants({
    parsed,
    zcapClient,
    collections = []
  }: {
    parsed: ParsedGrants
    zcapClient: ZcapClient
    collections?: WasCollectionConfig[]
  }): WasRemoteStore {
    const was = new WasClient({
      serverUrl: parsed.serverUrl,
      zcapClient,
      encryption: createEdvEncryption({ resolveKeys: async () => null })
    })
    const configById = new Map<
      string,
      { visibility: 'private' | 'public'; indexes?: string[] }
    >(
      collections.map(entry => [
        entry.id,
        {
          visibility: entry.visibility ?? 'private',
          ...(entry.indexes && { indexes: entry.indexes })
        }
      ])
    )
    return new WasRemoteStore({ was, parsed, configById })
  }

  /**
   * The delegated capability for one WAS collection, or `undefined` when no
   * grant covers it (the sync port then invokes without a capability and the
   * server denies it -- the intended fail-closed mode).
   *
   * @param collectionId {string}   the WAS collection id
   * @returns {IZcap | undefined}
   */
  collectionCapability(collectionId: string): IZcap | undefined {
    return this.#byCollectionId[collectionId]
  }

  /**
   * Best-effort declaration of the `{ encryption: { scheme: 'edv' } }` marker on
   * one collection, invoked with that collection's delegated RW zcap. Non-fatal:
   * returns the outcome rather than throwing, so a server that does not authorize
   * a delegated description write leaves replication untouched (the collection
   * simply stays unmarked / plaintext, which still stores envelopes). A PUBLIC
   * collection is never marked (public implies plaintext): the PUT is skipped
   * and reported as `ok` + `skipped`.
   *
   * @param collectionId {string}   the WAS collection id
   * @returns {Promise<MarkerResult>}
   */
  async markCollectionEncrypted(collectionId: string): Promise<MarkerResult> {
    if (this.#configById.get(collectionId)?.visibility === 'public') {
      return { collectionId, ok: true, skipped: true }
    }
    return this.#putDescription({
      collectionId,
      description: { id: collectionId, encryption: { scheme: 'edv' } }
    })
  }

  /**
   * Best-effort declaration of a public collection's equality-indexed
   * attributes (`{ indexes: [...] }`) on its collection description, invoked
   * with that collection's delegated RW zcap. The server rejects
   * `filter[attr]=value` queries on undeclared attributes fail-closed, so a
   * public collection that wants `store.query()` must announce its `indexes`
   * here. Non-fatal like the encryption marker: returns the outcome rather
   * than throwing. Skipped (reported `ok` + `skipped`) for a private
   * collection or one that declares no indexes.
   *
   * @param collectionId {string}   the WAS collection id
   * @returns {Promise<MarkerResult>}
   */
  async declareCollectionIndexes(collectionId: string): Promise<MarkerResult> {
    const config = this.#configById.get(collectionId)
    if (
      config?.visibility !== 'public' ||
      !config.indexes ||
      config.indexes.length === 0
    ) {
      return { collectionId, ok: true, skipped: true }
    }
    return this.#putDescription({
      collectionId,
      description: { id: collectionId, indexes: config.indexes }
    })
  }

  /**
   * Runs one equality query against a public collection: the canonical GET
   * `filter[attr]=value` form of the server's `equality` profile, invoked with
   * the collection's delegated zcap (an anonymous reader would issue the same
   * URL unsigned against a `PublicCanRead` collection). Filter attributes are
   * emitted in sorted order so identical queries produce identical URLs
   * (cache-friendly); values are string equality only. Fails closed before any
   * network round trip on a non-public collection (the encrypted
   * `blinded-index` path is not yet supported), an empty term set, or an
   * attribute missing from the collection's declared `indexes`.
   *
   * @param options {object}
   * @param options.collectionId {string}   the WAS collection id
   * @param options.equals {Record<string, string>}   equality terms; multiple
   *   attributes AND together
   * @param [options.limit] {number}   page size (server default when omitted)
   * @param [options.cursor] {string}   opaque continuation cursor from the
   *   prior page
   * @returns {Promise<EqualityQueryPage>}
   */
  async queryCollectionByEquality({
    collectionId,
    equals,
    limit,
    cursor
  }: {
    collectionId: string
    equals: Record<string, string>
    limit?: number
    cursor?: string
  }): Promise<EqualityQueryPage> {
    const config = this.#configById.get(collectionId)
    if (config?.visibility !== 'public') {
      throw new Error(
        `Equality queries require a public (plaintext) collection; ` +
          `"${collectionId}" is not registered as public (the encrypted ` +
          `blinded-index query path is not yet supported).`
      )
    }
    const attributes = Object.keys(equals)
    if (attributes.length === 0) {
      throw new Error('An equality query needs at least one term.')
    }
    const declared = new Set(config.indexes ?? [])
    for (const name of attributes) {
      if (!declared.has(name)) {
        throw new Error(
          `Attribute "${name}" is not declared in collection ` +
            `"${collectionId}" indexes; declare it in the collection config.`
        )
      }
    }
    const capability = this.collectionCapability(collectionId)
    if (!capability) {
      throw new Error(
        `No delegated capability covers collection "${collectionId}".`
      )
    }
    // Canonical query string: sorted filter attributes first, then the
    // reserved pagination params. Literal brackets around a percent-encoded
    // attribute name; the server decodes either spelling identically.
    const params = attributes
      .sort()
      .map(
        name =>
          `filter[${encodeURIComponent(name)}]=` +
          encodeURIComponent(equals[name] as string)
      )
    if (limit !== undefined) {
      params.push(`limit=${encodeURIComponent(String(limit))}`)
    }
    if (cursor !== undefined) {
      params.push(`cursor=${encodeURIComponent(cursor)}`)
    }
    // The list endpoint is the trailing-slash collection items URL.
    const response = await this.was.request({
      capability,
      path: `/space/${this.spaceId}/${collectionId}/?${params.join('&')}`,
      method: 'GET'
    })
    const page = response.data as Partial<EqualityQueryPage> | undefined
    if (!page || !Array.isArray(page.documents)) {
      throw new Error(
        `Malformed equality query response for "${collectionId}": expected a ` +
          `{ documents, hasMore } page.`
      )
    }
    return {
      documents: page.documents,
      hasMore: page.hasMore === true,
      ...(typeof page.cursor === 'string' && { cursor: page.cursor })
    }
  }

  /**
   * The world-readable share URL for one document in a public (plaintext)
   * collection: the exact URL an unauthenticated reader fetches (e.g. via
   * `WasClient.publicRead`) to consume a share link. Because a public
   * collection stores the payload under its own logical `id`, this URL is
   * stable across edits of the document. Fails closed before composing
   * anything on a non-public collection (the encrypted path stores under a
   * random envelope id, so no stable public URL exists), an empty id, or a
   * collection no delegated capability covers (catching typo'd or
   * unprovisioned collection ids). The URL resolves publicly only once the
   * document has replicated to the server -- a locally-inserted doc shares
   * after the next sync push.
   *
   * @param options {object}
   * @param options.collectionId {string}   the WAS collection id
   * @param options.id {string}   the document's logical uuid
   * @returns {string}
   */
  publicUrlFor({
    collectionId,
    id
  }: {
    collectionId: string
    id: string
  }): string {
    const config = this.#configById.get(collectionId)
    if (config?.visibility !== 'public') {
      throw new Error(
        `Public share URLs require a public (plaintext) collection; ` +
          `"${collectionId}" is not registered as public (a private ` +
          `collection stores documents under a random envelope id, so no ` +
          `stable public URL exists).`
      )
    }
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('A public share URL needs a non-empty document id.')
    }
    const capability = this.collectionCapability(collectionId)
    if (!capability) {
      throw new Error(
        `No delegated capability covers collection "${collectionId}".`
      )
    }
    return (
      `${this.serverUrl}/space/${this.spaceId}/${collectionId}/` +
      `${encodeURIComponent(id)}`
    )
  }

  /**
   * The shared best-effort collection-description PUT behind the encryption
   * marker and the indexes declaration: invokes the collection's delegated RW
   * zcap and reports the outcome rather than throwing.
   */
  async #putDescription({
    collectionId,
    description
  }: {
    collectionId: string
    description: Record<string, unknown>
  }): Promise<MarkerResult> {
    const capability = this.collectionCapability(collectionId)
    if (!capability) {
      return { collectionId, ok: false, error: 'no capability' }
    }
    try {
      const response = await this.was.request({
        capability,
        path: `/space/${this.spaceId}/${collectionId}`,
        method: 'PUT',
        json: description
      })
      return { collectionId, ok: true, status: response.status }
    } catch (err) {
      const status = errorStatus(err)
      const message = errorMessage(err)
      return { collectionId, ok: false, status, error: message }
    }
  }
}
