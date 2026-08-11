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
  initRecipients,
  ownerRecipient,
  epochKeyIdFor
} from '@interop/was-client/edv'
import { isEncryptedEnvelope } from '@interop/was-client/sync'
import { deriveIdentity } from '../identity/agents.js'
import {
  createDocCipher,
  createUnprovisionedDocCipher,
  hasKeyEpochs,
  isUnknownEpochError
} from './docCipher.js'
import type { Json } from './types.js'

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

describe('hasKeyEpochs', () => {
  it('accepts only an epoch-bearing descriptor', async () => {
    const { keyAgreementKey } = await deriveIdentity({ seed: SEED })
    const encryption = await mintDescriptor(keyAgreementKey)
    expect(hasKeyEpochs(encryption)).toBe(true)
    expect(hasKeyEpochs(undefined)).toBe(false)
    // A bare declaration with no roster cannot build a cipher.
    expect(hasKeyEpochs({ scheme: 'edv' })).toBe(false)
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
