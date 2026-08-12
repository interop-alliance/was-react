/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The app-key credential: a self-issued VC holding the app's 32-byte master
 * seed, stored in (and recovered from) the user's wallet.
 *
 * The credential's vocabulary is fixed and shared by every application: the
 * `type` array is exactly `['VerifiableCredential', 'AppKeyCredential']`, and
 * the `@context` is the VC 1.0 context plus the hosted App Connect context
 * (`https://w3id.org/byoe/app-connect/v1`, resolved as a static context by the
 * document loader, so verification still needs no fetch). Nothing in the
 * credential is app-scoped.
 *
 * The credential is self-issued: `issuer === credentialSubject.id`, and both
 * equal the did:key controller DERIVED FROM THE EMBEDDED SEED -- so possession
 * of the credential is possession of the identity, and a parsed credential can
 * be re-checked against its own seed. `credentialSubject.origin` binds the
 * credential to this app's web origin (the anti-phishing guard checked at
 * login), and `credentialSubject.appUrl` identifies WHICH application on that
 * origin it belongs to: the app identity is scoped to the triple (user,
 * origin, `appUrl`).
 */
import { base64urlnopad } from '@scure/base'
import * as vc from '@interop/vc'
import { Ed25519Signature2020 } from '@interop/ed25519-signature'
import type {
  IVerifiableCredential,
  IVerifiablePresentation
} from '@interop/data-integrity-core'
import { CONTEXT_URL_V1 } from 'byoe-context'
import { asArray } from '../jsonLd.js'
import { deriveIdentity, type IdentityAgents } from './agents.js'
import type { DocumentLoader } from './documentLoader.js'

const VC_1_CONTEXT_URL = 'https://www.w3.org/2018/credentials/v1'

/**
 * The marker type every app key carries, mapped to one stable IRI for every
 * app by the hosted App Connect context. It makes "presents as an app key" a
 * term check rather than a shape heuristic, which is what lets the wallet
 * refuse a foreign app key at store time.
 *
 * It is a self-declaration, not evidence: the `type` array of a planted
 * credential is attacker-controlled like the rest of it. The marker makes the
 * rule precise; the seed-to-DID binding `parseSeedCredential` enforces remains
 * the only thing that authenticates.
 */
export const APP_KEY_CREDENTIAL_TYPE = 'AppKeyCredential'

/**
 * The credential's fixed two-entry `type` array, in this order.
 */
export const APP_KEY_TYPE_ARRAY: readonly string[] = Object.freeze([
  'VerifiableCredential',
  APP_KEY_CREDENTIAL_TYPE
])

/**
 * A parsed and structurally validated seed credential.
 */
export interface ParsedSeedCredential {
  seed: Uint8Array
  controllerDid: string
  /**
   * The identity agents derived from the embedded seed while checking the
   * seed-to-DID binding. Handed back so the login flow does not derive the same
   * master identity a second time (the derivation is the expensive step).
   */
  identity: IdentityAgents
}

/**
 * Encodes bytes as base64url (no padding), browser- and Node-safe.
 */
export function bytesToBase64url(bytes: Uint8Array): string {
  return base64urlnopad.encode(bytes)
}

/**
 * Decodes base64url text back into bytes.
 */
export function base64urlToBytes(text: string): Uint8Array {
  return base64urlnopad.decode(text)
}

/**
 * Self-issues the app-key credential for `seed`, signed Ed25519Signature2020 by
 * the seed-derived signer.
 *
 * @param options {object}
 * @param options.seed {Uint8Array}   the 32-byte master seed
 * @param options.origin {string}     this app's web origin (anti-phishing bind)
 * @param options.appUrl {string}     this app's canonical URL, in its
 *   serialized form (see `serializedAppUrl`); identifies the application among
 *   the applications on its origin
 * @param options.appName {string}    human-readable app name, shown by the
 *   wallet on the credential (`name`/`description`)
 * @param options.documentLoader {DocumentLoader}
 * @returns {Promise<IVerifiableCredential>}
 */
export async function issueSeedCredential({
  seed,
  origin,
  appUrl,
  appName,
  documentLoader
}: {
  seed: Uint8Array
  origin: string
  appUrl: string
  appName: string
  documentLoader: DocumentLoader
}): Promise<IVerifiableCredential> {
  // `deriveIdentity` enforces the 32-byte seed rule.
  const { controllerDid, keyAgent } = await deriveIdentity({ seed })
  const credential = {
    '@context': [VC_1_CONTEXT_URL, CONTEXT_URL_V1],
    id: `urn:uuid:${crypto.randomUUID()}`,
    type: [...APP_KEY_TYPE_ARRAY],
    name: `${appName} app key`,
    description: `The ${appName} app keeps this key in your wallet so it can open your encrypted data on this and other devices.`,
    issuer: controllerDid,
    credentialSubject: {
      id: controllerDid,
      seed: bytesToBase64url(seed),
      appUrl,
      origin
    }
  }
  const suite = new Ed25519Signature2020({ signer: keyAgent.getSigner() })
  return (await vc.issue({
    credential,
    suite,
    documentLoader
  })) as IVerifiableCredential
}

/**
 * Parses an app-key credential and enforces the App Connect spec's six parse
 * checks, in order: the `AppKeyCredential` marker type, the `appUrl` claim
 * matching what this request sent (exact string), self-issue (issuer ===
 * subject id), the origin binding (exact string, against this app's own live
 * origin -- the same value it sent as the request `domain`), a well-formed
 * 32-byte base64url-no-pad seed, and -- the strongest check -- that the DID
 * derived from the embedded seed IS the credential's subject/issuer DID. (The
 * cryptographic proof on the credential is verified separately at the
 * presentation level.)
 *
 * These duplicate checks the wallet already made; that is the point. They are
 * defense in depth over an origin binding and an identity binding this app is
 * fully able to check itself.
 *
 * @param options {object}
 * @param options.credential {IVerifiableCredential}
 * @param options.origin {string}   this app's own live browser origin
 * @param options.appUrl {string}   the serialized `appUrl` this request sent
 * @returns {Promise<ParsedSeedCredential>}
 */
export async function parseSeedCredential({
  credential,
  origin,
  appUrl
}: {
  credential: IVerifiableCredential
  origin: string
  appUrl: string
}): Promise<ParsedSeedCredential> {
  const types = asArray(credential.type)
  if (!types.includes(APP_KEY_CREDENTIAL_TYPE)) {
    throw new Error(
      `The app-key credential does not carry the ` +
        `${APP_KEY_CREDENTIAL_TYPE} type.`
    )
  }
  const subject = credential.credentialSubject as {
    id?: string
    seed?: string
    origin?: string
    appUrl?: string
  }
  if (subject?.appUrl !== appUrl) {
    throw new Error(
      `The app-key credential's appUrl "${subject?.appUrl ?? ''}" does not ` +
        `match this app's appUrl "${appUrl}".`
    )
  }
  const issuer =
    typeof credential.issuer === 'string'
      ? credential.issuer
      : (credential.issuer as { id?: string } | undefined)?.id
  if (!issuer || !subject?.id || issuer !== subject.id) {
    throw new Error('The app-key credential is not self-issued.')
  }
  if (subject.origin !== origin) {
    throw new Error(
      `The app-key credential's origin "${subject.origin ?? ''}" does not match this app's origin "${origin}".`
    )
  }
  if (typeof subject.seed !== 'string' || subject.seed.length === 0) {
    throw new Error('The app-key credential carries no seed.')
  }
  // Fail closed on anything that is not base64url-no-pad decoding to exactly
  // 32 bytes -- never truncate or pad.
  let seed: Uint8Array
  try {
    seed = base64urlToBytes(subject.seed)
  } catch (err) {
    throw new Error('The app-key seed is not valid base64url (no padding).', {
      cause: err
    })
  }
  if (seed.length !== 32) {
    throw new Error(
      `The app-key seed must decode to 32 bytes (got ${seed.length}).`
    )
  }
  // Derived once and handed back on the result: the same agents the caller
  // would otherwise re-derive from this seed right after.
  const identity = await deriveIdentity({ seed })
  if (identity.controllerDid !== subject.id) {
    throw new Error(
      'The app-key seed does not derive the credential subject DID.'
    )
  }
  return { seed, controllerDid: identity.controllerDid, identity }
}

/**
 * Finds the app-key credential inside a wallet response VP, or `null` when the
 * wallet returned none (the wallet-unsupported signal).
 *
 * Matched on the `credentialSubject.appUrl` claim ALONE: per the App Connect
 * spec's response-verification step 3, the `AppKeyCredential` marker type must
 * NOT be required here. Requiring it would make "the wallet returned a
 * credential that is wrong" indistinguishable from "the wallet returned
 * nothing" -- a returned credential missing the marker must surface as a parse
 * error from {@link parseSeedCredential}, not as a `null` a caller would read
 * as first run and answer by silently minting a second key.
 *
 * @param options {object}
 * @param options.presentation {IVerifiablePresentation}
 * @param options.appUrl {string}   the serialized `appUrl` this request sent
 * @returns {IVerifiableCredential | null}
 */
export function findSeedCredential({
  presentation,
  appUrl
}: {
  presentation: IVerifiablePresentation
  appUrl: string
}): IVerifiableCredential | null {
  const embedded = (presentation as { verifiableCredential?: unknown })
    .verifiableCredential
  for (const entry of asArray(embedded)) {
    const subject = (entry as { credentialSubject?: { appUrl?: unknown } })
      .credentialSubject
    if (subject?.appUrl === appUrl) {
      return entry as IVerifiableCredential
    }
  }
  return null
}
