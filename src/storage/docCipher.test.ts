/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Tests for the multi-recipient (key-epoch) behavior of `createDocCipher`, the
 * per-collection encrypt/decrypt seam. Uses the app's real identity
 * key-agreement key (`deriveIdentity`) as the recipient -- exactly the key the
 * wallet registers as the app's roster entry -- so the round-trip proves the
 * shared-key contract, not a synthetic key. A descriptor is minted with
 * was-client's own `initRecipients` against a tiny in-memory collection stub.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  createEdvEncryption,
  initRecipients,
  mintHmacKey,
  ownerRecipient,
  epochKeyIdFor,
  wrapEpochSecret
} from '@interop/was-client/edv'
import type {
  CollectionEncryption,
  ResourceMetadataCustom
} from '@interop/was-client'
import type {
  IKeyAgreementKey,
  IKeyResolver
} from '@interop/data-integrity-core'
import {
  isEncryptedEnvelope,
  isUnknownEpochError
} from '@interop/was-client/sync'
import { deriveIdentity } from '../identity/agents.js'
import { createDocCipher, createUnprovisionedDocCipher } from './docCipher.js'
import type { Json } from '@interop/was-sync'

// A fixed 32-byte master seed drives the deterministic identity derivation.
const SEED = new Uint8Array(32).map((_, index) => (index * 5 + 1) & 0xff)
const COLLECTION_ID = 'app-notes'

/**
 * Mints a one-epoch encryption descriptor whose sole recipient is the given
 * key-agreement key, via was-client's `initRecipients` driven against an
 * in-memory collection whose description write is a no-op CAS.
 */
async function mintDescriptor(
  keyAgreementKey: Parameters<typeof ownerRecipient>[0]['keyAgreementKey']
) {
  let description: Record<string, unknown> = {
    name: 'app-notes',
    encryption: { scheme: 'edv' }
  }
  const collection = {
    async describeWithEtag() {
      return { description: { ...description }, etag: 'etag-0' }
    },
    async replaceDescription(next: Record<string, unknown>) {
      description = next
    }
  }
  return initRecipients({
    collection: collection as unknown as Parameters<
      typeof initRecipients
    >[0]['collection'],
    recipients: [ownerRecipient({ keyAgreementKey })]
  })
}

const DOC: Json = { id: 'note-1', title: 'hello', body: { n: 42 } }

describe('createDocCipher (multi-recipient / key epochs)', () => {
  it('encrypts under the current epoch and round-trips through the epoch codec', async () => {
    const { keyAgreementKey, keyResolver } = await deriveIdentity({
      seed: SEED
    })
    const encryption = await mintDescriptor(keyAgreementKey)
    const cipher = await createDocCipher({
      keyAgreementKey,
      keyResolver,
      collectionId: COLLECTION_ID,
      encryption
    })

    const { envelope } = await cipher.encrypt({ data: DOC })
    expect(isEncryptedEnvelope(envelope)).toBe(true)
    // The envelope names the epoch key id as its recipient (not the bare vault
    // key), proving the write went under the current epoch.
    const kids = (
      envelope as { jwe: { recipients: Array<{ header: { kid: string } }> } }
    ).jwe.recipients.map(recipient => recipient.header.kid)
    expect(kids).toContain(epochKeyIdFor(encryption.currentEpoch as string))
    expect(kids).not.toContain(keyAgreementKey.id)
    // The app's own identity key unwraps the epoch and recovers the doc.
    expect(await cipher.decrypt({ envelope })).toEqual(DOC)
  })
})

/**
 * The same one-epoch descriptor with a blinded-index HMAC key installed -- the
 * searchable-collection fixture. The blinding key is distributed exactly like
 * an epoch key, so the same wrap builds it.
 *
 * @param keyAgreementKey {IKeyAgreementKey}   the sole recipient
 * @returns {Promise<CollectionEncryption>}
 */
async function mintIndexableDescriptor(
  keyAgreementKey: IKeyAgreementKey
): Promise<CollectionEncryption> {
  const encryption = await mintDescriptor(keyAgreementKey)
  const hmac = await mintHmacKey()
  return {
    ...encryption,
    hmac: {
      id: hmac.id,
      type: hmac.type,
      recipients: [
        await wrapEpochSecret({
          epochSecret: hmac.secret,
          recipient: ownerRecipient({ keyAgreementKey })
        })
      ]
    }
  }
}

/**
 * The stored `/meta` `custom` value a collection carrying this index schema
 * holds: the opaque metadata envelope, built through the very codec the direct
 * (Collection handle) path writes it with.
 *
 * @param options {object}
 * @param options.encryption {CollectionEncryption}
 * @param options.keys {object}   the reader's key material
 * @param options.keys.keyAgreementKey {IKeyAgreementKey}
 * @param options.keys.keyResolver {IKeyResolver}
 * @returns {Promise<unknown>}
 */
async function encodeIndexSchemaMeta({
  encryption,
  keys
}: {
  encryption: CollectionEncryption
  keys: { keyAgreementKey: IKeyAgreementKey; keyResolver: IKeyResolver }
}): Promise<unknown> {
  const provider = createEdvEncryption({ resolveKeys: async () => keys })
  const codec = await provider.codecFor({
    spaceId: 'space-1',
    collectionId: COLLECTION_ID,
    scheme: 'edv',
    encryption
  })
  if (!codec) {
    throw new Error('Expected an EDV codec for the descriptor.')
  }
  codec.indexing?.applySchema(INDEX_SCHEMA)
  const { custom } = await codec.encodeMeta({
    custom: { indexSchema: INDEX_SCHEMA } as unknown as ResourceMetadataCustom
  })
  return custom
}

const INDEX_SCHEMA = {
  revision: 1,
  indexes: [{ attribute: 'content.title', addedIn: 1 }]
}

/**
 * The blinded index entries of a stored envelope.
 *
 * @param envelope {Json}
 * @returns {unknown[]}
 */
function indexedOf(envelope: Json): unknown[] {
  return (envelope as { indexed?: unknown[] }).indexed ?? []
}

describe('createDocCipher (blinded index schema)', () => {
  it('emits blinded index entries on encrypt and encryptUpdate', async () => {
    const { keyAgreementKey, keyResolver } = await deriveIdentity({
      seed: SEED
    })
    const encryption = await mintIndexableDescriptor(keyAgreementKey)
    const custom = await encodeIndexSchemaMeta({
      encryption,
      keys: { keyAgreementKey, keyResolver }
    })
    const cipher = await createDocCipher({
      keyAgreementKey,
      keyResolver,
      collectionId: COLLECTION_ID,
      encryption,
      meta: { custom }
    })

    const first = await cipher.encrypt({ data: DOC })
    expect(indexedOf(first.envelope)).toHaveLength(1)
    // Blinded: neither the attribute nor its value travels in the clear.
    const serialized = JSON.stringify(indexedOf(first.envelope))
    expect(serialized).not.toContain('content.title')
    expect(serialized).not.toContain('hello')

    // The mutable-head update path indexes too.
    const updated = await cipher.encryptUpdate({
      id: first.id,
      data: { ...(DOC as object), title: 'goodbye' } as Json,
      current: first.envelope
    })
    expect(indexedOf(updated.envelope)).toHaveLength(1)
  })

  it('installs the schema after the build through applyMeta', async () => {
    const { keyAgreementKey, keyResolver } = await deriveIdentity({
      seed: SEED
    })
    const encryption = await mintIndexableDescriptor(keyAgreementKey)
    const custom = await encodeIndexSchemaMeta({
      encryption,
      keys: { keyAgreementKey, keyResolver }
    })
    const cipher = await createDocCipher({
      keyAgreementKey,
      keyResolver,
      collectionId: COLLECTION_ID,
      encryption
    })

    // Built without metadata: exactly what an offline replica wrote before.
    const before = await cipher.encrypt({ data: DOC })
    expect(indexedOf(before.envelope)).toEqual([])

    await cipher.applyMeta!({ custom })

    const after = await cipher.encrypt({ data: DOC })
    expect(indexedOf(after.envelope)).toHaveLength(1)
  })

  it('is a no-op on a descriptor with no blinded-index key', async () => {
    // No `hmac` means no blinding key at all, so applyMeta may be called
    // unconditionally.
    const { keyAgreementKey, keyResolver } = await deriveIdentity({
      seed: SEED
    })
    const encryption = await mintDescriptor(keyAgreementKey)
    const cipher = await createDocCipher({
      keyAgreementKey,
      keyResolver,
      collectionId: COLLECTION_ID,
      encryption
    })
    await expect(
      cipher.applyMeta!({ custom: undefined })
    ).resolves.toBeDefined()
    const { envelope } = await cipher.encrypt({ data: DOC })
    expect(indexedOf(envelope)).toEqual([])
    expect(await cipher.decrypt({ envelope })).toEqual(DOC)
  })
})

describe('createUnprovisionedDocCipher', () => {
  it('refuses writes and reports decrypts as unknown-epoch', async () => {
    const cipher = createUnprovisionedDocCipher({
      collectionId: COLLECTION_ID
    })
    await expect(cipher.encrypt({ data: DOC })).rejects.toThrow(
      /no key-epoch encryption descriptor/
    )
    await expect(
      cipher.encryptUpdate({ id: 'row-1', data: DOC, current: DOC })
    ).rejects.toThrow(/no key-epoch encryption descriptor/)
    // The decrypt signal is the SAME one a stale descriptor produces, so the
    // store's unknown-epoch recovery re-reads the descriptor and retries.
    const decrypt = cipher.decrypt({ envelope: { any: 'thing' } })
    await expect(decrypt).rejects.toSatisfy(isUnknownEpochError)
  })
})
