/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Focused unit tests for the auth-store restore path, using a real (fake-
 * indexeddb) seed store and real seed-derived identity, but no WAS server and no
 * local RxDB open (those branches are only reached on a valid, matching record).
 *
 * Covered:
 * - restore() with nothing persisted lands on `unauthenticated`.
 * - restore() with a record whose `controllerDid` does not match the identity
 *   the seed derives is treated as corrupt: the session is cleared and the
 *   status falls to `unauthenticated`.
 * - restore() is a no-op once the status has left `idle`.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import type { IZcap } from '@interop/data-integrity-core'
import { createAuthStore } from '../../src/session/authStore.js'
import { createSeedStore } from '../../src/identity/seedStore.js'
import { persistAppSession } from '../../src/identity/appSession.js'
import type { StoreRegistry, WasAppConfig } from '../../src/config.js'

const config: WasAppConfig = {
  appName: 'Test App',
  appOrigin: 'http://localhost:5173',
  collections: [{ key: 'notes', id: 'notes' }],
  credential: {
    credentialType: 'TestAppKey',
    vocabBase: 'urn:test-app:vocab#'
  }
}

const registry: StoreRegistry = {}

function futureIso(ms: number): string {
  return new Date(Date.now() + ms).toISOString()
}

function newSeedStore() {
  return createSeedStore({
    dbName: `was-react-authstore-${Math.random().toString(36).slice(2)}`,
    idb: new IDBFactory()
  })
}

describe('createAuthStore().restore()', () => {
  it('falls to unauthenticated when nothing is persisted', async () => {
    const store = createAuthStore({
      config,
      registry,
      seedStore: newSeedStore()
    })
    await store.getState().restore()
    expect(store.getState().status).toBe('unauthenticated')
  })

  it('clears a corrupt record (controllerDid mismatch) and unauthenticates', async () => {
    const seedStore = newSeedStore()
    // A structurally valid, unexpired record whose controllerDid cannot match
    // the identity the (random) seed derives.
    await persistAppSession({
      session: {
        seed: crypto.getRandomValues(new Uint8Array(32)),
        controllerDid: 'did:key:z6MkBogusControllerDoesNotMatch',
        serverUrl: 'http://localhost:3999',
        spaceId: 'space-1',
        grants: [
          {
            id: 'urn:zcap:1',
            invocationTarget: 'http://localhost:3999/space/space-1/notes'
          }
        ] as unknown as IZcap[],
        expires: futureIso(60_000)
      },
      store: seedStore
    })
    const store = createAuthStore({ config, registry, seedStore })
    await store.getState().restore()
    expect(store.getState().status).toBe('unauthenticated')
    // The corrupt record was wiped, not merely skipped.
    await store.getState().restore()
    expect(store.getState().status).toBe('unauthenticated')
  })

  it('is a no-op once status has left idle', async () => {
    const store = createAuthStore({
      config,
      registry,
      seedStore: newSeedStore()
    })
    await store.getState().restore()
    expect(store.getState().status).toBe('unauthenticated')
    // A second restore from a non-idle status returns immediately.
    await store.getState().restore()
    expect(store.getState().status).toBe('unauthenticated')
  })
})
