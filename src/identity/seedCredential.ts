/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The app-key credential: a self-issued VC holding the app's 32-byte master
 * seed, stored in (and recovered from) the user's wallet. An inline-context
 * pattern keeps it verifiable with no remote vocabulary fetch.
 *
 * The credential is self-issued: `issuer === credentialSubject.id`, and both
 * equal the did:key controller DERIVED FROM THE EMBEDDED SEED -- so possession
 * of the credential is possession of the identity, and a parsed credential can
 * be re-checked against its own seed. `credentialSubject.origin` binds the
 * credential to this app's web origin (the anti-phishing guard checked at
 * login). The credential type name and vocabulary namespace are app-supplied
 * (`SeedCredentialConfig`) so different apps hold sibling credential types on
 * the same pattern.
 */
import { base64urlnopad } from '@scure/base'
import * as vc from '@interop/vc'
import { Ed25519Signature2020 } from '@interop/ed25519-signature'
import type {
  IVerifiableCredential,
  IVerifiablePresentation
} from '@interop/data-integrity-core'
import { deriveIdentity } from './agents.js'
import type { DocumentLoader } from './documentLoader.js'

const VC_1_CONTEXT_URL = 'https://www.w3.org/2018/credentials/v1'

/**
 * App-supplied naming for the seed credential: the VC `type` name and the URN
 * vocabulary namespace its inline-context terms are minted under (e.g.
 * `credentialType: 'MyAppKey'`, `vocabBase: 'urn:my-app:vocab#'`).
 */
export interface SeedCredentialConfig {
  credentialType: string
  vocabBase: string
}

/**
 * A parsed and structurally validated seed credential.
 */
export interface ParsedSeedCredential {
  seed: Uint8Array
  controllerDid: string
}

/**
 * Builds the inline context object binding the app's credential terms to its
 * URN vocabulary namespace, so the credential stays verifiable with no remote
 * vocabulary fetch.
 */
function seedContext({ credentialType, vocabBase }: SeedCredentialConfig): {
  '@protected': true
  [term: string]: unknown
} {
  return {
    '@protected': true,
    [credentialType]: `${vocabBase}${credentialType}`,
    seed: `${vocabBase}seed`,
    origin: `${vocabBase}origin`,
    name: 'https://schema.org/name',
    description: 'https://schema.org/description'
  }
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
 * @param options.appName {string}    human-readable app name, shown by the
 *   wallet on the credential (`name`/`description`)
 * @param options.config {SeedCredentialConfig}   credential type + vocab
 * @param options.documentLoader {DocumentLoader}
 * @returns {Promise<IVerifiableCredential>}
 */
export async function issueSeedCredential({
  seed,
  origin,
  appName,
  config,
  documentLoader
}: {
  seed: Uint8Array
  origin: string
  appName: string
  config: SeedCredentialConfig
  documentLoader: DocumentLoader
}): Promise<IVerifiableCredential> {
  if (seed.length !== 32) {
    throw new Error(`Master seed must be 32 bytes (got ${seed.length}).`)
  }
  const { controllerDid, keyAgent } = await deriveIdentity({ seed })
  const credential = {
    '@context': [VC_1_CONTEXT_URL, seedContext(config)],
    id: `urn:uuid:${crypto.randomUUID()}`,
    type: ['VerifiableCredential', config.credentialType],
    name: `${appName} app key`,
    description: `The ${appName} app keeps this key in your wallet so it can open your encrypted data on this and other devices.`,
    issuer: controllerDid,
    credentialSubject: {
      id: controllerDid,
      seed: bytesToBase64url(seed),
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
 * Parses a seed credential and enforces the structural contract: type,
 * self-issue (issuer === subject id), origin binding, a well-formed 32-byte
 * seed, and -- the strongest check -- that the DID derived from the embedded
 * seed IS the credential's subject/issuer DID. (The cryptographic proof on the
 * credential is verified separately at the presentation level.)
 *
 * @param options {object}
 * @param options.credential {IVerifiableCredential}
 * @param options.origin {string}   the expected app origin
 * @param options.config {SeedCredentialConfig}   credential type + vocab
 * @returns {Promise<ParsedSeedCredential>}
 */
export async function parseSeedCredential({
  credential,
  origin,
  config
}: {
  credential: IVerifiableCredential
  origin: string
  config: SeedCredentialConfig
}): Promise<ParsedSeedCredential> {
  const { credentialType } = config
  const types = Array.isArray(credential.type)
    ? credential.type
    : [credential.type]
  if (!types.includes(credentialType)) {
    throw new Error(`Credential is not a ${credentialType} credential.`)
  }
  const issuer =
    typeof credential.issuer === 'string'
      ? credential.issuer
      : (credential.issuer as { id?: string } | undefined)?.id
  const subject = credential.credentialSubject as {
    id?: string
    seed?: string
    origin?: string
  }
  if (!issuer || !subject?.id || issuer !== subject.id) {
    throw new Error(`${credentialType} credential is not self-issued.`)
  }
  if (subject.origin !== origin) {
    throw new Error(
      `${credentialType} origin "${subject.origin ?? ''}" does not match this app's origin "${origin}".`
    )
  }
  if (typeof subject.seed !== 'string' || subject.seed.length === 0) {
    throw new Error(`${credentialType} credential carries no seed.`)
  }
  const seed = base64urlToBytes(subject.seed)
  if (seed.length !== 32) {
    throw new Error(
      `${credentialType} seed must decode to 32 bytes (got ${seed.length}).`
    )
  }
  const { controllerDid } = await deriveIdentity({ seed })
  if (controllerDid !== subject.id) {
    throw new Error(
      `${credentialType} seed does not derive the credential subject DID.`
    )
  }
  return { seed, controllerDid }
}

/**
 * Finds the seed credential inside a wallet response VP, or `null` when the
 * wallet returned none (the first-run signal).
 *
 * @param options {object}
 * @param options.presentation {IVerifiablePresentation}
 * @param options.credentialType {string}   the app's seed-credential type name
 * @returns {IVerifiableCredential | null}
 */
export function findSeedCredential({
  presentation,
  credentialType
}: {
  presentation: IVerifiablePresentation
  credentialType: string
}): IVerifiableCredential | null {
  const embedded = (presentation as { verifiableCredential?: unknown })
    .verifiableCredential
  const list = Array.isArray(embedded) ? embedded : embedded ? [embedded] : []
  for (const entry of list) {
    const types = (entry as { type?: string | string[] }).type
    const asArray = Array.isArray(types) ? types : [types]
    if (asArray.includes(credentialType)) {
      return entry as IVerifiableCredential
    }
  }
  return null
}
