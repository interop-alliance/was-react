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
 * - `clearLocalData()` mints a brand-new anonymous seed/DID, empties stores,
 *   and drops any persisted connected session.
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
import {
  LocalStore,
  dbNameForController
} from '../../src/storage/localStore.js'
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

// Probe replicas opened directly to inspect a torn-down anonymous database.
const probeStores: LocalStore[] = []

function makeStore(config: WasAppConfig, seedStore: SeedStore): WasAuthStore {
  const store = createAuthStore({ config, registry, seedStore })
  liveStores.push(store)
  return store
}

/**
 * Opens a fresh handle on the per-controller database `seed`/`controllerDid`
 * back for direct inspection (a probe of a replica the store has torn down).
 * Opening a deleted database RE-CREATES it empty, which is exactly what makes
 * "the anon database was deleted" assertable: reopen and expect zero rows.
 */
async function reopenReplica({
  config,
  seed,
  controllerDid
}: {
  config: WasAppConfig
  seed: Uint8Array
  controllerDid: string
}): Promise<LocalStore> {
  const store = await LocalStore.init({
    seed,
    collections: config.collections,
    dbName: dbNameForController({ dbName: config.dbName!, controllerDid })
  })
  probeStores.push(store)
  return store
}

afterEach(async () => {
  while (probeStores.length > 0) {
    await probeStores.pop()!.remove()
  }
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

    const outcome = await store.getState().login()

    expect(outcome).toEqual({ firstRun: false })
    expect(store.getState().status).toBe('connected')
    expect(store.getState().authenticating).toBe(false)
    expect(store.getState().controllerDid).toBe(identity.controllerDid)
    // Nothing to adopt (the local replica is empty), so the anon seed survives.
    expect(await anon.loadSeed()).toEqual(anonSeed)
  })

  it('leaves local intact when the wallet login is cancelled', async () => {
    const store = makeStore(baseConfig(), newSeedStore())
    await store.getState().boot()
    const localDid = store.getState().controllerDid

    loginWithWalletMock.mockRejectedValue(
      new LoginCancelledError('wallet login')
    )

    // A cancel resolves with `null` (not a failure) and leaves no scary error.
    const outcome = await store.getState().login()

    expect(outcome).toBeNull()
    expect(store.getState().status).toBe('local')
    expect(store.getState().authenticating).toBe(false)
    expect(store.getState().controllerDid).toBe(localDid)
    expect(store.getState().error).toBeNull()
    // The anonymous replica was never torn down.
    expect(hasStore()).toBe(true)
  })

  it('rejects and records the error when the wallet login fails', async () => {
    const store = makeStore(baseConfig(), newSeedStore())
    await store.getState().boot()
    const localDid = store.getState().controllerDid

    loginWithWalletMock.mockRejectedValue(
      new Error('grants verification failed')
    )

    await expect(store.getState().login()).rejects.toThrow(
      /grants verification failed/
    )

    expect(store.getState().status).toBe('local')
    expect(store.getState().authenticating).toBe(false)
    expect(store.getState().controllerDid).toBe(localDid)
    expect(store.getState().error).toMatch(/Login failed/i)
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

/**
 * Arms the wallet mock to succeed with a fresh identity + grants (distinct from
 * the anonymous one), returning the connected controller DID it will land on.
 */
async function mockWalletLogin(): Promise<{ controllerDid: string }> {
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
  return { controllerDid: identity.controllerDid }
}

describe('adoption', () => {
  it('merges anonymous docs into the connected replica and deletes the anon replica', async () => {
    const config = baseConfig()
    const store = makeStore(config, newSeedStore())
    await store.getState().boot()
    const anon = createSeedStore({ dbName: `${config.dbName}-anon` })
    const anonSeed = await anon.loadSeed()
    const anonDid = store.getState().controllerDid!
    // Two docs, deliberately WITHOUT LWW fields, so adoption must stamp them.
    const first = { id: crypto.randomUUID(), title: 'first' }
    const second = { id: crypto.randomUUID(), title: 'second' }
    await requireStore().insertEntity('notes', first)
    await requireStore().insertEntity('notes', second)

    await mockWalletLogin()
    await store.getState().login()

    expect(store.getState().status).toBe('connected')
    // The connected replica now carries the adopted docs, each stamped with
    // non-empty LWW fields at adoption time.
    const adopted = await requireStore().listEntities<{
      id: string
      title: string
      updatedAt: string
      deviceId: string
    }>('notes')
    expect(adopted.map(doc => doc.title).sort()).toEqual(['first', 'second'])
    for (const doc of adopted) {
      expect(typeof doc.updatedAt).toBe('string')
      expect(doc.updatedAt.length).toBeGreaterThan(0)
      expect(typeof doc.deviceId).toBe('string')
      expect(doc.deviceId.length).toBeGreaterThan(0)
    }
    // The anon seed is gone and its database was deleted (a reopen is empty).
    expect(await anon.loadSeed()).toBeNull()
    const reopened = await reopenReplica({
      config,
      seed: anonSeed!,
      controllerDid: anonDid
    })
    expect(await reopened.listEntities('notes')).toHaveLength(0)
  })

  it('leaves the anon replica intact under adopt "leave"', async () => {
    const config = baseConfig()
    const store = makeStore(config, newSeedStore())
    await store.getState().boot()
    const anon = createSeedStore({ dbName: `${config.dbName}-anon` })
    const anonSeed = await anon.loadSeed()
    const anonDid = store.getState().controllerDid!
    const note = { id: crypto.randomUUID(), title: 'kept-local' }
    await requireStore().insertEntity('notes', note)

    await mockWalletLogin()
    await store.getState().login({ adopt: 'leave' })

    expect(store.getState().status).toBe('connected')
    // The connected replica never saw the local doc.
    expect(await requireStore().listEntities('notes')).toHaveLength(0)
    // The anon seed survives, and its database still holds the original doc.
    expect(await anon.loadSeed()).toEqual(anonSeed)
    const reopened = await reopenReplica({
      config,
      seed: anonSeed!,
      controllerDid: anonDid
    })
    const kept = await reopened.listEntities<{ id: string; title: string }>(
      'notes'
    )
    expect(kept).toHaveLength(1)
    expect(kept[0]!.title).toBe('kept-local')
  })

  it('leaves the anon seed intact when the local replica is empty', async () => {
    const config = baseConfig()
    const store = makeStore(config, newSeedStore())
    await store.getState().boot()
    const anon = createSeedStore({ dbName: `${config.dbName}-anon` })
    const anonSeed = await anon.loadSeed()
    expect(anonSeed).not.toBeNull()

    await mockWalletLogin()
    await store.getState().login()

    expect(store.getState().status).toBe('connected')
    // No wipe: nothing to adopt means the anon seed is left untouched.
    expect(await anon.loadSeed()).toEqual(anonSeed)
  })

  it('lets an adopted doc win an id collision by newer updatedAt', async () => {
    const config = baseConfig()
    const store = makeStore(config, newSeedStore())
    await store.getState().boot()

    const walletSeed = crypto.getRandomValues(new Uint8Array(32))
    const grants = noteGrants()
    // First connect (anon replica empty): opens the connected replica.
    await store.getState().connectWithGrants({ seed: walletSeed, grants })
    const uuid = crypto.randomUUID()
    await requireStore().insertEntity('notes', {
      id: uuid,
      title: 'connected-older',
      updatedAt: '2026-01-01T00:00:00.000Z',
      deviceId: 'device-a'
    })

    // Back to local (the connected replica is kept on the device), then write a
    // NEWER version of the same uuid into the anon replica.
    await store.getState().logout()
    expect(store.getState().status).toBe('local')
    await requireStore().insertEntity('notes', {
      id: uuid,
      title: 'anon-newer',
      updatedAt: '2026-02-02T00:00:00.000Z',
      deviceId: 'device-a'
    })

    // Reconnect under the same seed (same per-controller database): adoption
    // LWW-merges the newer anon doc over the older connected one.
    await store.getState().connectWithGrants({ seed: walletSeed, grants })
    const merged = await requireStore().listEntities<{
      id: string
      title: string
    }>('notes')
    expect(merged).toHaveLength(1)
    expect(merged[0]!.title).toBe('anon-newer')
  })

  it('keeps the existing doc on an id collision when it wins updatedAt', async () => {
    const config = baseConfig()
    const store = makeStore(config, newSeedStore())
    await store.getState().boot()

    const walletSeed = crypto.getRandomValues(new Uint8Array(32))
    const grants = noteGrants()
    await store.getState().connectWithGrants({ seed: walletSeed, grants })
    const uuid = crypto.randomUUID()
    await requireStore().insertEntity('notes', {
      id: uuid,
      title: 'connected-newer',
      updatedAt: '2026-02-02T00:00:00.000Z',
      deviceId: 'device-a'
    })

    await store.getState().logout()
    await requireStore().insertEntity('notes', {
      id: uuid,
      title: 'anon-older',
      updatedAt: '2026-01-01T00:00:00.000Z',
      deviceId: 'device-a'
    })

    await store.getState().connectWithGrants({ seed: walletSeed, grants })
    const merged = await requireStore().listEntities<{
      id: string
      title: string
    }>('notes')
    expect(merged).toHaveLength(1)
    expect(merged[0]!.title).toBe('connected-newer')
  })

  it('connectWithGrants adopts by default and clears the anon seed', async () => {
    const config = baseConfig()
    const store = makeStore(config, newSeedStore())
    await store.getState().boot()
    const anon = createSeedStore({ dbName: `${config.dbName}-anon` })
    await requireStore().insertEntity('notes', {
      id: crypto.randomUUID(),
      title: 'adopt-me'
    })

    const seed = crypto.getRandomValues(new Uint8Array(32))
    await store.getState().connectWithGrants({ seed, grants: noteGrants() })

    expect(store.getState().status).toBe('connected')
    const adopted = await requireStore().listEntities<{
      id: string
      title: string
    }>('notes')
    expect(adopted).toHaveLength(1)
    expect(adopted[0]!.title).toBe('adopt-me')
    expect(await anon.loadSeed()).toBeNull()
  })

  it('connectWithGrants under adopt "leave" keeps the anon replica', async () => {
    const config = baseConfig()
    const store = makeStore(config, newSeedStore())
    await store.getState().boot()
    const anon = createSeedStore({ dbName: `${config.dbName}-anon` })
    const anonSeed = await anon.loadSeed()
    await requireStore().insertEntity('notes', {
      id: crypto.randomUUID(),
      title: 'stay-local'
    })

    const seed = crypto.getRandomValues(new Uint8Array(32))
    await store
      .getState()
      .connectWithGrants({ seed, grants: noteGrants(), adopt: 'leave' })

    expect(store.getState().status).toBe('connected')
    expect(await requireStore().listEntities('notes')).toHaveLength(0)
    expect(await anon.loadSeed()).toEqual(anonSeed)
  })
})

describe('hasLocalData()', () => {
  it('is false on a fresh empty local, true after a write, false once connected', async () => {
    const store = makeStore(baseConfig(), newSeedStore())
    await store.getState().boot()
    expect(store.getState().status).toBe('local')
    expect(await store.getState().hasLocalData()).toBe(false)

    await requireStore().insertEntity('notes', { id: crypto.randomUUID() })
    expect(await store.getState().hasLocalData()).toBe(true)

    const seed = crypto.getRandomValues(new Uint8Array(32))
    await store
      .getState()
      .connectWithGrants({ seed, grants: noteGrants(), adopt: 'leave' })
    expect(store.getState().status).toBe('connected')
    expect(await store.getState().hasLocalData()).toBe(false)
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

  it('clears the persisted session when run while connected', async () => {
    const seedStore = newSeedStore()
    await persistSession({ seedStore })
    const store = makeStore(baseConfig(), seedStore)
    await store.getState().boot()
    expect(store.getState().status).toBe('connected')

    await store.getState().clearLocalData()

    expect(store.getState().status).toBe('local')
    // The session record was cleared, so a later boot cannot reconnect.
    expect(await seedStore.loadSeed()).toBeNull()
  })
})
