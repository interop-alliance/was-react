/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Round-trip tests for the local encrypted store: the app's real identity
 * X25519 key drives the was-client EDV codec end to end through RxDB (Dexie
 * storage on fake-indexeddb). Asserts create / list / in-place update (envelope id stable,
 * sequence advances) / delete, and that the at-rest row is ciphertext only. A
 * second block covers PUBLIC (plaintext) collections: payloads stored as-is
 * under their own logical id, alongside a private collection in the same store.
 * A third covers the row-level key-epoch stamp: a multi-recipient write persists
 * the epoch it sealed under, and a single-recipient re-encrypt clears a stale
 * one (so the push clears the server's stamp too).
 *
 * @vitest-environment node
 */
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { initRecipients, ownerRecipient } from '@interop/was-client/edv'
import type { CollectionEncryption } from '@interop/was-client'
import { LocalStore } from '../../src/storage/localStore.js'
import { deriveIdentity } from '../../src/identity/agents.js'
import type { WasCollectionConfig } from '../../src/config.js'

// A neutral test collection registry (not any app's real collections).
const COLLECTIONS: WasCollectionConfig[] = [{ key: 'notes', id: 'notes' }]
const COLLECTION = 'notes'

// A mixed registry: the private collection above plus a public (plaintext) one.
const MIXED: WasCollectionConfig[] = [
  { key: 'notes', id: 'notes' },
  { key: 'posts', id: 'microblog-posts', visibility: 'public' }
]
const PUBLIC_COLLECTION = 'posts'

// A fixed 32-byte master seed drives the deterministic identity derivation.
const SEED = new Uint8Array(32).map((_, index) => (index * 7 + 3) & 0xff)

interface NoteDoc {
  id: string
  title: string
  done: boolean
  category: string
  createdAt: string
  updatedAt: string
  clientId: string
}

let dbCounter = 0
const openStores: LocalStore[] = []

/**
 * The app's identity KAK + resolver, derived once from the fixed test seed:
 * the key material every private collection's cipher is built on.
 */
async function identityKeys() {
  const { keyAgreementKey, keyResolver } = await deriveIdentity({ seed: SEED })
  return { keyAgreementKey, keyResolver }
}

async function openStore(
  dbName: string,
  collections: WasCollectionConfig[] = COLLECTIONS,
  descriptors?: Record<string, CollectionEncryption>
): Promise<LocalStore> {
  const store = await LocalStore.init({
    ...(await identityKeys()),
    collections,
    dbName,
    ...(descriptors && { descriptors })
  })
  openStores.push(store)
  return store
}

/**
 * A one-epoch encryption descriptor whose sole recipient is the app's identity
 * KAK, minted with was-client's own `initRecipients` against an in-memory
 * collection stub (the same shape the offline descriptor cache holds).
 */
async function mintDescriptor(): Promise<CollectionEncryption> {
  const { keyAgreementKey } = await identityKeys()
  let description: Record<string, unknown> = {
    name: COLLECTION,
    encryption: { scheme: 'edv' }
  }
  const collection = {
    async describeWithEtag() {
      return { description: { ...description }, etag: 'etag-0' }
    },
    async replaceDescription(next: Record<string, unknown>) {
      description = next
    }
  }
  return initRecipients({
    collection: collection as unknown as Parameters<
      typeof initRecipients
    >[0]['collection'],
    recipients: [ownerRecipient({ keyAgreementKey })]
  })
}

/**
 * The single at-rest ROW of a collection (envelope plus its sync metadata).
 */
async function rawRow(
  store: LocalStore
): Promise<{ id: string; epoch?: string }> {
  const rows = await store.rxCollection(COLLECTION).find().exec()
  expect(rows).toHaveLength(1)
  return rows[0]!.toMutableJSON() as unknown as { id: string; epoch?: string }
}

function makeNote(title: string): NoteDoc {
  const now = new Date().toISOString()
  return {
    id: crypto.randomUUID(),
    title,
    done: false,
    category: 'someday',
    createdAt: now,
    updatedAt: now,
    clientId: 'device-a'
  }
}

/**
 * The single at-rest envelope in a collection, read raw (undecrypted).
 */
async function rawEnvelope(
  store: LocalStore
): Promise<{ id: string; sequence: number; jwe: unknown }> {
  const rows = await store.rxCollection(COLLECTION).find().exec()
  expect(rows).toHaveLength(1)
  return rows[0]!.toMutableJSON().data as unknown as {
    id: string
    sequence: number
    jwe: unknown
  }
}

afterEach(async () => {
  while (openStores.length > 0) {
    await openStores.pop()!.close()
  }
})

describe('LocalStore entity CRUD', () => {
  it('round-trips insert / list and stores only ciphertext', async () => {
    const store = await openStore(`was-react-test-${++dbCounter}`)
    const note = makeNote('Buy distinctive-oat-milk-token')

    await store.insertEntity(COLLECTION, note)

    const listed = await store.listEntities<NoteDoc>(COLLECTION)
    expect(listed).toHaveLength(1)
    expect(listed[0]).toEqual(note)

    const envelope = await rawEnvelope(store)
    expect(typeof envelope.jwe).toBe('object')
    expect(envelope.jwe).not.toBeNull()
    // No plaintext field value leaks into the stored row.
    expect(JSON.stringify(envelope)).not.toContain('distinctive-oat-milk-token')
    expect(JSON.stringify(envelope)).not.toContain('someday')
  })

  it('re-encrypts in place: same envelope id, advancing sequence', async () => {
    const store = await openStore(`was-react-test-${++dbCounter}`)
    const note = makeNote('First title')
    await store.insertEntity(COLLECTION, note)

    const before = await rawEnvelope(store)

    const updated: NoteDoc = {
      ...note,
      title: 'Second title',
      done: true,
      updatedAt: new Date().toISOString()
    }
    await store.updateEntity(COLLECTION, updated)

    const after = await rawEnvelope(store)
    // Same physical envelope (stable random EDV id), advanced sequence.
    expect(after.id).toBe(before.id)
    expect(after.sequence).toBeGreaterThan(before.sequence)

    const listed = await store.listEntities<NoteDoc>(COLLECTION)
    expect(listed).toHaveLength(1)
    expect(listed[0]!.title).toBe('Second title')
    expect(listed[0]!.done).toBe(true)
  })

  it('tombstones on delete', async () => {
    const store = await openStore(`was-react-test-${++dbCounter}`)
    const note = makeNote('Ephemeral')
    await store.insertEntity(COLLECTION, note)
    expect(await store.listEntities<NoteDoc>(COLLECTION)).toHaveLength(1)

    await store.deleteEntity(COLLECTION, note.id)

    expect(await store.listEntities<NoteDoc>(COLLECTION)).toHaveLength(0)
    const rows = await store.rxCollection(COLLECTION).find().exec()
    expect(rows).toHaveLength(0)
  })

  it('upserts: inserts once then updates in place under a stable envelope', async () => {
    const store = await openStore(`was-react-test-${++dbCounter}`)
    const note = makeNote('Upserted')
    // Hydrate first so the index exists (a singleton store hydrates before it
    // ever writes).
    await store.listEntities<NoteDoc>(COLLECTION)

    await store.upsertEntity(COLLECTION, note)
    const first = await rawEnvelope(store)

    const edited: NoteDoc = { ...note, title: 'Upserted again' }
    await store.upsertEntity(COLLECTION, edited)
    const second = await rawEnvelope(store)

    // One row, same envelope id (update, not a second insert).
    expect(second.id).toBe(first.id)
    expect(second.sequence).toBeGreaterThan(first.sequence)
    const listed = await store.listEntities<NoteDoc>(COLLECTION)
    expect(listed).toHaveLength(1)
    expect(listed[0]!.title).toBe('Upserted again')
  })

  it('resurrects as a create when the envelope was deleted elsewhere', async () => {
    const store = await openStore(`was-react-test-${++dbCounter}`)
    const note = makeNote('Edited after remote delete')
    await store.insertEntity(COLLECTION, note)
    const original = await rawEnvelope(store)

    // Simulate a remote tombstone being pulled: the row is removed and the
    // uuid forgotten from the index (what forgetEnvelope + drop do).
    await store.deleteEntity(COLLECTION, note.id)
    expect(await store.listEntities<NoteDoc>(COLLECTION)).toHaveLength(0)

    // A concurrent local edit must not throw; it resurrects the entity.
    const edited: NoteDoc = {
      ...note,
      title: 'Resurrected',
      updatedAt: new Date().toISOString()
    }
    await store.updateEntity(COLLECTION, edited)

    const listed = await store.listEntities<NoteDoc>(COLLECTION)
    expect(listed).toHaveLength(1)
    expect(listed[0]!.title).toBe('Resurrected')
    // A fresh envelope was minted (the old one is gone).
    const resurrected = await rawEnvelope(store)
    expect(resurrected.id).not.toBe(original.id)
  })

  it('persists across a store reopen (survives reload)', async () => {
    const dbName = `was-react-test-${++dbCounter}`
    const store = await openStore(dbName)
    const note = makeNote('Durable note')
    await store.insertEntity(COLLECTION, note)
    await store.close()
    openStores.pop()

    const reopened = await openStore(dbName)
    const listed = await reopened.listEntities<NoteDoc>(COLLECTION)
    expect(listed).toHaveLength(1)
    expect(listed[0]).toEqual(note)
  })

  it('remove() deletes the database: a re-init opens empty', async () => {
    const dbName = `was-react-test-${++dbCounter}`
    const store = await openStore(dbName)
    await store.insertEntity(COLLECTION, makeNote('Doomed note'))
    expect(await store.listEntities<NoteDoc>(COLLECTION)).toHaveLength(1)

    await store.remove()
    openStores.pop()

    // Re-init under the same name sees a fresh, empty database (remove deleted
    // the underlying store, unlike close which keeps the data).
    const reopened = await openStore(dbName)
    expect(await reopened.listEntities<NoteDoc>(COLLECTION)).toHaveLength(0)
  })
})

describe('LocalStore key-epoch stamping', () => {
  it('persists the epoch the envelope was sealed under onto the row', async () => {
    const encryption = await mintDescriptor()
    const store = await openStore(
      `was-react-test-${++dbCounter}`,
      COLLECTIONS,
      {
        [COLLECTION]: encryption
      }
    )
    const note = makeNote('Sealed under an epoch')

    await store.insertEntity(COLLECTION, note)
    // The stamp rides the content push as the `WAS-Key-Epoch` header.
    expect((await rawRow(store)).epoch).toBe(encryption.currentEpoch)

    // A re-encrypt under the same multi-recipient cipher keeps it.
    await store.updateEntity(COLLECTION, { ...note, title: 'Still sealed' })
    expect((await rawRow(store)).epoch).toBe(encryption.currentEpoch)
    expect(await store.listEntities<NoteDoc>(COLLECTION)).toHaveLength(1)
  })

  it('clears a stale epoch when the re-encrypt is single-recipient', async () => {
    const store = await openStore(`was-react-test-${++dbCounter}`)
    const note = makeNote('Stamped once')
    await store.insertEntity(COLLECTION, note)
    // A single-recipient cipher stamps nothing.
    expect((await rawRow(store)).epoch).toBeUndefined()

    // Stamp the row as an earlier multi-recipient write (or a pulled row that
    // carried the server's stamp) would have.
    const rows = await store.rxCollection(COLLECTION).find().exec()
    await rows[0]!.incrementalModify(docData => {
      docData.epoch = 'epoch-stale'
      return docData
    })
    expect((await rawRow(store)).epoch).toBe('epoch-stale')

    await store.updateEntity(COLLECTION, { ...note, title: 'Re-encrypted' })

    // The stale stamp is REMOVED (not merely left behind), so the push clears
    // the server's stamp too.
    expect((await rawRow(store)).epoch).toBeUndefined()
  })
})

/**
 * A singleton payload: one fixed logical id for the whole collection.
 */
function makeSingleton(
  over: Partial<NoteDoc> & Pick<NoteDoc, 'updatedAt' | 'clientId'>
): NoteDoc {
  return {
    id: '_singleton',
    title: 'current',
    done: false,
    category: 'selection',
    createdAt: over.updatedAt,
    ...over
  }
}

describe('LocalStore singleton hydration', () => {
  it('returns null and an empty collection when nothing is stored', async () => {
    const store = await openStore(`was-react-test-${++dbCounter}`)
    expect(await store.hydrateSingleton<NoteDoc>(COLLECTION)).toBeNull()
  })

  it('reconciles duplicate singletons to the LWW winner and tombstones the rest', async () => {
    const store = await openStore(`was-react-test-${++dbCounter}`)
    // Two devices each created the singleton before syncing: distinct envelope
    // rows that both decrypt to `_singleton`.
    const older = makeSingleton({
      title: 'older',
      updatedAt: '2026-01-01T00:00:00.000Z',
      clientId: 'device-a'
    })
    const newer = makeSingleton({
      title: 'newer',
      updatedAt: '2026-02-02T00:00:00.000Z',
      clientId: 'device-b'
    })
    await store.insertEntity(COLLECTION, older)
    await store.insertEntity(COLLECTION, newer)
    // Two physical rows, one logical id.
    expect(await store.rxCollection(COLLECTION).find().exec()).toHaveLength(2)

    const winner = await store.hydrateSingleton<NoteDoc>(COLLECTION)
    expect(winner).toEqual(newer)
    // The loser row is tombstoned, so exactly one live row remains.
    expect(await store.rxCollection(COLLECTION).find().exec()).toHaveLength(1)

    // A subsequent write routes as an in-place update on the surviving row (no
    // third envelope is minted).
    const moved: NoteDoc = { ...newer, title: 'moved' }
    await store.upsertEntity(COLLECTION, moved)
    expect(await store.rxCollection(COLLECTION).find().exec()).toHaveLength(1)
    const listed = await store.listEntities<NoteDoc>(COLLECTION)
    expect(listed).toHaveLength(1)
    expect(listed[0]!.title).toBe('moved')
  })

  it('maps the logical id to the surviving envelope after reconciliation', async () => {
    const store = await openStore(`was-react-test-${++dbCounter}`)
    const older = makeSingleton({
      title: 'old',
      updatedAt: '2026-01-01T00:00:00.000Z',
      clientId: 'device-a'
    })
    const newer = makeSingleton({
      title: 'new',
      updatedAt: '2026-02-02T00:00:00.000Z',
      clientId: 'device-b'
    })
    await store.insertEntity(COLLECTION, older)
    await store.insertEntity(COLLECTION, newer)

    await store.hydrateSingleton<NoteDoc>(COLLECTION)
    // The index points at the one live row, so a tombstone for any OTHER
    // (reconciled-away) envelope can be told apart from a real deletion.
    const rows = await store.rxCollection(COLLECTION).find().exec()
    expect(rows).toHaveLength(1)
    expect(store.envelopeIdFor(COLLECTION, newer.id)).toBe(rows[0]!.id)
  })

  it('breaks an updatedAt tie by the greater clientId', async () => {
    const store = await openStore(`was-react-test-${++dbCounter}`)
    const at = '2026-03-03T00:00:00.000Z'
    await store.insertEntity(
      COLLECTION,
      makeSingleton({ title: 'a', updatedAt: at, clientId: 'device-a' })
    )
    await store.insertEntity(
      COLLECTION,
      makeSingleton({ title: 'z', updatedAt: at, clientId: 'device-z' })
    )

    const winner = await store.hydrateSingleton<NoteDoc>(COLLECTION)
    expect(winner!.clientId).toBe('device-z')
    expect(await store.rxCollection(COLLECTION).find().exec()).toHaveLength(1)
  })
})

describe('LocalStore public (plaintext) collections', () => {
  it('stores the payload as-is under its own logical id', async () => {
    const store = await openStore(`was-react-test-${++dbCounter}`, MIXED)
    const post = makeNote('World-readable post')

    await store.insertEntity(PUBLIC_COLLECTION, post)

    const rows = await store.rxCollection(PUBLIC_COLLECTION).find().exec()
    expect(rows).toHaveLength(1)
    const row = rows[0]!.toMutableJSON()
    // One id plane: the row (WAS resource) id IS the payload uuid.
    expect(row.id).toBe(post.id)
    // The stored body is the payload verbatim -- no envelope, no ciphertext.
    expect(row.data).toEqual(post)

    const listed = await store.listEntities<NoteDoc>(PUBLIC_COLLECTION)
    expect(listed).toHaveLength(1)
    expect(listed[0]).toEqual(post)
  })

  it('updates in place under the same row id', async () => {
    const store = await openStore(`was-react-test-${++dbCounter}`, MIXED)
    const post = makeNote('First revision')
    await store.insertEntity(PUBLIC_COLLECTION, post)

    const edited: NoteDoc = {
      ...post,
      title: 'Second revision',
      updatedAt: new Date().toISOString()
    }
    await store.updateEntity(PUBLIC_COLLECTION, edited)

    const rows = await store.rxCollection(PUBLIC_COLLECTION).find().exec()
    expect(rows).toHaveLength(1)
    const row = rows[0]!.toMutableJSON()
    // The resource URL stays stable across edits (same row id).
    expect(row.id).toBe(post.id)
    expect(row.data).toEqual(edited)
  })

  it('tombstones on delete and upserts without a prior hydrate', async () => {
    const store = await openStore(`was-react-test-${++dbCounter}`, MIXED)
    const post = makeNote('Short-lived')
    await store.upsertEntity(PUBLIC_COLLECTION, post)
    expect(await store.listEntities<NoteDoc>(PUBLIC_COLLECTION)).toHaveLength(1)

    await store.deleteEntity(PUBLIC_COLLECTION, post.id)
    expect(await store.listEntities<NoteDoc>(PUBLIC_COLLECTION)).toHaveLength(0)
  })

  it('keeps the private collection encrypted in the same store', async () => {
    const store = await openStore(`was-react-test-${++dbCounter}`, MIXED)
    const secret = makeNote('secret-note-body')
    await store.insertEntity(COLLECTION, secret)

    const rows = await store.rxCollection(COLLECTION).find().exec()
    expect(rows).toHaveLength(1)
    const row = rows[0]!.toMutableJSON()
    // The private collection still stores an EDV envelope under a random id.
    expect(row.id).not.toBe(secret.id)
    expect(JSON.stringify(row.data)).not.toContain('secret-note-body')

    const listed = await store.listEntities<NoteDoc>(COLLECTION)
    expect(listed).toHaveLength(1)
    expect(listed[0]).toEqual(secret)
  })

  it('refuses to read an EDV envelope out of a public collection', async () => {
    const store = await openStore(`was-react-test-${++dbCounter}`, MIXED)
    // Simulate a visibility misconfiguration: a ciphertext row (e.g. written
    // while the collection was private) sitting in a now-public collection.
    await store.rxCollection(PUBLIC_COLLECTION).insert({
      id: 'stray-envelope',
      updatedAt: new Date().toISOString(),
      version: 0,
      data: { id: 'stray-envelope', sequence: 0, jwe: { protected: 'x' } }
    })

    await expect(
      store.listEntities<NoteDoc>(PUBLIC_COLLECTION)
    ).rejects.toThrow(/public \(plaintext\)/)
  })

  it('rejects a registry mapping one WAS id to both visibilities', async () => {
    await expect(
      LocalStore.init({
        ...(await identityKeys()),
        collections: [
          { key: 'a', id: 'shared' },
          { key: 'b', id: 'shared', visibility: 'public' }
        ],
        dbName: `was-react-test-${++dbCounter}`
      })
    ).rejects.toThrow(/encrypted and public/)
  })
})
