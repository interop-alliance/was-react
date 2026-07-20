/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * RP-side VPR construction for Login With Wallet: the one-popup App Connect
 * request.
 *
 * A single CHAPI `get` carries DIDAuthentication plus an `AppConnectQuery` that
 * names the app (for the wallet's consent screen), the seed-credential naming
 * the wallet needs to MATCH an existing app key or MINT a fresh one, and one
 * collection-scoped capabilityQuery per requested collection. The wallet
 * responds -- in the same round -- with the app-key credential and the
 * delegated zcaps embedded in the response VP, so first-run and returning are a
 * single request/response with no store popup and no separate grants popup.
 *
 * Only collection-scoped capabilities are requested (no whole-space grant). A
 * `visibility: 'public'` collection is requested with the distinct descriptor
 * type `urn:was:public-collection` (the wallet provisions it plaintext with a
 * collection-level public-read policy and renders a world-readable consent
 * warning); wallets that predate the type render it UNSATISFIABLE, which is the
 * intended fail-closed behavior -- an older wallet must not silently provision a
 * private collection the app believes is public. The App Connect query as a
 * whole is likewise unsatisfiable on a wallet that predates it, so an old wallet
 * fails closed rather than degrading into a partial generic flow.
 *
 * `domain` must host-match the CHAPI requesting origin or the wallet refuses
 * to sign; `challenge` must be fresh per request (echoed into the DIDAuth
 * proof and checked in verifyResponse).
 */
import type { SeedCredentialConfig } from '../identity/seedCredential.js'
import type {
  IAppConnectCapabilityQuery,
  IVPRDetails
} from './walletRequestTypes.js'

/**
 * Default read/write actions requested on each app collection.
 */
export const RW_ACTIONS = ['GET', 'HEAD', 'PUT', 'POST', 'DELETE']

/**
 * One collection to request a grant for: the WAS collection id plus its
 * declared visibility (`'private'`, the default, or `'public'`).
 */
export interface GrantRequestCollection {
  /**
   * WAS collection id (the unprefixed, cross-app generic name).
   */
  id: string
  /**
   * Who can read the collection; selects the descriptor type
   * (`urn:was:collection` for `'private'`/unset, `urn:was:public-collection`
   * for `'public'`).
   */
  visibility?: 'private' | 'public'
}

/**
 * A fresh nonce for a VPR challenge.
 */
export function newChallenge(): string {
  return crypto.randomUUID()
}

/**
 * The one-popup App Connect VPR: DIDAuthentication + a single `AppConnectQuery`.
 *
 * The `app` block names the app (for the wallet's consent screen) and carries
 * the seed-credential naming (`credentialType`/`vocabBase`) the wallet needs to
 * MATCH an existing app key or MINT a fresh one. `capabilityQuery` holds one
 * collection-scoped grant request per app collection -- the existing capability
 * shape MINUS `controller` (the wallet fills it with the app-key subject DID)
 * and MINUS `reason` (the App Connect consent screen supersedes per-grant
 * reasons). A `visibility: 'public'` collection uses the
 * `urn:was:public-collection` descriptor type; everything else uses
 * `urn:was:collection`.
 *
 * @param options {object}
 * @param options.challenge {string}
 * @param options.domain {string}
 * @param options.appName {string}   human-readable app name for the consent
 *   screen
 * @param options.credential {SeedCredentialConfig}   the app's seed-credential
 *   type name + vocabulary namespace (match / mint)
 * @param options.collections {GrantRequestCollection[]}   the collections to
 *   request (WAS collection id + visibility)
 * @param [options.actions] {string[]}   the RW action set (defaults to
 *   `RW_ACTIONS`)
 * @returns {IVPRDetails}
 */
export function buildAppConnectVpr({
  challenge,
  domain,
  appName,
  credential,
  collections,
  actions = RW_ACTIONS
}: {
  challenge: string
  domain: string
  appName: string
  credential: SeedCredentialConfig
  collections: GrantRequestCollection[]
  actions?: string[]
}): IVPRDetails {
  const capabilityQuery: IAppConnectCapabilityQuery[] = collections.map(
    ({ id, visibility }) => ({
      referenceId: id,
      allowedAction: actions,
      invocationTarget: {
        type:
          visibility === 'public'
            ? 'urn:was:public-collection'
            : 'urn:was:collection',
        name: id
      }
    })
  )
  return {
    query: [
      {
        type: 'DIDAuthentication',
        acceptedMethods: [{ method: 'key' }]
      },
      {
        type: 'AppConnectQuery',
        app: {
          name: appName,
          credentialType: credential.credentialType,
          vocabBase: credential.vocabBase
        },
        capabilityQuery
      }
    ],
    challenge,
    domain
  }
}
