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
 *   just the same.
 */
import type { ZcapClient } from '@interop/ezcap'
import type { IZcap } from '@interop/data-integrity-core'
import { WasClient } from '@interop/was-client'
import { createEdvEncryption } from '@interop/was-client/edv'
import { errorStatus, errorMessage } from '../sync/index.js'
import type { ParsedGrants } from '../grants.js'

/**
 * The outcome of a best-effort encryption-marker PUT, for diagnostics.
 */
export interface MarkerResult {
  collectionId: string
  ok: boolean
  status?: number
  error?: string
}

export class WasRemoteStore {
  public readonly was: WasClient
  public readonly serverUrl: string
  public readonly spaceId: string
  private readonly _byCollectionId: Record<string, IZcap>

  private constructor({
    was,
    parsed
  }: {
    was: WasClient
    parsed: ParsedGrants
  }) {
    this.was = was
    this.serverUrl = parsed.serverUrl
    this.spaceId = parsed.spaceId
    this._byCollectionId = parsed.byCollectionId
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
   * @returns {WasRemoteStore}
   */
  static fromGrants({
    parsed,
    zcapClient
  }: {
    parsed: ParsedGrants
    zcapClient: ZcapClient
  }): WasRemoteStore {
    const was = new WasClient({
      serverUrl: parsed.serverUrl,
      zcapClient,
      encryption: createEdvEncryption({ resolveKeys: async () => null })
    })
    return new WasRemoteStore({ was, parsed })
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
    return this._byCollectionId[collectionId]
  }

  /**
   * Best-effort declaration of the `{ encryption: { scheme: 'edv' } }` marker on
   * one collection, invoked with that collection's delegated RW zcap. Non-fatal:
   * returns the outcome rather than throwing, so a server that does not authorize
   * a delegated description write leaves replication untouched (the collection
   * simply stays unmarked / plaintext, which still stores envelopes).
   *
   * @param collectionId {string}   the WAS collection id
   * @returns {Promise<MarkerResult>}
   */
  async markCollectionEncrypted(collectionId: string): Promise<MarkerResult> {
    const capability = this.collectionCapability(collectionId)
    if (!capability) {
      return { collectionId, ok: false, error: 'no capability' }
    }
    try {
      const response = await this.was.request({
        capability,
        path: `/space/${this.spaceId}/${collectionId}`,
        method: 'PUT',
        json: { id: collectionId, encryption: { scheme: 'edv' } }
      })
      return { collectionId, ok: true, status: response.status }
    } catch (err) {
      const status = errorStatus(err)
      const message = errorMessage(err)
      return { collectionId, ok: false, status, error: message }
    }
  }
}
