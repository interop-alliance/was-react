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
 * Only collection-scoped capabilities are requested (no whole-space grant),
 * and each request stays within the ACTION CEILING of the descriptor class it
 * uses (the App Connect spec's "Action ceilings" table): a private collection
 * asks for the full vocabulary ({@link RW_ACTIONS}), a public collection at
 * most the add-only set ({@link PUBLIC_ACTIONS}). A configured action set
 * naming an action above a requested collection's ceiling is a configuration
 * error thrown here, at build time -- a conformant wallet can never grant it,
 * so letting it ride would surface later as a failed login instead.
 *
 * A `visibility: 'public'` collection is requested with the distinct descriptor
 * type `https://w3id.org/byoe#public-collection` (the wallet provisions it plaintext with a
 * collection-level public-read policy and renders a world-readable consent
 * warning); wallets that predate the type render it UNSATISFIABLE, which is the
 * intended fail-closed behavior -- an older wallet must not silently provision a
 * private collection the app believes is public. The App Connect query as a
 * whole is likewise unsatisfiable on a wallet that predates it, so an old wallet
 * fails closed rather than degrading into a partial generic flow.
 *
 * A SHARED collection -- one the wallet already owns and encrypts, which the app
 * asks to read and decrypt -- uses the
 * `https://w3id.org/byoe#shared-wallet-collection` descriptor type, and the
 * actions are read-only by construction ({@link SHARED_ACTIONS}):
 * the app never requests writes on a wallet collection. Exactly like
 * `https://w3id.org/byoe#public-collection`, a wallet that predates the type resolves the
 * descriptor UNSATISFIABLE and fails closed -- which is the point here. A share
 * fuses two axes (a read zcap AND an entry in the collection's key-epoch
 * roster), so a wallet that granted only the zcap would hand the app ciphertext
 * it cannot decrypt; that would surface as corrupt data rather than as a wallet
 * that needs updating.
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
 * Default read/write actions requested on each private app collection -- also
 * the `https://w3id.org/byoe#private-collection` class ceiling (the full WAS
 * action vocabulary).
 */
export const RW_ACTIONS = ['GET', 'HEAD', 'PUT', 'POST', 'DELETE']

/**
 * The `https://w3id.org/byoe#public-collection` class ceiling: add-only, reads
 * plus `POST`, never `PUT` or `DELETE`. A write to a plaintext world-readable
 * collection is publication under the user's identity and irreversible in
 * practice, so a conformant wallet caps a public grant here no matter what was
 * asked -- and the App Connect spec forbids an application from requiring an
 * action above it.
 */
export const PUBLIC_ACTIONS = ['GET', 'HEAD', 'POST']

/**
 * The actions requested on a SHARED (wallet-owned) collection: read-only, and
 * not configurable. A shared collection belongs to the wallet, so an app never
 * asks to write it.
 */
export const SHARED_ACTIONS = ['GET', 'HEAD']

/**
 * The action ceiling of the descriptor class a collection is requested with
 * (the App Connect spec's "Action ceilings" table): add-only for
 * `visibility: 'public'` (`https://w3id.org/byoe#public-collection`), the full
 * vocabulary otherwise (`https://w3id.org/byoe#private-collection`). Shares
 * have their own fixed {@link SHARED_ACTIONS} and never consult a configured
 * action set.
 *
 * @param [visibility] {'private' | 'public'}
 * @returns {string[]}
 */
export function actionCeiling(visibility?: 'private' | 'public'): string[] {
  return visibility === 'public' ? PUBLIC_ACTIONS : RW_ACTIONS
}

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
   * (`https://w3id.org/byoe#private-collection` for `'private'`/unset,
   * `https://w3id.org/byoe#public-collection` for `'public'`).
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
 * The actions to request for one collection: the configured set capped at the
 * collection's class ceiling, kept in ceiling order. When no set is configured
 * the whole ceiling is requested. An EXPLICIT set naming an action above the
 * ceiling is a configuration error thrown here, at request build time: a
 * conformant wallet can never grant it, so silently capping would leave the
 * app believing it asked for more than any correct wallet returns, and the
 * mismatch would surface later as a failed login instead of as the config bug
 * it is.
 *
 * @param options {object}
 * @param options.id {string}   the WAS collection id (for error messages)
 * @param [options.visibility] {'private' | 'public'}
 * @param [options.actions] {string[]}   the configured action set
 * @returns {string[]}
 */
function requestedActions({
  id,
  visibility,
  actions
}: {
  id: string
  visibility?: 'private' | 'public'
  actions?: string[]
}): string[] {
  const ceiling = actionCeiling(visibility)
  if (actions === undefined) {
    return ceiling
  }
  const excess = actions.filter(action => !ceiling.includes(action))
  if (excess.length > 0) {
    throw new Error(
      `Collection "${id}" cannot request action(s) above its class ceiling: ` +
        `${excess.join(', ')} (the ceiling is ${ceiling.join(', ')}).`
    )
  }
  const capped = ceiling.filter(action => actions.includes(action))
  if (capped.length === 0) {
    // An empty allowedAction array means EVERY action in the zcap model, so an
    // action-less request must never be built.
    throw new Error(`Collection "${id}" requests no actions.`)
  }
  return capped
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
 * `https://w3id.org/byoe#public-collection` descriptor type; everything else
 * uses `https://w3id.org/byoe#private-collection`.
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
 * @param [options.sharedCollections] {string[]}   WAS collection ids of
 *   wallet-owned collections to request read-and-decrypt access to; each gets
 *   a `https://w3id.org/byoe#shared-wallet-collection` descriptor with
 *   {@link SHARED_ACTIONS}
 * @param [options.actions] {string[]}   the action set to request on each app
 *   collection; when omitted each collection requests exactly its class
 *   ceiling ({@link actionCeiling}). An explicit set naming an action above a
 *   requested collection's ceiling throws (a configuration error, surfaced at
 *   build time rather than as a failed login)
 * @returns {IVPRDetails}
 */
export function buildAppConnectVpr({
  challenge,
  domain,
  appName,
  credential,
  collections,
  sharedCollections = [],
  actions
}: {
  challenge: string
  domain: string
  appName: string
  credential: SeedCredentialConfig
  collections: GrantRequestCollection[]
  sharedCollections?: string[]
  actions?: string[]
}): IVPRDetails {
  const capabilityQuery: IAppConnectCapabilityQuery[] = collections.map(
    ({ id, visibility }) => ({
      referenceId: id,
      allowedAction: requestedActions({ id, visibility, actions }),
      invocationTarget: {
        type:
          visibility === 'public'
            ? 'https://w3id.org/byoe#public-collection'
            : 'https://w3id.org/byoe#private-collection',
        name: id
      }
    })
  )
  for (const id of sharedCollections) {
    capabilityQuery.push({
      referenceId: id,
      allowedAction: SHARED_ACTIONS,
      invocationTarget: {
        type: 'https://w3id.org/byoe#shared-wallet-collection',
        name: id
      }
    })
  }
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
