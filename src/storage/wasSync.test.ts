/**
 * Unit tests for the metadata read pass shared by the login-time
 * `readRemoteDescriptors` and the sync bootstrap `startWasSync`: a read that
 * FAILS is never taken for "no descriptor", each granted collection's object
 * is read once, and the blinded-index install re-reads it only when the
 * declaration replaced its `custom`. The remote store is replaced with a stub
 * (`WasRemoteStore.fromGrants` is spied), and the local store and sync
 * controller are inert fakes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IZcap } from '@interop/data-integrity-core'
import type { ZcapClient } from '@interop/ezcap'
import type { CollectionEncryption } from '@interop/was-client'
import type { WasCollectionConfig } from '../config.js'
import type { ParsedGrants } from '../grants.js'
import type { LocalStore } from './localStore.js'
import type { SyncController } from './syncController.js'
import { WasRemoteStore, type CollectionMetaRead } from './wasRemoteStore.js'
import { readRemoteDescriptors, startWasSync } from './wasSync.js'
import { captureLogger } from '@interop/logger'
import { setLogger } from '../log.js'

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
 * The stored `custom` envelope of a collection under test, opaque to this
 * layer and installed verbatim.
 */
const stored = { jwe: { protected: 'opaque' } } as unknown as NonNullable<
  CollectionMetaRead['description']['custom']
>

/**
 * A remote store whose metadata read answers per collection id: a descriptor
 * (served as the `encryption` member of a stored object carrying `custom`),
 * `undefined` (the object carries no descriptor), or a rejection. `wrote`
 * scripts what the blinded-index declaration reports; every other declaration
 * verb is a resolved no-op that records its call.
 */
function stubRemoteStore(
  reads: Record<string, CollectionEncryption | undefined | Error>,
  { wrote = false }: { wrote?: boolean } = {}
) {
  const stub = {
    readCollectionMeta: vi.fn(
      async (collectionId: string): Promise<CollectionMetaRead | undefined> => {
        const answer = reads[collectionId]
        if (answer instanceof Error) {
          throw answer
        }
        return {
          description: {
            id: collectionId,
            type: ['Collection'],
            ...(answer && { encryption: answer }),
            custom: stored
          },
          etag: '"v1"'
        }
      }
    ),
    markCollectionEncrypted: vi.fn(async (collectionId: string) => ({
      collectionId,
      ok: true,
      skipped: true
    })),
    declareBlindedIndexes: vi.fn(async (collectionId: string) => ({
      collectionId,
      ok: true,
      wrote
    })),
    declareCollectionIndexes: vi.fn(async (collectionId: string) => ({
      collectionId,
      ok: true,
      skipped: true
    }))
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
  it('reports a failed collection read on failures, beside the readable ones', async () => {
    const failure = new Error('descriptor read failed')
    stubRemoteStore({ notes: descriptor, tasks: failure })

    expect(
      await readRemoteDescriptors({ parsed, zcapClient, collections })
    ).toEqual({
      descriptors: { notes: descriptor },
      failures: [{ collection: collections[1], err: failure }]
    })
  })

  it('keeps only the epoch-bearing descriptors when every read answers', async () => {
    stubRemoteStore({ notes: descriptor, tasks: undefined })

    expect(
      await readRemoteDescriptors({ parsed, zcapClient, collections })
    ).toEqual({ descriptors: { notes: descriptor }, failures: [] })
  })
})

describe('startWasSync descriptor read failure', () => {
  it('skips the failed collection entirely and bootstraps the rest', async () => {
    const capture = captureLogger('wr')
    const previous = setLogger(capture.logger)
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
    expect(
      capture.events.some(
        event =>
          event.level === 'warn' &&
          event.data?.collectionId === 'tasks' &&
          event.err instanceof Error
      )
    ).toBe(true)
    setLogger(previous)
    // Replication still starts.
    expect(syncController.start).toHaveBeenCalledTimes(1)
  })
})

describe('startWasSync blinded-index schema install', () => {
  const blinded = {
    ...descriptor,
    hmac: { id: 'urn:hmac', type: 'Sha256HmacKey2019' }
  } as unknown as CollectionEncryption

  /**
   * Runs the bootstrap over inert fakes and hands back what it touched.
   */
  async function bootstrap(
    knownDescriptors?: Record<string, CollectionEncryption>
  ) {
    const localStore = {
      applyRemoteDescriptor: vi.fn(async () => {}),
      applyCollectionMeta: vi.fn(async () => {}),
      setDescriptorSource: vi.fn()
    }
    const syncController = { start: vi.fn(async () => {}) }
    await startWasSync({
      parsed,
      zcapClient,
      collections,
      localStore: localStore as unknown as LocalStore,
      syncController: syncController as unknown as SyncController,
      onRemoteChange: () => {},
      ...(knownDescriptors && { knownDescriptors })
    })
    return { localStore, syncController }
  }

  it('installs the pre-read custom when the declaration wrote nothing', async () => {
    const remote = stubRemoteStore({ notes: blinded, tasks: undefined })
    const { localStore } = await bootstrap()

    // One read per granted collection, the pass's own, and no second one: the
    // object read before the declaration is still current.
    expect(
      remote.readCollectionMeta.mock.calls.map(([id]) => id).sort()
    ).toEqual(['notes', 'tasks'])
    expect(localStore.applyCollectionMeta).toHaveBeenCalledTimes(1)
    expect(localStore.applyCollectionMeta).toHaveBeenCalledWith({
      collectionId: 'notes',
      custom: stored
    })
    // The declarations were handed that same object.
    expect(remote.markCollectionEncrypted).toHaveBeenCalledWith('notes', {
      current: expect.objectContaining({ etag: '"v1"' }),
      encryption: blinded
    })
    expect(remote.declareCollectionIndexes).toHaveBeenCalledWith('tasks', {
      current: expect.objectContaining({ etag: '"v1"' })
    })
  })

  it('re-reads the object when the declaration wrote', async () => {
    const remote = stubRemoteStore(
      { notes: blinded, tasks: undefined },
      { wrote: true }
    )
    const { localStore } = await bootstrap()

    // The declaration replaced `custom`, so the pre-read copy is stale and the
    // install reads again -- for that collection only.
    expect(
      remote.readCollectionMeta.mock.calls.map(([id]) => id).sort()
    ).toEqual(['notes', 'notes', 'tasks'])
    expect(localStore.applyCollectionMeta).toHaveBeenCalledTimes(1)
  })

  it('reads for the install when a known descriptor skipped the pass read', async () => {
    const remote = stubRemoteStore({ notes: blinded, tasks: undefined })
    const { localStore } = await bootstrap({ notes: blinded })

    // `notes` was not read by the pass (its descriptor was known), so the
    // install is the one read it gets; the declarations ran without an object.
    expect(
      remote.readCollectionMeta.mock.calls.map(([id]) => id).sort()
    ).toEqual(['notes', 'tasks'])
    // A known descriptor is already epoch-bearing, so the encryption
    // declaration is handed it (and no read object) and skips the write.
    expect(remote.markCollectionEncrypted).toHaveBeenCalledWith('notes', {
      encryption: blinded
    })
    expect(localStore.applyCollectionMeta).toHaveBeenCalledWith({
      collectionId: 'notes',
      custom: stored
    })
  })

  it('warns and skips the install when the re-read fails', async () => {
    const capture = captureLogger('wr')
    const previous = setLogger(capture.logger)
    const remote = stubRemoteStore(
      { notes: blinded, tasks: undefined },
      { wrote: true }
    )
    // The pass's read answers; the install's re-read of `notes` (its second
    // read, the pass runs the collections concurrently) does not.
    const answer = remote.readCollectionMeta.getMockImplementation()!
    let notesReads = 0
    remote.readCollectionMeta.mockImplementation(async collectionId => {
      if (collectionId === 'notes' && ++notesReads === 2) {
        throw new Error('meta read failed')
      }
      return answer(collectionId)
    })
    const { localStore, syncController } = await bootstrap()

    expect(localStore.applyCollectionMeta).not.toHaveBeenCalled()
    expect(
      capture.events.some(
        event =>
          event.level === 'warn' &&
          event.msg.includes('Blinded-index schema install failed') &&
          event.data?.collectionId === 'notes' &&
          event.err instanceof Error
      )
    ).toBe(true)
    setLogger(previous)
    // The rest of the pass and replication are untouched.
    expect(
      remote.declareCollectionIndexes.mock.calls.map(([id]) => id).sort()
    ).toEqual(['notes', 'tasks'])
    expect(syncController.start).toHaveBeenCalledTimes(1)
  })
})
