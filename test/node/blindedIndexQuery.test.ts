/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * End-to-end blinded-index query against a real in-process was-teaching-server
 * (the published npm package): provisions a dev Space with a PRIVATE
 * (encrypted) collection carrying a blinded-index key, lets the sync bootstrap
 * declare the registry's index attributes into the collection's encrypted
 * metadata, writes documents through the index-aware codec path, and queries
 * them back through the `blinded-index` profile -- both directly on the remote
 * store and through the app-facing entity-store verb.
 *
 * @vitest-environment node
 */
import 'fake-indexeddb/auto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp, FileSystemBackend } from 'was-teaching-server'
import { provisionDevGrants } from '../../src/dev/provisionDevGrants.js'
import { parseGrants, type ParsedGrants } from '../../src/grants.js'
import { deriveIdentity } from '../../src/identity/agents.js'
import { LocalStore } from '../../src/storage/localStore.js'
import { createEntityStore } from '../../src/storage/entityStore.js'
import {
  clearLocalStore,
  clearRemoteStore,
  setLocalStore,
  setRemoteStore
} from '../../src/storage/storageManager.js'
import { startWasSync } from '../../src/storage/wasSync.js'
import { SyncController } from '../../src/storage/syncController.js'
import { WasRemoteStore } from '../../src/storage/wasRemoteStore.js'
import type { ZcapClient } from '@interop/ezcap'
import type {
  IKeyAgreementKey,
  IKeyResolver
} from '@interop/data-integrity-core'
import type { WasCollectionConfig } from '../../src/config.js'

// The SyncController wires an `online` listener on `window`; Node has no
// window, so give it an inert stand-in.
;(globalThis as { window?: unknown }).window ??= {
  addEventListener: () => {},
  removeEventListener: () => {}
}

const PRIVATE_ID = 'indexed-notes'
// A second private collection, provisioned WITHOUT a blinding key: nothing to
// install, so the bootstrap must not spend a metadata read on it.
const PLAIN_ID = 'plain-notes'
const REGISTRY: WasCollectionConfig[] = [
  { key: 'notes', id: PRIVATE_ID, indexes: ['title'] },
  { key: 'plain', id: PLAIN_ID }
]

// A fixed 32-byte app (relying party) master seed, distinct from the other
// integration suites' so the two never share a provisioned Space.
const SEED = new Uint8Array(32).map((_, index) => (index * 7 + 11) & 0xff)

const SHARED_TITLE = 'a blinded title'

interface NoteDoc {
  // The index signature is what lets a note be handed to the codec write path
  // (`Collection.add` takes a `JsonObject`); every field here is a string.
  [field: string]: string
  id: string
  title: string
  updatedAt: string
  writerId: string
}

function makeNote(title: string): NoteDoc {
  return {
    id: crypto.randomUUID(),
    title,
    updatedAt: new Date().toISOString(),
    writerId: 'writer-test'
  }
}

/**
 * An OS-assigned free TCP port (bound and released before the server starts).
 */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => {
        if (address !== null && typeof address === 'object') {
          resolve(address.port)
        } else {
          reject(new Error('No port assigned.'))
        }
      })
    })
  })
}

let dataDir: string
let app: Awaited<ReturnType<typeof createApp>>
let parsed: ParsedGrants
let zcapClient: ZcapClient
let identityKeys: {
  keyAgreementKey: IKeyAgreementKey
  keyResolver: IKeyResolver
}
let localStore: LocalStore
let syncController: SyncController
let remoteStore: WasRemoteStore

// Two notes share a title (for paging); the third is the negative control.
const matching = [makeNote(SHARED_TITLE), makeNote(SHARED_TITLE)]
const other = makeNote('an unrelated title')

/**
 * The collection handle every codec-path write and schema read goes through:
 * the remote store's own `WasClient`, whose keystore answers with this app's
 * identity keys, invoking the collection's delegated zcap.
 */
function collectionHandle() {
  return remoteStore.was.space(remoteStore.spaceId).collection(PRIVATE_ID, {
    capability: remoteStore.collectionCapability(PRIVATE_ID)
  })
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'was-react-blinded-'))
  const port = await freePort()
  const serverUrl = `http://localhost:${port}`
  app = createApp({
    serverUrl,
    backend: new FileSystemBackend({ dataDir, capacityBytes: Infinity })
  })
  await app.listen({ port, host: '0.0.0.0' })

  // The blinding key installs with the collection's first key epoch or never.
  const provisioned = await provisionDevGrants({
    serverUrl,
    seed: SEED,
    collections: [
      { id: PRIVATE_ID, visibility: 'private', blindedIndex: true },
      { id: PLAIN_ID, visibility: 'private' }
    ]
  })
  parsed = parseGrants(provisioned.grants)
  const identity = await deriveIdentity({ seed: SEED })
  zcapClient = identity.zcapClient
  identityKeys = {
    keyAgreementKey: identity.keyAgreementKey,
    keyResolver: identity.keyResolver
  }

  localStore = await LocalStore.init({
    ...identityKeys,
    collections: REGISTRY,
    dbName: 'blinded-index-query'
  })
  syncController = new SyncController({
    collections: REGISTRY,
    sync: { pollMs: 500, retryMs: 500 }
  })
  // The bootstrap is what declares the registry's index attributes into the
  // collection's encrypted metadata.
  ;({ remoteStore } = await startWasSync({
    parsed,
    zcapClient,
    collections: REGISTRY,
    localStore,
    syncController,
    onRemoteChange: () => {},
    identityKeys
  }))
}, 60000)

afterAll(async () => {
  await syncController?.stop()
  await localStore?.close()
  await app.close()
  await rm(dataDir, { recursive: true, force: true })
}, 60000)

describe('blinded-index query against was-teaching-server', () => {
  it('declares the registry attributes into the encrypted schema', async () => {
    // The schema is collection state, readable by any recipient. The attribute
    // is rooted at the EDV document's `content`, which for a JSON payload IS
    // the stored payload verbatim.
    const declared = await collectionHandle().indexes()
    expect(declared.map(entry => entry.attribute)).toEqual(['content.title'])

    // Re-declaring is a no-op: only missing attributes are written.
    const again = await remoteStore.declareBlindedIndexes(PRIVATE_ID, {
      encryption: await remoteStore.readCollectionEncryption(PRIVATE_ID)
    })
    expect(again).toEqual({ collectionId: PRIVATE_ID, ok: true })
    const unchanged = await collectionHandle().indexes()
    expect(unchanged.map(entry => entry.attribute)).toEqual(['content.title'])
  }, 60000)

  it('finds codec-written documents by a blinded term', async () => {
    // Written through the index-aware codec path, so each stored envelope
    // carries blinded `indexed` entries alongside its ciphertext.
    for (const note of [...matching, other]) {
      await collectionHandle().add(note)
    }

    const page = await remoteStore.queryCollectionByEquality({
      collectionId: PRIVATE_ID,
      equals: { title: SHARED_TITLE }
    })
    expect(page.hasMore).toBe(false)
    expect(page.documents.map(document => document.data)).toEqual(
      expect.arrayContaining(matching)
    )
    expect(page.documents).toHaveLength(matching.length)

    // A non-matching term answers an empty page, not an error.
    const empty = await remoteStore.queryCollectionByEquality({
      collectionId: PRIVATE_ID,
      equals: { title: 'no such title' }
    })
    expect(empty).toEqual({ documents: [], hasMore: false })

    // An undeclared attribute fails closed client-side.
    await expect(
      remoteStore.queryCollectionByEquality({
        collectionId: PRIVATE_ID,
        equals: { writerId: matching[0]!.writerId }
      })
    ).rejects.toThrow(/not declared/)
  }, 60000)

  it('walks the matches a page at a time', async () => {
    const first = await remoteStore.queryCollectionByEquality({
      collectionId: PRIVATE_ID,
      equals: { title: SHARED_TITLE },
      limit: 1
    })
    expect(first.documents).toHaveLength(1)
    expect(first.hasMore).toBe(true)
    expect(typeof first.cursor).toBe('string')

    const second = await remoteStore.queryCollectionByEquality({
      collectionId: PRIVATE_ID,
      equals: { title: SHARED_TITLE },
      limit: 1,
      cursor: first.cursor as string
    })
    expect(second.documents).toHaveLength(1)
    expect(second.hasMore).toBe(false)
    // The two pages cover the match set exactly once each.
    expect([
      ...first.documents.map(document => document.data),
      ...second.documents.map(document => document.data)
    ]).toEqual(expect.arrayContaining(matching))
  }, 60000)

  it('indexes documents written through the local sync path', async () => {
    // The bootstrap installed the collection's persisted schema on the
    // replica's cipher, so an ordinary local write carries blinded `indexed`
    // entries and reaches the server findable.
    const note = makeNote('a locally written title')
    await localStore.insertEntity('notes', note)

    const envelopeId = localStore.envelopeIdFor('notes', note.id)
    expect(envelopeId).toBeDefined()
    const row = await localStore
      .rxCollection('notes')
      .findOne(envelopeId as string)
      .exec()
    const envelope = row?.toMutableJSON().data as
      { indexed?: unknown[] } | undefined
    expect(envelope?.indexed).toHaveLength(1)

    // Once replication has pushed it, the blinded query finds it like any
    // codec-written document.
    const deadline = Date.now() + 30000
    let found: unknown[] = []
    while (Date.now() < deadline && found.length === 0) {
      const page = await remoteStore.queryCollectionByEquality({
        collectionId: PRIVATE_ID,
        equals: { title: note.title }
      })
      found = page.documents
      if (found.length === 0) {
        await new Promise(resolve => setTimeout(resolve, 250))
      }
    }
    expect(found).toHaveLength(1)
  }, 60000)

  it('reads the metadata only for a collection with a blinding key', async () => {
    // A second bring-up over the same Space, watched: the metadata read must
    // follow the declaration (which may have written fresh attributes into the
    // schema) and must not be spent on the collection with no blinding key.
    const order: string[] = []
    const declared = vi
      .spyOn(WasRemoteStore.prototype, 'declareBlindedIndexes')
      .mockImplementation(async function (
        this: WasRemoteStore,
        collectionId: string
      ) {
        order.push(`declare:${collectionId}`)
        return { collectionId, ok: true }
      })
    const read = vi
      .spyOn(WasRemoteStore.prototype, 'readCollectionMeta')
      .mockImplementation(async (collectionId: string) => {
        order.push(`meta:${collectionId}`)
        return { custom: undefined }
      })
    const applied = vi.spyOn(LocalStore.prototype, 'applyCollectionMeta')

    const watchedController = new SyncController({
      collections: REGISTRY,
      sync: { pollMs: 500, retryMs: 500 }
    })
    const watchedStore = await LocalStore.init({
      ...identityKeys,
      collections: REGISTRY,
      dbName: 'blinded-index-bootstrap'
    })
    try {
      await startWasSync({
        parsed,
        zcapClient,
        collections: REGISTRY,
        localStore: watchedStore,
        syncController: watchedController,
        onRemoteChange: () => {},
        identityKeys
      })
      expect(order).toContain(`declare:${PRIVATE_ID}`)
      expect(order.indexOf(`meta:${PRIVATE_ID}`)).toBeGreaterThan(
        order.indexOf(`declare:${PRIVATE_ID}`)
      )
      // No blinding key on the second collection: no metadata read at all.
      expect(order).not.toContain(`meta:${PLAIN_ID}`)
      expect(
        applied.mock.calls.map(([options]) => options.collectionId)
      ).toEqual([PRIVATE_ID])
    } finally {
      await watchedController.stop()
      await watchedStore.remove()
      declared.mockRestore()
      read.mockRestore()
      applied.mockRestore()
    }
  }, 60000)

  it('warns and continues when the schema install fails', async () => {
    const read = vi
      .spyOn(WasRemoteStore.prototype, 'readCollectionMeta')
      .mockResolvedValue({ custom: { not: 'an envelope' } })
    const applied = vi
      .spyOn(LocalStore.prototype, 'applyCollectionMeta')
      .mockRejectedValue(new Error('undecodable metadata envelope'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const watchedController = new SyncController({
      collections: REGISTRY,
      sync: { pollMs: 500, retryMs: 500 }
    })
    const watchedStore = await LocalStore.init({
      ...identityKeys,
      collections: REGISTRY,
      dbName: 'blinded-index-bootstrap-failure'
    })
    try {
      // The bootstrap still resolves: the install is best-effort like every
      // other declaration on this pass.
      const bootstrap = await startWasSync({
        parsed,
        zcapClient,
        collections: REGISTRY,
        localStore: watchedStore,
        syncController: watchedController,
        onRemoteChange: () => {},
        identityKeys
      })
      expect(bootstrap.remoteStore).toBeDefined()
      expect(
        warn.mock.calls.some(([message]) =>
          String(message).includes('Blinded-index schema install failed')
        )
      ).toBe(true)
    } finally {
      await watchedController.stop()
      await watchedStore.remove()
      read.mockRestore()
      applied.mockRestore()
      warn.mockRestore()
    }
  }, 60000)

  it('answers the entity-store query verb end to end', async () => {
    // The app-facing verb, through the process-wide holders: key routing, the
    // blinded query, and the decrypted-payload mapping.
    setLocalStore(localStore)
    setRemoteStore(remoteStore)
    try {
      const notes = createEntityStore<NoteDoc>('notes')
      const result = await notes
        .getState()
        .query({ equals: { title: SHARED_TITLE } })
      expect(result.hasMore).toBe(false)
      expect(result.docs).toEqual(expect.arrayContaining(matching))
      expect(result.docs).toHaveLength(matching.length)
    } finally {
      clearLocalStore()
      clearRemoteStore()
    }
  }, 60000)
})
