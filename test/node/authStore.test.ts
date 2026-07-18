/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Unit tests for the four-state session machine, driving a real seed-derived
 * identity and a real (fake-indexeddb) LocalStore open, with the live
 * replication bootstrap (`startWasSync`) mocked to an inert no-op. Covers the
 * boot / local / connect / logout / clear-data transitions:
 *
 * - `boot()` with nothing persisted lands `local` (a fresh anonymous seed is
 *   persisted, the replica is opened, the entity stores hydrate empty);
 * - `boot()` with a valid persisted session lands `connected`;
 * - the anonymous seed (and DID) is stable across a second `boot()`;
 * - `connectWithGrants` and a (mocked-wallet) `login()` transition
 *   `local -> connected`, tearing down the anonymous replica but leaving its
 *   seed intact; a cancelled `login()` leaves `local` intact;
 * - `logout({ wipe })` keeps vs deletes the connected replica, landing `local`;
 * - `clearLocalData()` mints a brand-new anonymous seed/DID and empties stores.
 *
 * @vitest-environment node
 */
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import type { IZcap } from '@interop/data-integrity-core'
import {
  createAuthStore,
  type WasAuthStore
} from '../../src/session/authStore.js'
import {
  createSeedStore,
  type SeedStore
} from '../../src/identity/seedStore.js'
import { initAppSession } from '../../src/identity/initAppSession.js'
import { persistAppSession } from '../../src/identity/appSession.js'
import { parseGrants } from '../../src/grants.js'
import {
  loginWithWallet,
  LoginCancelledError
} from '../../src/auth/loginFlow.js'
import { hasStore, requireStore } from '../../src/storage/storageManager.js'
import { useSyncStatusStore } from '../../src/storage/syncStatusStore.js'
import type { StoreRegistry, WasAppConfig } from '../../src/config.js'

// Inert replication: the machine's activate / persist / teardown logic runs
// without opening any network or `window`-backed replication machinery.
vi.mock('../../src/storage/wasSync.js', () => ({
  startWasSync: vi.fn(async () => ({}))
}))

// Keep the real login flow but make the wallet step controllable per test.
vi.mock('../../src/auth/loginFlow.js', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../../src/auth/loginFlow.js')>()
  return { ...actual, loginWithWallet: vi.fn() }
})

const loginWithWalletMock = vi.mocked(loginWithWallet)

const registry: StoreRegistry = {}

// Well beyond the default 1h near-expiry warning, so the watch never fires.
const FAR_FUTURE_MS = 4 * 60 * 60 * 1000

function futureIso(ms: number): string {
  return new Date(Date.now() + ms).toISOString()
}

function baseConfig(): WasAppConfig {
  return {
    appName: 'Test App',
    appOrigin: 'http://localhost:5173',
    collections: [{ key: 'notes', id: 'notes' }],
    credential: {
      credentialType: 'TestAppKey',
      vocabBase: 'urn:test-app:vocab#'
    },
    // A unique base name per config so the RxDB / IndexedDB databases never
    // collide across tests sharing the one process-wide fake-indexeddb.
    dbName: `was-react-${Math.random().toString(36).slice(2)}`
  }
}

function newSeedStore(): SeedStore {
  return createSeedStore({
    dbName: `was-react-session-${Math.random().toString(36).slice(2)}`,
    idb: new IDBFactory()
  })
}

function noteGrants(): IZcap[] {
  return [
    {
      id: 'urn:zcap:notes',
      invocationTarget: 'http://localhost:3999/space/space-1/notes'
    }
  ] as unknown as IZcap[]
}

// Track created stores so their expiry-watch intervals never outlive a test.
const liveStores: WasAuthStore[] = []

function makeStore(config: WasAppConfig, seedStore: SeedStore): WasAuthStore {
  const store = createAuthStore({ config, registry, seedStore })
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

/**
 * Persists a valid, matching session record for `seedStore` so a `boot()`
 * restores it. Returns the seed + identity that back it.
 */
async function persistSession({
  seedStore,
  grants = noteGrants(),
  expires = futureIso(FAR_FUTURE_MS)
}: {
  seedStore: SeedStore
  grants?: IZcap[]
  expires?: string
}): Promise<{ seed: Uint8Array; controllerDid: string }> {
  const seed = crypto.getRandomValues(new Uint8Array(32))
  const identity = await initAppSession({ seed })
  await persistAppSession({
    session: {
      seed,
      controllerDid: identity.controllerDid,
      serverUrl: 'http://localhost:3999',
      spaceId: 'space-1',
      grants,
      expires
    },
    store: seedStore
  })
  return { seed, controllerDid: identity.controllerDid }
}

describe('boot()', () => {
  it('falls to local with a fresh anonymous replica when nothing is persisted', async () => {
    const config = baseConfig()
    const store = makeStore(config, newSeedStore())

    await store.getState().boot()

    expect(store.getState().status).toBe('local')
    expect(store.getState().controllerDid).toMatch(/^did:key:/)
    expect(store.getState().expires).toBeNull()
    // The replica is open and the entity stores hydrated empty.
    expect(hasStore()).toBe(true)
    expect(await requireStore().listEntities('notes')).toHaveLength(0)
    // The anonymous seed was minted and persisted in `<dbName>-anon`.
    const anon = createSeedStore({ dbName: `${config.dbName}-anon` })
    expect(await anon.loadSeed()).not.toBeNull()
  })

  it('is a no-op once the status has left boot', async () => {
    const store = makeStore(baseConfig(), newSeedStore())
    await store.getState().boot()
    expect(store.getState().status).toBe('local')
    const did = store.getState().controllerDid
    await store.getState().boot()
    // No re-open, same identity.
    expect(store.getState().status).toBe('local')
    expect(store.getState().controllerDid).toBe(did)
  })

  it('lands connected from a valid persisted session', async () => {
    const seedStore = newSeedStore()
    const { controllerDid } = await persistSession({ seedStore })
    const store = makeStore(baseConfig(), seedStore)

    await store.getState().boot()

    expect(store.getState().status).toBe('connected')
    expect(store.getState().controllerDid).toBe(controllerDid)
    expect(store.getState().accessExpired).toBe(false)
    expect(hasStore()).toBe(true)
  })

  it('reuses the persisted anonymous seed/DID across a second boot', async () => {
    const config = baseConfig()
    const first = makeStore(config, newSeedStore())
    await first.getState().boot()
    const firstDid = first.getState().controllerDid
    // Tear the first replica down (the anon seed survives a destroy).
    await first.getState().destroy()

    const second = makeStore(config, newSeedStore())
    await second.getState().boot()

    expect(second.getState().status).toBe('local')
    expect(second.getState().controllerDid).toBe(firstDid)
  })
})

describe('connectWithGrants()', () => {
  it('transitions local to connected under the given seed', async () => {
    const store = makeStore(baseConfig(), newSeedStore())
    await store.getState().boot()
    expect(store.getState().status).toBe('local')

    const seed = crypto.getRandomValues(new Uint8Array(32))
    const identity = await initAppSession({ seed })
    await store.getState().connectWithGrants({ seed, grants: noteGrants() })

    expect(store.getState().status).toBe('connected')
    expect(store.getState().controllerDid).toBe(identity.controllerDid)
    expect(store.getState().accessExpired).toBe(false)
    expect(hasStore()).toBe(true)
  })
})

describe('login()', () => {
  it('transitions local to connected and leaves the anon seed intact', async () => {
    const config = baseConfig()
    const store = makeStore(config, newSeedStore())
    await store.getState().boot()
    const anon = createSeedStore({ dbName: `${config.dbName}-anon` })
    const anonSeed = await anon.loadSeed()
    expect(anonSeed).not.toBeNull()

    // The wallet returns a fresh identity + grants (distinct from the anon one).
    const walletSeed = crypto.getRandomValues(new Uint8Array(32))
    const identity = await initAppSession({ seed: walletSeed })
    const grants = noteGrants()
    loginWithWalletMock.mockResolvedValue({
      seed: walletSeed,
      identity,
      grants,
      parsed: parseGrants(grants),
      expires: futureIso(FAR_FUTURE_MS),
      firstRun: false
    })

    await store.getState().login()

    expect(store.getState().status).toBe('connected')
    expect(store.getState().authenticating).toBe(false)
    expect(store.getState().controllerDid).toBe(identity.controllerDid)
    // The anon seed is set aside, not deleted (the step-3 adoption seam).
    expect(await anon.loadSeed()).toEqual(anonSeed)
  })

  it('leaves local intact when the wallet login is cancelled', async () => {
    const store = makeStore(baseConfig(), newSeedStore())
    await store.getState().boot()
    const localDid = store.getState().controllerDid

    loginWithWalletMock.mockRejectedValue(
      new LoginCancelledError('wallet login')
    )

    await store.getState().login()

    expect(store.getState().status).toBe('local')
    expect(store.getState().authenticating).toBe(false)
    expect(store.getState().controllerDid).toBe(localDid)
    expect(store.getState().error).toMatch(/cancelled/i)
    // The anonymous replica was never torn down.
    expect(hasStore()).toBe(true)
  })
})

describe('logout()', () => {
  it('keeps the connected replica by default and lands local', async () => {
    const seedStore = newSeedStore()
    await persistSession({ seedStore })
    const store = makeStore(baseConfig(), seedStore)
    await store.getState().boot()
    expect(store.getState().status).toBe('connected')

    const removeSpy = vi.spyOn(requireStore(), 'remove')
    await store.getState().logout()

    expect(store.getState().status).toBe('local')
    expect(store.getState().controllerDid).toMatch(/^did:key:/)
    expect(store.getState().expires).toBeNull()
    // The session record was cleared.
    expect(await seedStore.loadSeed()).toBeNull()
    // Keep path: the connected replica was closed, not removed.
    expect(removeSpy).not.toHaveBeenCalled()
  })

  it('removes the connected replica when wipe is true', async () => {
    const seedStore = newSeedStore()
    await persistSession({ seedStore })
    const store = makeStore(baseConfig(), seedStore)
    await store.getState().boot()
    expect(store.getState().status).toBe('connected')

    const removeSpy = vi.spyOn(requireStore(), 'remove')
    await store.getState().logout({ wipe: true })

    expect(store.getState().status).toBe('local')
    expect(removeSpy).toHaveBeenCalledTimes(1)
    expect(await seedStore.loadSeed()).toBeNull()
  })
})

describe('clearLocalData()', () => {
  it('mints a fresh anonymous seed/DID and empties the stores', async () => {
    const config = baseConfig()
    const store = makeStore(config, newSeedStore())
    await store.getState().boot()
    const firstDid = store.getState().controllerDid
    // Write a row so we can prove the replica is emptied.
    await requireStore().insertEntity('notes', { id: crypto.randomUUID() })
    expect(await requireStore().listEntities('notes')).toHaveLength(1)

    await store.getState().clearLocalData()

    expect(store.getState().status).toBe('local')
    // A brand-new anonymous DID (the old seed was discarded before re-open).
    expect(store.getState().controllerDid).not.toBe(firstDid)
    expect(store.getState().controllerDid).toMatch(/^did:key:/)
    expect(await requireStore().listEntities('notes')).toHaveLength(0)
  })
})
