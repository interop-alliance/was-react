/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Round-trip tests for the local encrypted store: real per-collection X25519
 * keys drive the was-client EDV codec end to end through RxDB (Dexie storage on
 * fake-indexeddb). Asserts create / list / in-place update (envelope id stable,
 * sequence advances) / delete, and that the at-rest row is ciphertext only.
 *
 * @vitest-environment node
 */
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalStore } from '../../src/storage/localStore.js'
import type { WasCollectionConfig } from '../../src/config.js'

// A neutral test collection registry (not any app's real collections).
const COLLECTIONS: WasCollectionConfig[] = [{ key: 'notes', id: 'notes' }]
const COLLECTION = 'notes'

// A fixed 32-byte master seed drives deterministic per-collection key derivation.
const SEED = new Uint8Array(32).map((_, index) => (index * 7 + 3) & 0xff)

interface NoteDoc {
  id: string
  title: string
  done: boolean
  category: string
  createdAt: string
  updatedAt: string
  deviceId: string
}

let dbCounter = 0
const openStores: LocalStore[] = []

async function openStore(dbName: string): Promise<LocalStore> {
  const store = await LocalStore.init({
    seed: SEED,
    collections: COLLECTIONS,
    dbName
  })
  openStores.push(store)
  return store
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
    deviceId: 'device-a'
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

/**
 * A singleton payload: one fixed logical id for the whole collection.
 */
function makeSingleton(
  over: Partial<NoteDoc> & Pick<NoteDoc, 'updatedAt' | 'deviceId'>
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
      deviceId: 'device-a'
    })
    const newer = makeSingleton({
      title: 'newer',
      updatedAt: '2026-02-02T00:00:00.000Z',
      deviceId: 'device-b'
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
      deviceId: 'device-a'
    })
    const newer = makeSingleton({
      title: 'new',
      updatedAt: '2026-02-02T00:00:00.000Z',
      deviceId: 'device-b'
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

  it('breaks an updatedAt tie by the greater deviceId', async () => {
    const store = await openStore(`was-react-test-${++dbCounter}`)
    const at = '2026-03-03T00:00:00.000Z'
    await store.insertEntity(
      COLLECTION,
      makeSingleton({ title: 'a', updatedAt: at, deviceId: 'device-a' })
    )
    await store.insertEntity(
      COLLECTION,
      makeSingleton({ title: 'z', updatedAt: at, deviceId: 'device-z' })
    )

    const winner = await store.hydrateSingleton<NoteDoc>(COLLECTION)
    expect(winner!.deviceId).toBe('device-z')
    expect(await store.rxCollection(COLLECTION).find().exec()).toHaveLength(1)
  })
})
