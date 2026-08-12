/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * SyncController lifecycle unit tests (jsdom, for `window`): the terminal-stop
 * latch (a `stop()` that raced an in-flight bootstrap keeps a later `start()` a
 * no-op), the skip-uncovered-collections behavior (a collection the grant set
 * does not cover is flagged and skipped rather than replicated capability-less),
 * and the failed bring-up (a throw during `start()` unwinds, flags every
 * collection as errored, rethrows, and leaves the controller re-startable).
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SyncController,
  isAuthError
} from '../../src/storage/syncController.js'
import {
  deriveSyncRollup,
  useSyncStatusStore
} from '../../src/storage/syncStatusStore.js'
import { WasSyncAuthError } from '../../src/sync/index.js'
import type { WasRemoteStore } from '../../src/storage/wasRemoteStore.js'
import type { LocalStore } from '../../src/storage/localStore.js'

const COLLECTIONS = [{ key: 'notes', id: 'notes' }]

/**
 * A remote store whose `collectionCapability` and `was` access are spied so a
 * test can assert whether `start()` reached the per-collection build at all.
 */
function fakeRemoteStore(capabilityFor: (id: string) => object | undefined): {
  remoteStore: WasRemoteStore
  collectionCapability: ReturnType<typeof vi.fn>
} {
  const collectionCapability = vi.fn(capabilityFor)
  const remoteStore = {
    // The sync port binds its `changes` feed handle at construction, so the
    // fake client has to answer `space().collection()`; nothing here is called.
    was: { space: () => ({ collection: () => ({}) }) },
    serverUrl: 'http://localhost:3999',
    spaceId: 'space-1',
    collectionCapability
  } as unknown as WasRemoteStore
  return { remoteStore, collectionCapability }
}

afterEach(() => {
  useSyncStatusStore.getState().reset()
  vi.restoreAllMocks()
})

describe('SyncController stop-then-start latch', () => {
  it('never starts after stop() (stop is terminal)', async () => {
    const controller = new SyncController({ collections: COLLECTIONS })
    // A logout stops the controller before the bootstrap ever calls start().
    await controller.stop()

    const { remoteStore, collectionCapability } = fakeRemoteStore(() => ({}))
    const rxCollection = vi.fn()
    await controller.start({
      remoteStore,
      localStore: { rxCollection } as unknown as LocalStore
    })

    // The latch short-circuits before any per-collection wiring runs.
    expect(collectionCapability).not.toHaveBeenCalled()
    expect(rxCollection).not.toHaveBeenCalled()
    expect(useSyncStatusStore.getState().statuses).toEqual({})
  })
})

describe('isAuthError', () => {
  it('recognises a WasSyncAuthError at the top level', () => {
    expect(isAuthError(new WasSyncAuthError(403))).toBe(true)
  })

  it('recognises a WasSyncAuthError wrapped in an RxError-like graph', () => {
    // RxDB wraps a thrown push/pull-handler error under `parameters.errors`.
    const rxError = {
      code: 'RC_PUSH',
      parameters: { errors: [new WasSyncAuthError(401)] }
    }
    expect(isAuthError(rxError)).toBe(true)
  })

  it('recognises the plain-JSON form RxDB serializes handler errors to', () => {
    // RxDB's RC_PULL/RC_PUSH wrapping runs the thrown error through
    // `errorToPlainJson`, keeping only name/message/stack -- no instance, no
    // custom fields like `status`.
    const rxError = {
      code: 'RC_PULL',
      parameters: {
        errors: [
          {
            name: 'WasSyncAuthError',
            message: 'WAS storage access denied (HTTP 403).',
            stack: 'WasSyncAuthError: ...'
          }
        ]
      }
    }
    expect(isAuthError(rxError)).toBe(true)
  })

  it('recognises a WasSyncAuthError nested under `cause`', () => {
    expect(isAuthError({ cause: { cause: new WasSyncAuthError(401) } })).toBe(
      true
    )
  })

  it('returns false for a non-auth error graph', () => {
    expect(isAuthError(new Error('network down'))).toBe(false)
    expect(isAuthError({ status: 500, parameters: { errors: [] } })).toBe(false)
  })

  it('tolerates cycles in the error graph', () => {
    const cyclic: { self?: unknown; cause?: unknown } = {}
    cyclic.cause = cyclic
    expect(isAuthError(cyclic)).toBe(false)
  })
})

describe('SyncController failed bring-up', () => {
  it('rethrows, flags every collection, and stays re-startable', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const controller = new SyncController({
      collections: COLLECTIONS,
      sync: { pollMs: 0 }
    })
    const { remoteStore } = fakeRemoteStore(() => ({}))
    // The bring-up throws where the replication is wired up.
    const rxCollection = vi.fn(() => {
      throw new Error('database closed')
    })
    const localStore = { rxCollection } as unknown as LocalStore

    // The failure surfaces to the caller's bootstrap rather than resolving
    // silently through a terminal stop().
    await expect(controller.start({ remoteStore, localStore })).rejects.toThrow(
      'database closed'
    )
    expect(error).toHaveBeenCalled()

    // Every configured collection reads as 'error', so the rollup reports the
    // failure rather than "Local only".
    const { statuses } = useSyncStatusStore.getState()
    expect(statuses.notes).toBe('error')
    expect(deriveSyncRollup(Object.values(statuses)).state).toBe('error')

    // Not latched: a later start() runs its body again instead of no-opping.
    await expect(controller.start({ remoteStore, localStore })).rejects.toThrow(
      'database closed'
    )
    expect(rxCollection).toHaveBeenCalledTimes(2)
  })
})

describe('SyncController uncovered-collection skip', () => {
  it('skips (and flags) a collection with no delegated capability', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const controller = new SyncController({
      collections: COLLECTIONS,
      // Disable the poll timer so the test leaves no interval behind.
      sync: { pollMs: 0 }
    })

    const { remoteStore } = fakeRemoteStore(() => undefined)
    const rxCollection = vi.fn()
    await controller.start({
      remoteStore,
      localStore: { rxCollection } as unknown as LocalStore
    })

    // The uncovered collection is flagged and never wired to a replication.
    expect(useSyncStatusStore.getState().statuses.notes).toBe('error')
    expect(rxCollection).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()

    await controller.stop()
  })
})
