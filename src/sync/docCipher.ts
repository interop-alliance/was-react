/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The per-collection EDV document cipher: the local encrypt/decrypt seam. It
 * wraps the same `@interop/was-client` EDV codec the remote WAS handles use,
 * pointed at the local replica: `encrypt` turns a JSON document into its stored
 * EDV envelope (`{ id, sequence, jwe }`) minting a stable random resource id
 * (`idDerivation: 'random'`), and `encryptUpdate` re-encrypts a mutable head
 * document under its EXISTING id, advancing the envelope `sequence` from the
 * prior envelope. `decrypt` reverses it. The sync layer moves the envelope
 * verbatim; it never touches these keys.
 *
 * A PUBLIC (plaintext) collection uses {@link createPlaintextDocCodec} instead:
 * the same {@link DocCipher} seam with pass-through implementations, so the
 * storage layer above needs no encrypted-vs-plaintext fork.
 */
import type {
  IKeyAgreementKey,
  IKeyResolver
} from '@interop/data-integrity-core'
import type { CollectionEncryption } from '@interop/was-client'
import { createEdvDocCipher, UnknownEpochError } from '@interop/was-client/edv'
import { isEncryptedEnvelope } from '@interop/was-client/sync'
import type { Json } from './types.js'

/**
 * Whether an error is the EDV codec's `UnknownEpochError` -- a stored envelope
 * naming a JWE recipient this cipher cannot route, which is the signal to
 * re-read the collection's encryption descriptor and rebuild the cipher.
 *
 * The `name` check is not belt-and-braces: a cipher built by
 * `@interop/wallet-core` throws that package's OWN instance of the class (its
 * dependency tree resolves a second physical copy of `@interop/was-client`, so
 * the constructor is a different function object and `instanceof` is false
 * here). The class sets `this.name`, which is stable across copies. Once the
 * two copies dedupe from the npm registry the `instanceof` arm alone would
 * suffice, and the `name` arm is harmless.
 *
 * @param err {unknown}
 * @returns {boolean}
 */
export function isUnknownEpochError(err: unknown): boolean {
  return (
    err instanceof UnknownEpochError ||
    (err instanceof Error && err.name === 'UnknownEpochError')
  )
}

/**
 * A per-collection document cipher. `encrypt` is the create path (mints a random
 * envelope id); `encryptUpdate` is the in-place update path (re-encrypts under
 * an existing id, advancing `sequence` from the prior envelope); `decrypt`
 * reverses either. A multi-recipient (key-epoch) cipher also surfaces the
 * `epoch` id it encrypted under, which rides the content push as the
 * `WAS-Key-Epoch` header; a single-recipient cipher (and the plaintext codec)
 * returns none.
 */
export interface DocCipher {
  encrypt(options: {
    data: Json
  }): Promise<{ id: string; envelope: Json; epoch?: string }>
  encryptUpdate(options: {
    id: string
    data: Json
    current: Json
  }): Promise<{ id: string; envelope: Json; epoch?: string }>
  decrypt(options: { envelope: Json }): Promise<Json>
}

/**
 * Builds the pass-through codec for a PUBLIC (plaintext) collection: payloads
 * are stored as-is, and the stored resource id IS the payload's logical `id`
 * (uuid). With nothing to hide there is no reason for a second, opaque id
 * plane, and a public document then keeps a stable, shareable resource URL
 * across edits. `decrypt` refuses an EDV envelope (via
 * {@link isEncryptedEnvelope}) rather than mis-reading its random envelope id
 * as a logical uuid -- a public collection holding ciphertext rows is a
 * visibility misconfiguration, surfaced as a read error instead of silent
 * garbage.
 *
 * @param options {object}
 * @param options.collectionId {string}   labels errors only
 * @returns {DocCipher}
 */
export function createPlaintextDocCodec({
  collectionId
}: {
  collectionId: string
}): DocCipher {
  const payloadId = (data: Json): string => {
    const id = (data as { id?: unknown } | null)?.id
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(
        `Plaintext write to collection "${collectionId}" carries no string "id".`
      )
    }
    return id
  }
  const assertPlaintext = (body: Json): Json => {
    if (isEncryptedEnvelope(body)) {
      throw new Error(
        `Collection "${collectionId}" is public (plaintext) but the stored ` +
          `row is an EDV envelope.`
      )
    }
    return body
  }

  return {
    async encrypt({ data }: { data: Json }) {
      return { id: payloadId(data), envelope: data }
    },

    async encryptUpdate({ id, data }: { id: string; data: Json }) {
      return { id, envelope: data }
    },

    async decrypt({ envelope }: { envelope: Json }) {
      return assertPlaintext(envelope)
    }
  }
}

/**
 * Builds a {@link DocCipher} for one collection from the caller's derived key
 * material (the app's identity X25519 key agreement key, the same one every
 * other collection uses). Keys are supplied directly (no
 * keystore lookup). `idDerivation: 'random'` mints a stable random id updated in
 * place via `sequence` -- the mutable head-document model every entity here uses
 * (constant bump / toggle / re-categorize edits).
 *
 * Delegates to `@interop/was-client`'s `createEdvDocCipher`: with no
 * `encryption` descriptor (or a descriptor with no key epochs) the cipher is
 * single-recipient (the key-agreement key encrypts and decrypts directly, the
 * behavior every collection has had); with epochs on the descriptor the cipher
 * becomes multi-recipient -- writes stamp the descriptor's current epoch and reads
 * route by the envelope's recipient key id, while a pre-epoch envelope still
 * decrypts through the single-key path (a permanent tolerance, not a migration
 * shim). The returned cipher's shape matches {@link DocCipher} exactly; only the
 * nominal `Json` origin differs, so it crosses the boundary with a cast.
 *
 * @param options {object}
 * @param options.keyAgreementKey {IKeyAgreementKey}
 * @param options.keyResolver {IKeyResolver}
 * @param options.collectionId {string}   labels errors; the codec is agnostic
 * @param [options.encryption] {CollectionEncryption}   the collection's
 *   encryption descriptor; when it carries key epochs the cipher becomes
 *   multi-recipient
 * @returns {Promise<DocCipher>}
 */
export async function createDocCipher({
  keyAgreementKey,
  keyResolver,
  collectionId,
  encryption
}: {
  keyAgreementKey: IKeyAgreementKey
  keyResolver: IKeyResolver
  collectionId: string
  encryption?: CollectionEncryption
}): Promise<DocCipher> {
  const cipher = await createEdvDocCipher({
    keyAgreementKey,
    keyResolver,
    collectionId,
    idDerivation: 'random',
    ...(encryption && { encryption })
  })
  return cipher as unknown as DocCipher
}
