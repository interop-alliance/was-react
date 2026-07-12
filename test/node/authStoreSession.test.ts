/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Session-flow tests for the auth store that drive a real seed-derived identity
 * and a real (fake-indexeddb) LocalStore open, but stub the network edges:
 * `startWasSync` is mocked to a no-op (no live replication / no `window`/`fetch`
 * dependency) and `requestGrants` is mocked per-test. Covers:
 *
 * - a failed activation tears the local store back down and surfaces the open
 *   error (so a later login never reuses a half-open controller's database);
 * - `reconnect()` keeps the seed (and the session) when the persisted record has
 *   expired, instead of wiping it and logging out;
 * - `restore()` with a grant set that does not cover every configured collection
 *   raises the reconnect banner proactively;
 * - `destroy()` tears the session down WITHOUT wiping the persisted record, so a
 *   fresh `restore()` re-opens it.
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
import { useAppReady } from '../../src/session/appReadyStore.js'
import { hasStore } from '../../src/storage/storageManager.js'
import { useSyncStatusStore } from '../../src/storage/syncStatusStore.js'
import type { StoreRegistry, WasAppConfig } from '../../src/config.js'

// Replace the live replication bootstrap with an inert resolver: the auth-store
// logic under test (activate / persist / begin-sync tracking / teardown) runs
// without opening any network or `window`-backed replication machinery.
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
  useAppReady.getState().reset()
  useSyncStatusStore.getState().reset()
  vi.restoreAllMocks()
})

/**
 * Persists a valid, matching session and drives `restore()` to `authenticated`.
 */
async function authenticatedStore({
  config,
  seedStore,
  grants = noteGrants(),
  expires = futureIso(FAR_FUTURE_MS)
}: {
  config: WasAppConfig
  seedStore: SeedStore
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
  const store = createAuthStore({ config, registry, seedStore })
  liveStores.push(store)
  await store.getState().restore()
  return { store, seed }
}

describe('activateSession teardown on failure', () => {
  it('tears the store down and surfaces the open error when hydrate fails', async () => {
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

    const failingRegistry: StoreRegistry = {
      notes: {
        hydrate: async () => {
          throw new Error('hydrate boom')
        },
        upsert: () => {},
        drop: () => {},
        clear: () => {}
      }
    }
    const store = createAuthStore({
      config: baseConfig([{ key: 'notes', id: 'notes' }]),
      registry: failingRegistry,
      seedStore
    })
    liveStores.push(store)

    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await store.getState().restore()

    expect(store.getState().status).toBe('unauthenticated')
    // The store was closed + cleared, not left installed for a later login.
    expect(hasStore()).toBe(false)
    // The open failure is surfaced on the ready gate (ProtectedRoute's branch).
    expect(useAppReady.getState().error).toBeTruthy()
  })
})

describe('reconnect() with an expired record', () => {
  it('keeps the seed and stays authenticated instead of logging out', async () => {
    const config = baseConfig([{ key: 'notes', id: 'notes' }])
    const seedStore = newSeedStore()
    const { store, seed } = await authenticatedStore({ config, seedStore })
    expect(store.getState().status).toBe('authenticated')

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
    // session was not torn down to `unauthenticated`.
    expect(await seedStore.loadSeed()).not.toBeNull()
    expect(store.getState().status).toBe('authenticated')
    expect(store.getState().reconnecting).toBe(false)
  })
})

describe('restore() grant coverage', () => {
  it('raises the reconnect banner when a configured collection is uncovered', async () => {
    // Two configured collections, but the grant set only covers `notes`.
    const config = baseConfig([
      { key: 'notes', id: 'notes' },
      { key: 'tasks', id: 'tasks' }
    ])
    const seedStore = newSeedStore()
    const { store } = await authenticatedStore({ config, seedStore })

    expect(store.getState().status).toBe('authenticated')
    expect(store.getState().accessExpired).toBe(true)
  })

  it('does not raise the banner when every collection is covered', async () => {
    const config = baseConfig([{ key: 'notes', id: 'notes' }])
    const seedStore = newSeedStore()
    const { store } = await authenticatedStore({ config, seedStore })

    expect(store.getState().status).toBe('authenticated')
    expect(store.getState().accessExpired).toBe(false)
  })
})

describe('destroy()', () => {
  it('tears the session down without wiping the record and allows re-restore', async () => {
    const config = baseConfig([{ key: 'notes', id: 'notes' }])
    const seedStore = newSeedStore()
    const { store } = await authenticatedStore({ config, seedStore })
    expect(store.getState().status).toBe('authenticated')
    expect(hasStore()).toBe(true)

    await store.getState().destroy()

    // Torn down and returned to `idle` (not `unauthenticated`).
    expect(store.getState().status).toBe('idle')
    expect(hasStore()).toBe(false)
    // The persisted record survives, so a StrictMode remount can restore.
    expect(await restoreAppSession({ store: seedStore })).not.toBeNull()

    await store.getState().restore()
    expect(store.getState().status).toBe('authenticated')
  })
})
