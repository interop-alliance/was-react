/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * RP-side verification of a wallet's Login-With-Wallet response VP.
 *
 * Layered checks:
 * 1. Cryptographic: `@interop/verifier-core` `verifyPresentation` (the VP's
 *    DIDAuth proof plus every embedded VC proof; the default crypto service
 *    covers Ed25519Signature2020 and eddsa-rdfc-2022, the two suites the
 *    wallet mints). `registries: []` disables issuer-registry lookup (the
 *    app-key credential is self-issued by design).
 * 2. Manual proof checks verifier-core does not make: `proofPurpose` is
 *    `authentication`, `domain` equals what this app sent (its origin), and
 *    the `challenge` echoes this request's fresh nonce.
 * 3. Grant structure: every zcap is controlled by OUR seed-derived DID,
 *    targets a single space on a single WAS host, is unexpired, and the
 *    collection set is fully covered with sufficient actions. (Delegation-
 *    chain proofs are enforced server-side at invocation; the RP checks
 *    structure.)
 *
 * Note on holder binding: the wallet signs the VP as ITS holder DID (did:web
 * or the wallet's did:key) -- not as this app's controller DID, which never
 * leaves this app. The seed-to-identity binding is enforced instead by
 * `parseSeedCredential` (issuer === subject === DID derived from the embedded
 * seed) and by every grant's `controller` being the requested controller DID.
 */
import { verifyPresentation } from '@interop/verifier-core'
import type {
  IVerifiablePresentation,
  IZcap
} from '@interop/data-integrity-core'
import type { DocumentLoader } from '../identity/documentLoader.js'
import { parseGrants, type ParsedGrants } from '../grants.js'
import { earliestExpiry, isExpired } from '../identity/appSession.js'
import { RW_ACTIONS } from './loginRequest.js'

/**
 * One proof object on a VP (possibly one of several).
 */
interface VpProof {
  type?: string
  proofPurpose?: string
  challenge?: string
  domain?: string
}

/**
 * Verifies a login response VP cryptographically and structurally (steps 1-2
 * above). Throws on any failure.
 *
 * @param options {object}
 * @param options.presentation {IVerifiablePresentation}
 * @param options.challenge {string}   the fresh nonce this app sent
 * @param options.domain {string}      the domain this app sent (its origin)
 * @param options.documentLoader {DocumentLoader}
 * @returns {Promise<void>}
 */
export async function verifyLoginPresentation({
  presentation,
  challenge,
  domain,
  documentLoader
}: {
  presentation: IVerifiablePresentation
  challenge: string
  domain: string
  documentLoader: DocumentLoader
}): Promise<void> {
  const result = await verifyPresentation({
    presentation,
    challenge,
    registries: [],
    documentLoader
  })
  if (!result.verified) {
    const failures = [
      ...result.presentationResults,
      ...result.credentialResults.flatMap(c => c.results)
    ]
      .filter(check => check.outcome.status === 'failure')
      .map(check => check.check)
    throw new Error(
      `Wallet presentation failed verification (${failures.join(', ') || 'unknown check'}).`
    )
  }

  const rawProof = (presentation as { proof?: VpProof | VpProof[] }).proof
  const proofs = Array.isArray(rawProof) ? rawProof : rawProof ? [rawProof] : []
  const authProof = proofs.find(
    proof => proof.proofPurpose === 'authentication'
  )
  if (!authProof) {
    throw new Error('Wallet presentation carries no authentication proof.')
  }
  if (authProof.challenge !== challenge) {
    throw new Error('Wallet presentation challenge does not match.')
  }
  if (authProof.domain !== domain) {
    throw new Error(
      `Wallet presentation domain "${authProof.domain ?? ''}" does not match "${domain}".`
    )
  }
}

/**
 * Extracts the delegated zcaps from a wallet response VP (`zcap` array).
 */
export function grantsOf(presentation: IVerifiablePresentation): IZcap[] {
  const zcap = (presentation as { zcap?: unknown }).zcap
  if (!Array.isArray(zcap)) {
    return []
  }
  return zcap as IZcap[]
}

/**
 * A validated grant set: parsed topology plus the earliest expiry.
 */
export interface CheckedGrants {
  parsed: ParsedGrants
  grants: IZcap[]
  /**
   * ISO timestamp: the earliest expiry across the grants.
   */
  expires: string
}

/**
 * The actions a grant allows, normalized to an array.
 */
function actionsOf(zcap: IZcap): string[] {
  const allowed = (zcap as { allowedAction?: string | string[] }).allowedAction
  return Array.isArray(allowed) ? allowed : allowed ? [allowed] : []
}

/**
 * Structural validation of the granted zcaps (step 3 above). Throws on any
 * failure; returns the parsed topology and the earliest expiry on success.
 *
 * @param options {object}
 * @param options.grants {IZcap[]}
 * @param options.controllerDid {string}   this app's seed-derived DID
 * @param options.collections {string[]}   the WAS collection ids that must be
 *   covered
 * @param [options.requiredActions] {string[]}   the actions each collection
 *   grant must allow (defaults to `RW_ACTIONS`)
 * @returns {CheckedGrants}
 */
export function checkGrants({
  grants,
  controllerDid,
  collections,
  requiredActions = RW_ACTIONS
}: {
  grants: IZcap[]
  controllerDid: string
  collections: string[]
  requiredActions?: string[]
}): CheckedGrants {
  if (grants.length === 0) {
    throw new Error('The wallet returned no storage grants.')
  }
  for (const grant of grants) {
    const controller = (grant as { controller?: unknown }).controller
    if (controller !== controllerDid) {
      throw new Error(
        `A grant is controlled by "${String(controller)}", not this app's DID.`
      )
    }
    const expires = (grant as { expires?: unknown }).expires
    if (typeof expires !== 'string' || isExpired(expires)) {
      throw new Error('A grant is missing an expiry or is already expired.')
    }
  }

  // Asserts a single server origin + single space across all grants and
  // builds the per-collection routing table. The wallet decides where the
  // user's Space lives; the sync layer derives its target from the grants.
  const parsed = parseGrants(grants)

  for (const id of collections) {
    const grant = parsed.byCollectionId[id]
    if (!grant) {
      throw new Error(`No grant covers the "${id}" collection.`)
    }
    const actions = actionsOf(grant)
    const missing = requiredActions.filter(action => !actions.includes(action))
    if (missing.length > 0) {
      throw new Error(
        `The "${id}" grant lacks required actions: ${missing.join(', ')}.`
      )
    }
  }

  const expires = earliestExpiry(grants)
  if (!expires) {
    throw new Error('No grant carries a parseable expiry.')
  }
  return { parsed, grants, expires }
}
