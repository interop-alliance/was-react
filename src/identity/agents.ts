/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * WAS identity + per-collection vault-key derivation from a 32-byte master seed.
 *
 * SEED-DERIVATION CONVENTION (pinned, part of the shared-key contract): the
 * pinned `@interop/webkms-client` exposes `CapabilityAgent.fromSeed({ seed })`,
 * which takes the raw 32 bytes AS-IS (no hashing). We use it for BOTH the master
 * identity and the per-collection key-agreement keys, feeding raw bytes -- never
 * `fromSecret`, which salt-hashes a STRING and would derive a different key for
 * a byte array vs its text form.
 *
 * WHAT SELECTS THE KEY (verified against `CapabilityAgent.fromSeed`): the key
 * material is derived from the `seed` bytes (the HMAC key) and the `keyName`
 * string (the HMAC message) alone. The `handle` is stored on the returned agent
 * as a cosmetic identifier and does NOT enter key derivation -- nor the derived
 * did:key id, which is the fingerprint of the seed+keyName key pair. So the
 * PINNED derivation inputs are the seed bytes and the `keyName` values
 * (`IDENTITY_KEY_NAME` / `KAK_KEY_NAME` below); changing THOSE after first use
 * is a data-migration event. The `identityHandle` / `kakHandle` parameters are
 * safe to change and exist only so an app can supply a label for cosmetic
 * continuity; they do not affect the identity, keys, or any stored data.
 *
 * Per-collection KAKs derive via `HKDF-SHA256(master, info = 'kak:v1:<id>')` to
 * a 32-byte per-collection seed, then the standard Ed25519-to-X25519 path. HKDF
 * one-wayness means a shared per-collection key exposes nothing about the master
 * or sibling collections -- the future multi-app sharing unit.
 *
 * Not test-node-safe on React Native, but fine under Node/Vitest: the crypto
 * stack (`webkms-client`, `x25519-key-agreement-key`) runs on the standard Web
 * Crypto that Node 24 provides.
 */
import { CapabilityAgent } from '@interop/webkms-client'
import { Ed25519Signature2020 } from '@interop/ed25519-signature'
import { ZcapClient } from '@interop/ezcap'
import { X25519KeyAgreementKey2020 } from '@interop/x25519-key-agreement-key'
import type {
  IKeyAgreementKey,
  IKeyResolver
} from '@interop/data-integrity-core'

/**
 * Default cosmetic label for the master identity agent. Local naming only (does
 * not affect key material or the derived did:key); safe to override.
 */
export const DEFAULT_IDENTITY_HANDLE = 'was-react'

/**
 * Default cosmetic label for a per-collection key-agreement agent. Local naming
 * only (does not affect key material); safe to override.
 */
export const DEFAULT_KAK_HANDLE = 'was-react-kak'

// PINNED key-derivation inputs (the HMAC message that, with the seed, selects
// the key). Changing either after first use is a data-migration event.
const IDENTITY_KEY_NAME = 'app-key'
const KAK_KEY_NAME = 'kak'

/**
 * The agents derived from the master seed: the app's stable did:key controller,
 * its signing agent, and a ZcapClient for signing storage requests later.
 */
export interface IdentityAgents {
  controllerDid: string
  keyAgent: CapabilityAgent
  zcapClient: ZcapClient
}

/**
 * Derives one collection's X25519 key agreement key (KAK) plus its resolver, the
 * material the doc-cipher needs. The concrete KAK type carries `type` /
 * `publicKeyMultibase`; it is widened to `IKeyAgreementKey` only at the
 * boundary.
 */
export interface CollectionKeys {
  keyAgreementKey: IKeyAgreementKey
  keyResolver: IKeyResolver
}

/**
 * HKDF-SHA256 expansion of the master seed into a 32-byte per-context seed.
 *
 * @param master {Uint8Array}
 * @param info {string}   the domain-separation label (e.g. `kak:v1:projects`)
 * @returns {Promise<Uint8Array>}
 */
async function hkdfExpand(
  master: Uint8Array,
  info: string
): Promise<Uint8Array> {
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    master as unknown as BufferSource,
    'HKDF',
    false,
    ['deriveBits']
  )
  const bits = await globalThis.crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(info)
    },
    key,
    256
  )
  return new Uint8Array(bits)
}

/**
 * Derives the master identity agents from the master seed. The did:key
 * controller is stable across devices for the same seed.
 *
 * @param options {object}
 * @param options.seed {Uint8Array}   the 32-byte master seed
 * @param [options.identityHandle] {string}   cosmetic agent label; does not
 *   affect keys or the derived DID (defaults to `DEFAULT_IDENTITY_HANDLE`)
 * @returns {Promise<IdentityAgents>}
 */
export async function deriveIdentity({
  seed,
  identityHandle = DEFAULT_IDENTITY_HANDLE
}: {
  seed: Uint8Array
  identityHandle?: string
}): Promise<IdentityAgents> {
  const keyAgent = await CapabilityAgent.fromSeed({
    seed,
    handle: identityHandle,
    keyName: IDENTITY_KEY_NAME
  })
  const signer = keyAgent.getSigner()
  const zcapClient = new ZcapClient({
    SuiteClass: Ed25519Signature2020,
    invocationSigner: signer,
    delegationSigner: signer
  })
  return { controllerDid: keyAgent.id, keyAgent, zcapClient }
}

/**
 * Derives one collection's vault key material from the master seed:
 * `HKDF(master, 'kak:v1:<collectionId>')` to a per-collection seed, then the
 * Ed25519-to-X25519 (Montgomery-form) key-agreement key. Deterministic, so the
 * same seed decrypts the same envelopes on any device. Encryption uses these
 * per-collection KAKs from day one -- never share one KAK across collections.
 *
 * @param options {object}
 * @param options.seed {Uint8Array}       the 32-byte master seed
 * @param options.collectionId {string}   the WAS collection id (the HKDF label)
 * @param [options.kakHandle] {string}    cosmetic agent label; does not affect
 *   keys (defaults to `DEFAULT_KAK_HANDLE`)
 * @returns {Promise<CollectionKeys>}
 */
export async function deriveCollectionKeys({
  seed,
  collectionId,
  kakHandle = DEFAULT_KAK_HANDLE
}: {
  seed: Uint8Array
  collectionId: string
  kakHandle?: string
}): Promise<CollectionKeys> {
  const collectionSeed = await hkdfExpand(seed, `kak:v1:${collectionId}`)
  const keyAgent = await CapabilityAgent.fromSeed({
    seed: collectionSeed,
    handle: kakHandle,
    keyName: KAK_KEY_NAME
  })
  const keyAgreementKey =
    X25519KeyAgreementKey2020.fromEd25519VerificationKey2020({
      keyPair: keyAgent.getVerificationKeyPair()
    })
  const keyResolver: IKeyResolver = async ({ id }: { id?: string }) => {
    if (id !== keyAgreementKey.id) {
      throw new Error(`Unknown key id "${id}".`)
    }
    return {
      id: keyAgreementKey.id,
      type: keyAgreementKey.type,
      publicKeyMultibase: keyAgreementKey.publicKeyMultibase
    }
  }
  return {
    keyAgreementKey: keyAgreementKey as IKeyAgreementKey,
    keyResolver
  }
}
