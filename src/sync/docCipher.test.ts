/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Tests for the multi-recipient (key-epoch) behavior of `createDocCipher`, the
 * per-collection encrypt/decrypt seam. Uses the app's real deterministic
 * per-collection key (`deriveCollectionKeys`) as the recipient -- exactly the
 * key the wallet registers as the app's roster entry -- so the round-trip proves
 * the shared-key contract, not a synthetic key. A marker is minted with
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
import { deriveCollectionKeys } from '../identity/agents.js'
import { createDocCipher, isEncryptedEnvelope } from './docCipher.js'
import type { Json } from './types.js'

// A fixed 32-byte master seed drives deterministic per-collection derivation.
const SEED = new Uint8Array(32).map((_, index) => (index * 5 + 1) & 0xff)
const COLLECTION_ID = 'app-notes'

/**
 * Mints a one-epoch encryption marker whose sole recipient is the given
 * key-agreement key, via was-client's `initRecipients` driven against an
 * in-memory collection whose description write is a no-op CAS.
 */
async function mintMarker(
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
    const { keyAgreementKey, keyResolver } = await deriveCollectionKeys({
      seed: SEED,
      collectionId: COLLECTION_ID
    })
    const encryption = await mintMarker(keyAgreementKey)
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
    // The app's own deterministic key unwraps the epoch and recovers the doc.
    expect(await cipher.decrypt({ envelope })).toEqual(DOC)
  })

  it('still decrypts a pre-epoch (single-key) envelope when a marker is present', async () => {
    const { keyAgreementKey, keyResolver } = await deriveCollectionKeys({
      seed: SEED,
      collectionId: COLLECTION_ID
    })
    // A pre-epoch envelope: encrypted straight to the key-agreement key before
    // any roster existed (no marker).
    const singleKey = await createDocCipher({
      keyAgreementKey,
      keyResolver,
      collectionId: COLLECTION_ID
    })
    const { envelope } = await singleKey.encrypt({ data: DOC })

    // The epoch-aware cipher must still read it via the direct codec (a
    // permanent tolerance, not a migration).
    const encryption = await mintMarker(keyAgreementKey)
    const epochCipher = await createDocCipher({
      keyAgreementKey,
      keyResolver,
      collectionId: COLLECTION_ID,
      encryption
    })
    expect(await epochCipher.decrypt({ envelope })).toEqual(DOC)
  })
})
