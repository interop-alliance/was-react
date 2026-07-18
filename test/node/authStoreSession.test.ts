/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Connected-session tests for the four-state machine: a real seed-derived
 * identity and a real (fake-indexeddb) LocalStore open, with the network edges
 * stubbed (`startWasSync` a no-op, `requestGrants` mocked per test). Covers:
 *
 * - a failed connected activation falls back to a usable `local` replica (never
 *   dead-ends) and surfaces the open error;
 * - `reconnect()` keeps the seed (and stays in `reconnect`) when the re-grant
 *   fails, instead of wiping the seed and logging out;
 * - `boot()` with a grant set that does not cover every configured collection
 *   lands `reconnect` (the proactive banner);
 * - `destroy()` tears the session down WITHOUT wiping the persisted record, so a
 *   fresh `boot()` re-opens it `connected`.
 *
 * @vitest-environment node
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
import {
  persistAppSession,
  restoreAppSession
} from '../../src/identity/appSession.js'
import { requestGrants } from '../../src/auth/loginFlow.js'
import { hasStore } from '../../src/storage/storageManager.js'
import { useSyncStatusStore } from '../../src/storage/syncStatusStore.js'
import type { StoreRegistry, WasAppConfig } from '../../src/config.js'

// Replace the live replication bootstrap with an inert resolver.
vi.mock('../../src/storage/wasSync.js', () => ({
  startWasSync: vi.fn(async () => ({}))
}))

// Keep the real login flow but make the re-grant request controllable per test.
vi.mock('../../src/auth/loginFlow.js', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../../src/auth/loginFlow.js')>()
  return { ...actual, requestGrants: vi.fn() }
})

const requestGrantsMock = vi.mocked(requestGrants)

function baseConfig(collections: { key: string; id: string }[]): WasAppConfig {
  return {
    appName: 'Test App',
    appOrigin: 'http://localhost:5173',
    collections,
    credential: {
      credentialType: 'TestAppKey',
      vocabBase: 'urn:test-app:vocab#'
    },
    // A unique base name per config so the RxDB databases never collide
    // across tests sharing the one process-wide fake-indexeddb.
    dbName: `was-react-${Math.random().toString(36).slice(2)}`
  }
}

const registry: StoreRegistry = {}

function futureIso(ms: number): string {
  return new Date(Date.now() + ms).toISOString()
}

function pastIso(ms: number): string {
  return new Date(Date.now() - ms).toISOString()
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

// Well beyond the default 1h near-expiry warning, so the watch never fires.
const FAR_FUTURE_MS = 4 * 60 * 60 * 1000

// Track created stores so their expiry-watch intervals never outlive a test.
const liveStores: WasAuthStore[] = []

beforeEach(() => {
  requestGrantsMock.mockReset()
})

afterEach(async () => {
  while (liveStores.length > 0) {
    await liveStores.pop()!.getState().destroy()
  }
  useSyncStatusStore.getState().reset()
  vi.restoreAllMocks()
})

/**
 * Persists a valid, matching session and drives `boot()` to `connected`.
 */
async function connectedStore({
  config,
  seedStore,
  registry: reg = registry,
  grants = noteGrants(),
  expires = futureIso(FAR_FUTURE_MS)
}: {
  config: WasAppConfig
  seedStore: SeedStore
  registry?: StoreRegistry
  grants?: IZcap[]
  expires?: string
}): Promise<{ store: WasAuthStore; seed: Uint8Array }> {
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
  const store = createAuthStore({ config, registry: reg, seedStore })
  liveStores.push(store)
  await store.getState().boot()
  return { store, seed }
}

describe('activateConnected fallback on failure', () => {
  it('falls back to a usable local replica and surfaces the open error', async () => {
    const seed = crypto.getRandomValues(new Uint8Array(32))
    const identity = await initAppSession({ seed })
    const seedStore = newSeedStore()
    await persistAppSession({
      session: {
        seed,
        controllerDid: identity.controllerDid,
        serverUrl: 'http://localhost:3999',
        spaceId: 'space-1',
        grants: noteGrants(),
        expires: futureIso(FAR_FUTURE_MS)
      },
      store: seedStore
    })

    // Hydrate throws on the FIRST call (the connected open) and succeeds after,
    // so the connected activation fails but the local fallback opens cleanly.
    let hydrateCalls = 0
    const flakyRegistry: StoreRegistry = {
      notes: {
        hydrate: async () => {
          hydrateCalls++
          if (hydrateCalls === 1) {
            throw new Error('hydrate boom')
          }
        },
        upsert: () => {},
        drop: () => {},
        clear: () => {}
      }
    }
    const store = createAuthStore({
      config: baseConfig([{ key: 'notes', id: 'notes' }]),
      registry: flakyRegistry,
      seedStore
    })
    liveStores.push(store)

    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await store.getState().boot()

    // The connected activation failed, but the app never dead-ends: it lands in
    // a usable `local` replica with the open error surfaced.
    expect(store.getState().status).toBe('local')
    expect(hasStore()).toBe(true)
    expect(store.getState().error).toBeTruthy()
  })
})

describe('reconnect() with a failing re-grant', () => {
  it('keeps the seed and stays in reconnect instead of logging out', async () => {
    const config = baseConfig([{ key: 'notes', id: 'notes' }])
    const seedStore = newSeedStore()
    const { store, seed } = await connectedStore({ config, seedStore })
    expect(store.getState().status).toBe('connected')

    // A live 401/403 (or near-expiry) moves the session to `reconnect`.
    store.getState().notifyAccessExpired()
    expect(store.getState().status).toBe('reconnect')

    // Model the exact bug: the persisted record is now past its expiry (only
    // the grants need renewing; the seed survives).
    const identity = await initAppSession({ seed })
    await persistAppSession({
      session: {
        seed,
        controllerDid: identity.controllerDid,
        serverUrl: 'http://localhost:3999',
        spaceId: 'space-1',
        grants: noteGrants(),
        expires: pastIso(1000)
      },
      store: seedStore
    })

    // The re-grant popup fails; reconnect must NOT log out over it.
    requestGrantsMock.mockRejectedValue(new Error('grants dismissed'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await store.getState().reconnect()

    // The seed survived (old code wiped it via restoreAppSession) and the
    // session was not torn down to `local`.
    expect(await seedStore.loadSeed()).not.toBeNull()
    expect(store.getState().status).toBe('reconnect')
    expect(store.getState().reconnecting).toBe(false)
  })
})

describe('boot() grant coverage', () => {
  it('lands reconnect when a configured collection is uncovered', async () => {
    // Two configured collections, but the grant set only covers `notes`.
    const config = baseConfig([
      { key: 'notes', id: 'notes' },
      { key: 'tasks', id: 'tasks' }
    ])
    const seedStore = newSeedStore()
    const { store } = await connectedStore({ config, seedStore })

    expect(store.getState().status).toBe('reconnect')
    expect(store.getState().accessExpired).toBe(true)
  })

  it('lands connected when every collection is covered', async () => {
    const config = baseConfig([{ key: 'notes', id: 'notes' }])
    const seedStore = newSeedStore()
    const { store } = await connectedStore({ config, seedStore })

    expect(store.getState().status).toBe('connected')
    expect(store.getState().accessExpired).toBe(false)
  })
})

describe('destroy()', () => {
  it('tears the session down without wiping the record and allows a re-boot', async () => {
    const config = baseConfig([{ key: 'notes', id: 'notes' }])
    const seedStore = newSeedStore()
    const { store } = await connectedStore({ config, seedStore })
    expect(store.getState().status).toBe('connected')
    expect(hasStore()).toBe(true)

    await store.getState().destroy()

    // Torn down and returned to `boot` (not `local`).
    expect(store.getState().status).toBe('boot')
    expect(hasStore()).toBe(false)
    // The persisted record survives, so a StrictMode remount can re-boot.
    expect(await restoreAppSession({ store: seedStore })).not.toBeNull()

    await store.getState().boot()
    expect(store.getState().status).toBe('connected')
  })
})
