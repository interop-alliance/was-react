/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * WAS master-identity derivation from a 32-byte master seed.
 *
 * SEED-DERIVATION CONVENTION (pinned, part of the shared-key contract): the
 * pinned `@interop/webkms-client` exposes `CapabilityAgent.fromSeed({ seed })`,
 * which takes the raw 32 bytes AS-IS (no hashing). We use it for the master
 * identity, feeding raw bytes -- never `fromSecret`, which salt-hashes a STRING
 * and would derive a different key for a byte array vs its text form.
 *
 * WHAT SELECTS THE KEY (verified against `CapabilityAgent.fromSeed`): the key
 * material is derived from the `seed` bytes (the HMAC key) and the `keyName`
 * string (the HMAC message) alone. The `handle` is stored on the returned agent
 * as a cosmetic identifier and does NOT enter key derivation -- nor the derived
 * did:key id, which is the fingerprint of the seed+keyName key pair. So the
 * PINNED derivation inputs are the seed bytes and the `keyName` value
 * (`IDENTITY_KEY_NAME` below); changing THAT after first use is a data-migration
 * event. The `identityHandle` parameter is safe to change and exists only so an
 * app can supply a label for cosmetic continuity; it does not affect the
 * identity, keys, or any stored data.
 *
 * TWO DISTINCT KEY IDENTITIES live in this area, and they must not be confused:
 *
 * - the app's IDENTITY key-agreement key (KAK), derived here as the X25519 twin
 *   of the did:key controller. One per app identity. It is what a wallet writes
 *   into the key-epoch roster when it SHARES one of its own encrypted
 *   collections with this app;
 * - a PER-COLLECTION KAK (`deriveCollectionKeys`), derived by HKDF from the
 *   master seed under the collection id. One per app-owned collection, used for
 *   the collections the app itself provisions.
 *
 * The per-collection key-agreement (KAK) derivation now lives in
 * `@interop/wallet-core/identity` (`deriveCollectionKeys`, along with its pinned
 * HKDF derivation inputs) and is re-exported here for compatibility.
 *
 * Not test-node-safe on React Native, but fine under Node/Vitest: the crypto
 * stack (`webkms-client`, `x25519-key-agreement-key`) runs on the standard Web
 * Crypto that Node 24 provides.
 */
import { CapabilityAgent } from '@interop/webkms-client'
import { Ed25519Signature2020 } from '@interop/ed25519-signature'
import { ZcapClient } from '@interop/ezcap'
import { X25519KeyAgreementKey2020 } from '@interop/x25519-key-agreement-key'
import { singleKeyResolver } from '@interop/wallet-core/identity'
import type {
  IKeyAgreementKey,
  IKeyResolver
} from '@interop/data-integrity-core'

/**
 * The per-collection vault-key (KAK) derivation, its result type, and its
 * default cosmetic handle now live in `@interop/wallet-core/identity` (moved
 * there verbatim, with their pinned `kak:v1:<collectionId>` HKDF derivation
 * inputs); re-exported here so existing imports keep working.
 */
export {
  deriveCollectionKeys,
  DEFAULT_KAK_HANDLE,
  type CollectionKeys
} from '@interop/wallet-core/identity'

/**
 * Default cosmetic label for the master identity agent. Local naming only (does
 * not affect key material or the derived did:key); safe to override.
 */
export const DEFAULT_IDENTITY_HANDLE = 'was-react'

// PINNED key-derivation input (the HMAC message that, with the seed, selects
// the key). Changing it after first use is a data-migration event.
const IDENTITY_KEY_NAME = 'app-key'

/**
 * The agents derived from the master seed: the app's stable did:key controller,
 * its signing agent, a ZcapClient for signing storage requests later, and the
 * app's IDENTITY key-agreement key (KAK) plus its resolver.
 *
 * The identity KAK is the X25519 twin (Montgomery form) of the did:key
 * controller's Ed25519 key -- ONE key for the whole app identity, not one per
 * collection. It is the recipient identity a wallet writes into the key-epoch
 * roster of a collection it SHARES with this app (the wallet derives the same
 * key from the controller did:key alone, so the `id` / `publicKeyMultibase`
 * match byte-for-byte and nothing has to travel on the wire).
 *
 * Do not confuse it with `deriveCollectionKeys`, which is a DIFFERENT key
 * identity: a per-collection KAK derived by HKDF from the seed, used for the
 * app's OWN (app-provisioned) collections. Shared, wallet-owned collections use
 * the identity KAK below; app-owned collections use the per-collection KAK.
 */
export interface IdentityAgents {
  controllerDid: string
  keyAgent: CapabilityAgent
  zcapClient: ZcapClient
  /**
   * The app's identity KAK: the X25519 twin of its did:key controller.
   */
  keyAgreementKey: IKeyAgreementKey
  /**
   * The one-key resolver answering for {@link IdentityAgents.keyAgreementKey}.
   */
  keyResolver: IKeyResolver
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
  // The identity KAK: the Ed25519-to-X25519 (Montgomery) conversion of the
  // controller key pair -- the same conversion a wallet applies to the
  // controller did:key when it writes this app into a shared collection's
  // epoch roster.
  const keyAgreementKey =
    X25519KeyAgreementKey2020.fromEd25519VerificationKey2020({
      keyPair: keyAgent.getVerificationKeyPair()
    }) as unknown as IKeyAgreementKey
  const keyResolver = singleKeyResolver({ keyAgreementKey })
  return {
    controllerDid: keyAgent.id,
    keyAgent,
    zcapClient,
    keyAgreementKey,
    keyResolver
  }
}
