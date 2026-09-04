/**
 * Unit tests for the descriptor read pass shared by the login-time
 * `readRemoteDescriptors` and the sync bootstrap `startWasSync`: a description
 * read that FAILS is never taken for "no descriptor". The remote store is
 * replaced with a stub (`WasRemoteStore.fromGrants` is spied), and the local
 * store and sync controller are inert fakes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IZcap } from '@interop/data-integrity-core'
import type { ZcapClient } from '@interop/ezcap'
import type { CollectionEncryption } from '@interop/was-client'
import type { WasCollectionConfig } from '../config.js'
import type { ParsedGrants } from '../grants.js'
import type { LocalStore } from './localStore.js'
import type { SyncController } from './syncController.js'
import { WasRemoteStore } from './wasRemoteStore.js'
import { readRemoteDescriptors, startWasSync } from './wasSync.js'

const collections: WasCollectionConfig[] = [
  { key: 'notes', id: 'notes' },
  { key: 'tasks', id: 'tasks' }
]

const parsed: ParsedGrants = {
  serverUrl: 'https://was.example',
  spaceId: 'space-1',
  byCollectionId: {
    notes: { id: 'urn:zcap:notes' } as unknown as IZcap,
    tasks: { id: 'urn:zcap:tasks' } as unknown as IZcap
  }
}

const zcapClient = {} as unknown as ZcapClient

const descriptor = {
  currentEpoch: 'e0',
  epochs: [{ id: 'e0', recipients: [] }]
} as unknown as CollectionEncryption

/**
 * A remote store whose description read answers per collection id: a
 * descriptor, `undefined`, or a rejection. Every declaration verb is a
 * resolved no-op that records its call.
 */
function stubRemoteStore(
  reads: Record<string, CollectionEncryption | undefined | Error>
) {
  const stub = {
    readCollectionEncryption: vi.fn(async (collectionId: string) => {
      const answer = reads[collectionId]
      if (answer instanceof Error) {
        throw answer
      }
      return answer
    }),
    markCollectionEncrypted: vi.fn(async (collectionId: string) => ({
      collectionId,
      ok: true,
      skipped: true
    })),
    declareBlindedIndexes: vi.fn(async (collectionId: string) => ({
      collectionId,
      ok: true,
      skipped: true
    })),
    declareCollectionIndexes: vi.fn(async (collectionId: string) => ({
      collectionId,
      ok: true,
      skipped: true
    })),
    readCollectionMeta: vi.fn(async () => undefined)
  }
  vi.spyOn(WasRemoteStore, 'fromGrants').mockReturnValue(
    stub as unknown as WasRemoteStore
  )
  return stub
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('readRemoteDescriptors', () => {
  it('rejects when one collection description read fails', async () => {
    const failure = new Error('descriptor read failed')
    stubRemoteStore({ notes: descriptor, tasks: failure })

    await expect(
      readRemoteDescriptors({ parsed, zcapClient, collections })
    ).rejects.toBe(failure)
  })

  it('keeps only the epoch-bearing descriptors when every read answers', async () => {
    stubRemoteStore({ notes: descriptor, tasks: undefined })

    expect(
      await readRemoteDescriptors({ parsed, zcapClient, collections })
    ).toEqual({ notes: descriptor })
  })
})

describe('startWasSync descriptor read failure', () => {
  it('skips the failed collection entirely and bootstraps the rest', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const remote = stubRemoteStore({
      notes: descriptor,
      tasks: new Error('descriptor read failed')
    })
    const localStore = {
      applyRemoteDescriptor: vi.fn(async () => {}),
      applyCollectionMeta: vi.fn(async () => {}),
      setDescriptorSource: vi.fn()
    }
    const syncController = { start: vi.fn(async () => {}) }
    const fetched = vi.fn()

    await startWasSync({
      parsed,
      zcapClient,
      collections,
      localStore: localStore as unknown as LocalStore,
      syncController: syncController as unknown as SyncController,
      onRemoteChange: () => {},
      onDescriptorsFetched: fetched
    })

    // The readable collection went through the whole per-collection pass.
    expect(localStore.applyRemoteDescriptor).toHaveBeenCalledWith({
      collectionId: 'notes',
      encryption: descriptor
    })
    expect(remote.markCollectionEncrypted.mock.calls.map(([id]) => id)).toEqual(
      ['notes']
    )
    expect(
      remote.declareCollectionIndexes.mock.calls.map(([id]) => id)
    ).toEqual(['notes'])
    // The failed one received neither a cipher rebuild nor any PUT, and did
    // not enter the offline cache as "no descriptor".
    expect(fetched).toHaveBeenCalledWith({ notes: descriptor })
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('"tasks"'),
      expect.any(Error)
    )
    // Replication still starts.
    expect(syncController.start).toHaveBeenCalledTimes(1)
  })
})
