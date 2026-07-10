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
})
