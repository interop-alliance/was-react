/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Regression tests for the serialized boot/destroy lifecycle. A fast
 * unmount/remount of the session provider (React dev-mode double effects) fires
 * `boot` -> `destroy` -> `boot` while the first boot is still opening the
 * replica. Before serialization, the first boot's continuations (open, hydrate,
 * start sync) raced the destroy's teardown: an aborted boot could resurrect a
 * torn-down session, install a closed/duplicate replica as the process-wide
 * holder, or hydrate against a store that was being torn down.
 *
 * These tests drive that interleaving deterministically with an INJECTED
 * storage whose first RxDB open is deferrable: parking a boot inside
 * `LocalStore.init` (before it installs the holder) lets a `destroy` -- and then
 * a second `boot` -- run at a precisely controlled point, exactly the window the
 * provider's mount/cleanup/mount effect opens.
 *
 * @vitest-environment node
 */
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { getRxStorageDexie } from 'rxdb/plugins/storage-dexie'
import type { RxStorage } from 'rxdb/plugins/core'
import {
  createAuthStore,
  type WasAuthStore
} from '../../src/session/authStore.js'
import {
  createSeedStore,
  type SeedStore
} from '../../src/identity/seedStore.js'
import { hasStore, requireStore } from '../../src/storage/storageManager.js'
import { useSyncStatusStore } from '../../src/storage/syncStatusStore.js'
import type { StoreRegistry, WasAppConfig } from '../../src/config.js'

// Inert replication: the lifecycle logic runs without any network machinery.
vi.mock('../../src/storage/wasSync.js', () => ({
  startWasSync: vi.fn(async () => ({}))
}))

const registry: StoreRegistry = {}

function baseConfig(): WasAppConfig {
  return {
    appName: 'Test App',
    appOrigin: 'http://localhost:5173',
    collections: [{ key: 'notes', id: 'notes' }],
    credential: {
      credentialType: 'TestAppKey',
      vocabBase: 'urn:test-app:vocab#'
    },
    // A unique base name per config so the RxDB databases never collide across
    // tests sharing the one process-wide fake-indexeddb.
    dbName: `was-react-${Math.random().toString(36).slice(2)}`
  }
}

function newSeedStore(): SeedStore {
  return createSeedStore({
    dbName: `was-react-session-${Math.random().toString(36).slice(2)}`,
    idb: new IDBFactory()
  })
}

/**
 * Wraps the real Dexie storage so the FIRST `createStorageInstance` call (the
 * first boot's `LocalStore.init`, before it installs the holder) parks on a
 * release gate. `entered` resolves once the boot is parked; `release()` lets it
 * proceed. Every later open passes straight through.
 */
function gatedStorage(): {
  storage: RxStorage<unknown, unknown>
  entered: Promise<void>
  release: () => void
} {
  const base = getRxStorageDexie()
  let hold = true
  let markEntered!: () => void
  const entered = new Promise<void>(resolve => (markEntered = resolve))
  let release!: () => void
  const releaseP = new Promise<void>(resolve => (release = resolve))
  const storage = {
    ...base,
    createStorageInstance: async (
      params: Parameters<typeof base.createStorageInstance>[0]
    ) => {
      if (hold) {
        hold = false
        markEntered()
        await releaseP
      }
      return base.createStorageInstance(params)
    }
  } as unknown as RxStorage<unknown, unknown>
  return { storage, entered, release }
}

// Track created stores so their expiry-watch intervals never outlive a test.
const liveStores: WasAuthStore[] = []

function makeStore(
  config: WasAppConfig,
  seedStore: SeedStore,
  storage?: RxStorage<unknown, unknown>
): WasAuthStore {
  const store = createAuthStore({
    config,
    registry,
    seedStore,
    ...(storage && { storage })
  })
  liveStores.push(store)
  return store
}

afterEach(async () => {
  while (liveStores.length > 0) {
    await liveStores.pop()!.getState().destroy()
  }
  useSyncStatusStore.getState().reset()
  vi.restoreAllMocks()
})

describe('serialized boot/destroy lifecycle', () => {
  it('a destroy fired during an in-flight boot wins: the aborted boot never resurrects', async () => {
    const config = baseConfig()
    const { storage, entered, release } = gatedStorage()
    const store = makeStore(config, newSeedStore(), storage)

    // Mount: boot begins and parks inside `LocalStore.init`, before it installs
    // the process-wide holder.
    const booting = store.getState().boot()
    await entered

    // Cleanup: destroy fires while that boot is still in flight, then the boot
    // is allowed to finish. Serialized, destroy must win -- the aborted boot may
    // not re-open the replica or leave `boot` behind its back.
    const destroying = store.getState().destroy()
    release()
    await Promise.all([booting, destroying])

    expect(store.getState().status).toBe('boot')
    expect(hasStore()).toBe(false)
    expect(store.getState().error).toBeNull()

    // And the session re-boots cleanly on top of the teardown.
    await store.getState().boot()
    expect(store.getState().status).toBe('local')
    expect(hasStore()).toBe(true)
    expect(await requireStore().listEntities('notes')).toHaveLength(0)
  })

  it('a mount/cleanup/mount double-boot lands on an open, usable holder', async () => {
    const config = baseConfig()
    const { storage, entered, release } = gatedStorage()
    const store = makeStore(config, newSeedStore(), storage)

    // The provider's StrictMode shape: boot (mount) -> destroy (cleanup) ->
    // boot (remount), with the first boot still parked inside `LocalStore.init`.
    const boot1 = store.getState().boot()
    await entered
    const destroying = store.getState().destroy()
    const boot2 = store.getState().boot()
    release()
    await Promise.all([boot1, destroying, boot2])

    // The status correctly left `boot`, and the holder is a single OPEN replica
    // (never a closed duplicate): a write + read round trip succeeds.
    expect(store.getState().status).toBe('local')
    expect(store.getState().error).toBeNull()
    expect(hasStore()).toBe(true)
    const id = crypto.randomUUID()
    await requireStore().insertEntity('notes', { id, title: 'after-remount' })
    const rows = await requireStore().listEntities<{
      id: string
      title: string
    }>('notes')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.title).toBe('after-remount')
  })

  it('persisted local data survives a double-boot and is still hydrated after', async () => {
    const config = baseConfig()
    const seedStore = newSeedStore()

    // Seed the anonymous replica with a document via a clean first session.
    const seeder = makeStore(config, seedStore)
    await seeder.getState().boot()
    const noteId = crypto.randomUUID()
    await requireStore().insertEntity('notes', { id: noteId, title: 'kept' })
    await seeder.getState().destroy()

    // A fresh store over the SAME persisted anon seed, driven through the
    // mount/cleanup/mount interleaving with the first boot parked mid-open.
    const { storage, entered, release } = gatedStorage()
    const store = makeStore(config, seedStore, storage)
    const boot1 = store.getState().boot()
    await entered
    const destroying = store.getState().destroy()
    const boot2 = store.getState().boot()
    release()
    await Promise.all([boot1, destroying, boot2])

    // The double-boot landed on an open holder that still reads the persisted
    // document (no empty-looking hydrate against a torn-down/duplicate store).
    expect(store.getState().status).toBe('local')
    expect(store.getState().error).toBeNull()
    expect(hasStore()).toBe(true)
    const rows = await requireStore().listEntities<{
      id: string
      title: string
    }>('notes')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe(noteId)
    expect(rows[0]!.title).toBe('kept')
  })
})
