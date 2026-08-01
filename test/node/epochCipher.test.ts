/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Tests the epoch-aware read path on the local store: a private collection
 * opened single-key (no cached descriptor) that meets an envelope written under a
 * key epoch it has not seen (a rotation on another device) recovers by re-
 * reading the descriptor exactly once and rebuilding the cipher. Uses the app's
 * real identity key-agreement key as the roster recipient, so the rebuilt
 * cipher genuinely unwraps the epoch.
 *
 * @vitest-environment node
 */
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initRecipients, ownerRecipient } from '@interop/was-client/edv'
import type { CollectionEncryption } from '@interop/was-client'
import { LocalStore } from '../../src/storage/localStore.js'
import { createDocCipher, type Json } from '../../src/sync/index.js'
import { deriveIdentity } from '../../src/identity/agents.js'
import type { WasCollectionConfig } from '../../src/config.js'

const COLLECTIONS: WasCollectionConfig[] = [{ key: 'notes', id: 'notes' }]
const COLLECTION_KEY = 'notes'
const COLLECTION_ID = 'notes'
const SEED = new Uint8Array(32).map((_, index) => (index * 9 + 2) & 0xff)

let dbCounter = 0
const openStores: LocalStore[] = []

async function openStore(
  descriptors?: Record<string, CollectionEncryption>
): Promise<LocalStore> {
  const { keyAgreementKey, keyResolver } = await deriveIdentity({ seed: SEED })
  const store = await LocalStore.init({
    keyAgreementKey,
    keyResolver,
    collections: COLLECTIONS,
    dbName: `epoch-test-${dbCounter++}`,
    ...(descriptors && { descriptors })
  })
  openStores.push(store)
  return store
}

/**
 * Mints a one-epoch descriptor whose sole recipient is the app's identity key.
 */
async function mintDescriptor(): Promise<CollectionEncryption> {
  const { keyAgreementKey } = await deriveIdentity({ seed: SEED })
  let description: Record<string, unknown> = {
    name: 'notes',
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

afterEach(async () => {
  while (openStores.length > 0) {
    await openStores.pop()!.remove()
  }
})

describe('LocalStore epoch-descriptor refresh', () => {
  it('recovers from an unknown epoch with a single descriptor re-fetch', async () => {
    // Build an epoch envelope with the descriptor cipher (what another device wrote).
    const encryption = await mintDescriptor()
    const { keyAgreementKey, keyResolver } = await deriveIdentity({
      seed: SEED
    })
    const descriptorCipher = await createDocCipher({
      keyAgreementKey,
      keyResolver,
      collectionId: COLLECTION_ID,
      encryption
    })
    const payload = { id: 'note-1', title: 'from another device' }
    const { id, envelope } = await descriptorCipher.encrypt({ data: payload })

    // Open a store WITHOUT the descriptor (single-key) and drop the epoch envelope
    // straight into its RxDB collection, as replication would.
    const store = await openStore()
    await store.rxCollection(COLLECTION_KEY).insert({
      id,
      updatedAt: new Date().toISOString(),
      version: 0,
      data: envelope as unknown as Json
    })

    // A refresher that hands back the descriptor; the single-key cipher hits an
    // UnknownEpochError, refreshes once, rebuilds, and decrypts.
    const refresher = vi.fn(async () => encryption)
    store.setEpochRefresher(refresher)

    const listed = await store.listEntities<{ id: string; title: string }>(
      COLLECTION_KEY
    )
    expect(listed).toEqual([payload])
    expect(refresher).toHaveBeenCalledTimes(1)
    expect(refresher).toHaveBeenCalledWith(COLLECTION_ID)
  })

  it('opens epoch-aware from a cached descriptor (no refresh needed)', async () => {
    const encryption = await mintDescriptor()
    const store = await openStore({ [COLLECTION_ID]: encryption })
    const refresher = vi.fn(async () => encryption)
    store.setEpochRefresher(refresher)

    await store.insertEntity(COLLECTION_KEY, { id: 'note-2', title: 'local' })
    const listed = await store.listEntities<{ id: string; title: string }>(
      COLLECTION_KEY
    )
    expect(listed).toEqual([{ id: 'note-2', title: 'local' }])
    // The write already went under the current epoch, so no refresh fired.
    expect(refresher).not.toHaveBeenCalled()
  })

  it('applyRemoteDescriptor rebuilds only when the epoch changes', async () => {
    const encryption = await mintDescriptor()
    const store = await openStore({ [COLLECTION_ID]: encryption })
    // Same descriptor: no rebuild.
    expect(
      await store.applyRemoteDescriptor({
        collectionId: COLLECTION_ID,
        encryption
      })
    ).toBe(false)
    // Unknown collection id: ignored.
    expect(
      await store.applyRemoteDescriptor({ collectionId: 'nope', encryption })
    ).toBe(false)
  })
})
