/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The Login-With-Wallet orchestration: one-popup App Connect.
 *
 * A single CHAPI `get` carries the {@link buildAppConnectVpr} request. The
 * wallet -- in the same round -- matches an existing app key or mints a fresh
 * one (the first-run branch is wallet-internal now), then returns the app-key
 * credential and the delegated zcaps embedded in one signed response VP. So
 * there is no second store popup and no separate grants popup:
 *
 * - Returning: the wallet returns the credential; we recover the seed and
 *   verify its self-issue/origin/DID binding.
 * - First run: the wallet mints the seed, self-issues the same-shaped
 *   credential, and marks `presentation.appConnect.firstRun`.
 *
 * A wallet that predates `AppConnectQuery` cannot satisfy it and returns no
 * app-key credential; that surfaces as {@link WalletUnsupportedError} (fail
 * closed, legibly), distinct from a user cancel (a null CHAPI response).
 *
 * Hot restore (seed + grants already persisted locally) never reaches this
 * module -- the caller's session restore short-circuits it.
 */
import type {
  IVerifiablePresentation,
  IZcap
} from '@interop/data-integrity-core'
import type { DocumentLoader } from '../identity/documentLoader.js'
import {
  findSeedCredential,
  parseSeedCredential,
  type SeedCredentialConfig
} from '../identity/seedCredential.js'
import { initAppSession } from '../identity/initAppSession.js'
import type { IdentityAgents } from '../identity/agents.js'
import { chapiGet } from './chapi.js'
import {
  buildAppConnectVpr,
  newChallenge,
  type GrantRequestCollection
} from './loginRequest.js'
import {
  checkGrants,
  grantsOf,
  verifyLoginPresentation,
  type CheckedGrants
} from './verifyResponse.js'
import type { ParsedGrants } from '../grants.js'

/**
 * The cohesive configuration for a Login-With-Wallet flow. App-specific values
 * are injected here rather than baked in; this becomes part of the library's
 * central app config later.
 */
export interface LoginConfig {
  /**
   * This app's own web origin (the anti-phishing bind on the app key).
   */
  appOrigin: string
  /**
   * Human-readable app name, used in the wallet consent reason lines.
   */
  appName: string
  /**
   * The collections to request read/write grants for (WAS collection id +
   * visibility; `'public'` selects the `urn:was:public-collection` descriptor).
   */
  collections: GrantRequestCollection[]
  /**
   * The seed-credential type name + vocabulary namespace.
   */
  credential: SeedCredentialConfig
  /**
   * The JSON-LD document loader (see `createDocumentLoader`).
   */
  documentLoader: DocumentLoader
  /**
   * The CHAPI mediator base URL (defaults to `DEFAULT_MEDIATOR_BASE`).
   */
  mediatorBase?: string
}

/**
 * A user-facing progress phase, for the login page's status line. The one-popup
 * App Connect flow has just two: `connecting` (building the request and awaiting
 * the wallet) and `verifying` (checking the wallet's response).
 */
export type LoginPhase = 'connecting' | 'verifying'

export interface LoginOutcome {
  seed: Uint8Array
  identity: IdentityAgents
  grants: IZcap[]
  parsed: ParsedGrants
  /**
   * ISO timestamp: the earliest expiry across the grants.
   */
  expires: string
  /**
   * Whether this login created a brand-new app key (first run).
   */
  firstRun: boolean
}

/**
 * Thrown when the user cancels/dismisses a wallet popup.
 */
export class LoginCancelledError extends Error {
  constructor(step: string) {
    super(`The wallet request was cancelled (${step}).`)
    this.name = 'LoginCancelledError'
  }
}

/**
 * Thrown when the wallet answered but returned no app-key credential -- the
 * fail-closed signal that the wallet predates `AppConnectQuery` (it rendered the
 * query unsatisfiable). Distinct from a user cancel so the UI can prompt an
 * update instead of showing a generic verification error.
 */
export class WalletUnsupportedError extends Error {
  constructor() {
    super(
      'Your wallet does not support App Connect yet; update Freewallet to ' +
        'log in.'
    )
    this.name = 'WalletUnsupportedError'
  }
}

/**
 * A nominal far-future expiry (ms) used when an app requests no collections (so
 * there are no grants and thus no earliest-expiry to report).
 */
const NO_GRANTS_EXPIRY_MS = 100 * 365 * 24 * 60 * 60 * 1000

/**
 * Reads the wallet-provided `presentation.appConnect.firstRun` boolean. Anything
 * other than boolean `true` (including an absent member -- a returning login) is
 * treated as `false`.
 */
function appConnectFirstRun(presentation: IVerifiablePresentation): boolean {
  const appConnect = (presentation as { appConnect?: { firstRun?: unknown } })
    .appConnect
  return appConnect?.firstRun === true
}

/**
 * Structurally validates the grants embedded in the wallet response against the
 * requested collections. When the app requested NO collections there is nothing
 * to delegate: `checkGrants` (which rejects an empty grant set) is skipped and
 * an empty grant set with a far-future expiry is returned instead.
 *
 * @param options {object}
 * @param options.presentation {IVerifiablePresentation}
 * @param options.controllerDid {string}   the app-key subject DID grants must
 *   be controlled by
 * @param options.collections {GrantRequestCollection[]}
 * @returns {CheckedGrants}
 */
function checkGrantsForCollections({
  presentation,
  controllerDid,
  collections
}: {
  presentation: IVerifiablePresentation
  controllerDid: string
  collections: GrantRequestCollection[]
}): CheckedGrants {
  const collectionIds = collections.map(collection => collection.id)
  if (collectionIds.length === 0) {
    return {
      grants: [],
      parsed: { serverUrl: '', spaceId: '', byCollectionId: {} },
      expires: new Date(Date.now() + NO_GRANTS_EXPIRY_MS).toISOString()
    }
  }
  return checkGrants({
    grants: grantsOf(presentation),
    controllerDid,
    collections: collectionIds
  })
}

/**
 * Re-requests storage grants for `identity` over a fresh App Connect popup and
 * validates them. The expired-access reconnect path: the seed already exists, so
 * only the grants need renewing. The wallet matches the same app key and
 * re-delegates; the returned credential/`appConnect` marker are ignored here.
 *
 * @param options {object}
 * @param options.identity {IdentityAgents}
 * @param options.config {LoginConfig}
 * @param [options.onPhase] {Function}
 * @returns {Promise<CheckedGrants>}
 */
export async function requestGrants({
  identity,
  config,
  onPhase
}: {
  identity: IdentityAgents
  config: LoginConfig
  onPhase?: (phase: LoginPhase) => void
}): Promise<CheckedGrants> {
  onPhase?.('connecting')
  const challenge = newChallenge()
  const vpr = buildAppConnectVpr({
    challenge,
    domain: window.location.origin,
    appName: config.appName,
    credential: config.credential,
    collections: config.collections
  })
  const presentation = await chapiGet({
    vpr,
    ...(config.mediatorBase !== undefined && {
      mediatorBase: config.mediatorBase
    })
  })
  if (!presentation) {
    throw new LoginCancelledError('storage grants')
  }
  onPhase?.('verifying')
  await verifyLoginPresentation({
    presentation,
    challenge,
    domain: window.location.origin,
    documentLoader: config.documentLoader
  })
  return checkGrantsForCollections({
    presentation,
    controllerDid: identity.controllerDid,
    collections: config.collections
  })
}

/**
 * Runs the one-popup Login-With-Wallet (App Connect) flow. A single CHAPI `get`
 * returns the app-key credential (matched or minted wallet-side) plus the
 * delegated grants in one signed VP. Throws `LoginCancelledError` on a user
 * cancel (a null CHAPI response), `WalletUnsupportedError` when the wallet
 * answered but returned no app key (an old wallet that could not satisfy
 * `AppConnectQuery`), and `Error` on any verification failure. Nothing is
 * persisted here (the caller persists).
 *
 * @param options {object}
 * @param options.config {LoginConfig}
 * @param [options.onPhase] {Function}
 * @returns {Promise<LoginOutcome>}
 */
export async function loginWithWallet({
  config,
  onPhase
}: {
  config: LoginConfig
  onPhase?: (phase: LoginPhase) => void
}): Promise<LoginOutcome> {
  onPhase?.('connecting')
  const challenge = newChallenge()
  const vpr = buildAppConnectVpr({
    challenge,
    domain: window.location.origin,
    appName: config.appName,
    credential: config.credential,
    collections: config.collections
  })
  const presentation = await chapiGet({
    vpr,
    ...(config.mediatorBase !== undefined && {
      mediatorBase: config.mediatorBase
    })
  })
  if (!presentation) {
    throw new LoginCancelledError('wallet login')
  }
  onPhase?.('verifying')
  await verifyLoginPresentation({
    presentation,
    challenge,
    domain: window.location.origin,
    documentLoader: config.documentLoader
  })

  // The wallet mints the app key on first run, so a response with no app-key
  // credential is not first run -- it is a wallet that could not satisfy
  // `AppConnectQuery` at all. Fail closed, legibly, rather than as a generic
  // verification error.
  const credential = findSeedCredential({
    presentation,
    credentialType: config.credential.credentialType
  })
  if (!credential) {
    throw new WalletUnsupportedError()
  }
  // Recover the seed, enforcing self-issue + origin + the seed-to-DID binding
  // (the same contract whether the wallet matched or minted the credential).
  const parsedCredential = await parseSeedCredential({
    credential,
    origin: config.appOrigin,
    config: config.credential
  })
  const seed = parsedCredential.seed
  const firstRun = appConnectFirstRun(presentation)

  const identity = await initAppSession({ seed })
  // Grants ride in the SAME response; validate them against the app-key subject
  // DID the wallet delegated to.
  const checked = checkGrantsForCollections({
    presentation,
    controllerDid: parsedCredential.controllerDid,
    collections: config.collections
  })
  return {
    seed,
    identity,
    grants: checked.grants,
    parsed: checked.parsed,
    expires: checked.expires,
    firstRun
  }
}
