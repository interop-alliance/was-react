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
 */
import type {
  IKeyAgreementKey,
  IKeyResolver
} from '@interop/data-integrity-core'
import { createEdvEncryption } from '@interop/was-client/edv'
import type { Json } from './types.js'

/**
 * A per-collection document cipher. `encrypt` is the create path (mints a random
 * envelope id); `encryptUpdate` is the in-place update path (re-encrypts under
 * an existing id, advancing `sequence` from the prior envelope); `decrypt`
 * reverses either.
 */
export interface DocCipher {
  encrypt(options: { data: Json }): Promise<{ id: string; envelope: Json }>
  encryptUpdate(options: {
    id: string
    data: Json
    current: Json
  }): Promise<{ id: string; envelope: Json }>
  decrypt(options: { envelope: Json }): Promise<Json>
}

/**
 * Whether a stored body is an EDV encryption envelope (carries an object `jwe`)
 * rather than plaintext. Lets read paths stay tolerant of any legacy plaintext
 * row.
 *
 * @param data {Json | undefined}
 * @returns {boolean}
 */
export function isEncryptedEnvelope(data: Json | undefined): boolean {
  if (data === undefined || data === null || typeof data !== 'object') {
    return false
  }
  const jwe = (data as { jwe?: unknown }).jwe
  return jwe !== null && typeof jwe === 'object'
}

/**
 * Builds a {@link DocCipher} for one collection from its derived key material
 * (the per-collection X25519 key agreement key). Keys are supplied directly (no
 * keystore lookup). `idDerivation: 'random'` mints a stable random id updated in
 * place via `sequence` -- the mutable head-document model every entity here uses
 * (constant bump / toggle / re-categorize edits).
 *
 * @param options {object}
 * @param options.keyAgreementKey {IKeyAgreementKey}
 * @param options.keyResolver {IKeyResolver}
 * @param options.collectionId {string}   labels errors; the codec is agnostic
 * @returns {Promise<DocCipher>}
 */
export async function createDocCipher({
  keyAgreementKey,
  keyResolver,
  collectionId
}: {
  keyAgreementKey: IKeyAgreementKey
  keyResolver: IKeyResolver
  collectionId: string
}): Promise<DocCipher> {
  const provider = createEdvEncryption({
    resolveKeys: async () => null,
    idDerivation: 'random'
  })
  const codec = await provider.codecFor({
    spaceId: 'local',
    collectionId,
    scheme: 'edv',
    keys: { keyAgreementKey, keyResolver }
  })
  if (!codec) {
    throw new Error(
      `Could not build the EDV cipher for collection "${collectionId}".`
    )
  }

  // Parses the codec's `EncodedWrite` (id + envelope body bytes) into the
  // stored `{ id, envelope }` shape. Shared by the create and update paths.
  const readEncoded = (encoded: {
    id?: string
    body?: Uint8Array | Blob
  }): { id: string; envelope: Json } => {
    if (
      typeof encoded.id !== 'string' ||
      !(encoded.body instanceof Uint8Array)
    ) {
      throw new Error(
        `EDV encrypt for collection "${collectionId}" returned no id/envelope body.`
      )
    }
    const envelope = JSON.parse(new TextDecoder().decode(encoded.body)) as Json
    return { id: encoded.id, envelope }
  }

  return {
    async encrypt({ data }: { data: Json }) {
      // `encode` with no caller id is the create path: encrypt, then use the
      // minted random id.
      const encoded = await codec.encode({
        data: data as Extract<Json, object>
      })
      return readEncoded(encoded)
    },

    async encryptUpdate({
      id,
      data,
      current
    }: {
      id: string
      data: Json
      current: Json
    }) {
      // The update path: hand the codec the prior stored envelope so it advances
      // `sequence` from it and re-encrypts under the same id. The codec reads
      // `current.data` (the prior envelope) and its `etag` header (unused here;
      // the wire `If-Match` is derived from the synced-doc `version`, not this).
      const priorResponse = {
        data: current,
        json: async () => current,
        headers: { get: () => null }
      } as unknown as Parameters<typeof codec.encode>[0]['current']
      const encoded = await codec.encode({
        id,
        data: data as Extract<Json, object>,
        current: priorResponse
      })
      return readEncoded(encoded)
    },

    async decrypt({ envelope }: { envelope: Json }) {
      const response = {
        data: envelope,
        json: async () => envelope
      } as unknown as Parameters<typeof codec.decode>[0]
      return (await codec.decode(response)) as Json
    }
  }
}
