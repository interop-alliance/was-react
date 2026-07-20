/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The Login-With-Wallet orchestration:
 *
 * - First run (the wallet holds no app key): generate a fresh 32-byte master
 *   seed, self-issue the credential, and BLOCK until the wallet confirms
 *   storing it (a dismissed store would silently break cross-device recovery),
 *   then request the storage grants.
 * - Returning (the wallet returns the credential): recover the seed, verify
 *   the credential's self-issue/origin/DID binding, then request grants for
 *   the same stable controller DID.
 *
 * Hot restore (seed + grants already persisted locally) never reaches this
 * module -- the caller's session restore short-circuits it.
 */
import type { IZcap } from '@interop/data-integrity-core'
import type { DocumentLoader } from '../identity/documentLoader.js'
import {
  findSeedCredential,
  issueSeedCredential,
  parseSeedCredential,
  wrapCredentialForStore,
  type SeedCredentialConfig
} from '../identity/seedCredential.js'
import { initAppSession } from '../identity/initAppSession.js'
import type { IdentityAgents } from '../identity/agents.js'
import { chapiGet, chapiStore } from './chapi.js'
import {
  buildGrantsVpr,
  buildSeedProbeVpr,
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
 * A user-facing progress phase, for the login page's status line.
 */
export type LoginPhase =
  'probing' | 'storing-key' | 'requesting-grants' | 'verifying'

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
 * Requests storage grants for `identity` and validates them. Shared by the
 * login flow and the expired-access reconnect path.
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
  onPhase?.('requesting-grants')
  const challenge = newChallenge()
  const vpr = buildGrantsVpr({
    challenge,
    domain: window.location.origin,
    controllerDid: identity.controllerDid,
    collections: config.collections,
    appName: config.appName
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
  return checkGrants({
    grants: grantsOf(presentation),
    controllerDid: identity.controllerDid,
    collections: config.collections.map(collection => collection.id)
  })
}

/**
 * Runs the full Login-With-Wallet flow (first-run or returning, decided by
 * the seed probe). Throws `LoginCancelledError` on dismissal and `Error` on
 * verification failures; nothing is persisted here (the caller persists).
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
  // Popup #1: probe the wallet for an existing app key.
  onPhase?.('probing')
  const probeChallenge = newChallenge()
  const probeVpr = buildSeedProbeVpr({
    challenge: probeChallenge,
    domain: window.location.origin,
    credentialType: config.credential.credentialType,
    appName: config.appName
  })
  const probeVp = await chapiGet({
    vpr: probeVpr,
    ...(config.mediatorBase !== undefined && {
      mediatorBase: config.mediatorBase
    })
  })
  if (!probeVp) {
    throw new LoginCancelledError('wallet login')
  }
  await verifyLoginPresentation({
    presentation: probeVp,
    challenge: probeChallenge,
    domain: window.location.origin,
    documentLoader: config.documentLoader
  })

  let seed: Uint8Array
  let firstRun: boolean
  const credential = findSeedCredential({
    presentation: probeVp,
    credentialType: config.credential.credentialType
  })
  if (credential) {
    // Returning login: recover the seed, enforce self-issue + origin + the
    // seed-to-DID binding.
    const parsed = await parseSeedCredential({
      credential,
      origin: config.appOrigin,
      config: config.credential
    })
    seed = parsed.seed
    firstRun = false
  } else {
    // First run: mint a fresh master seed and store its credential in the
    // wallet. Block until the store succeeds -- without it, cross-device
    // recovery is silently broken.
    seed = crypto.getRandomValues(new Uint8Array(32))
    firstRun = true
    onPhase?.('storing-key')
    const issued = await issueSeedCredential({
      seed,
      origin: config.appOrigin,
      appName: config.appName,
      config: config.credential,
      documentLoader: config.documentLoader
    })
    const stored = await chapiStore({
      presentation: wrapCredentialForStore(issued),
      ...(config.mediatorBase !== undefined && {
        mediatorBase: config.mediatorBase
      })
    })
    if (!stored) {
      throw new LoginCancelledError('saving your app key to the wallet')
    }
  }

  const identity = await initAppSession({ seed })
  // Popup #2: request the storage grants for the stable controller DID.
  const checked = await requestGrants({
    identity,
    config,
    ...(onPhase && { onPhase })
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
