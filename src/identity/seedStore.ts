/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Seed persistence: the master seed at rest in the app's own IndexedDB, so a
 * reload restores the session with zero wallet popups. A raw-IndexedDB pattern
 * (one db, one object store, fixed record keys, `db.close()` after every
 * operation). Wiped on logout.
 *
 * `createSeedStore` binds a database name (each app supplies its own) and an
 * optional `idb` factory (injectable for tests, e.g. fake-indexeddb), returning
 * the five bound operations.
 *
 * {@link createDescriptorCache} presents the descriptor record of one such
 * store as the `EncryptionDescriptorCache` seam
 * (`@interop/wallet-core/descriptors`), which is what the session's
 * descriptor acquisition reads and writes through.
 */
import type { CollectionEncryption } from '@interop/was-client'
import type { EncryptionDescriptorCache } from '@interop/wallet-core/descriptors'

const SESSION_STORE = 'session'
const SEED_RECORD = 'seed'
const SESSION_RECORD = 'record'
const DESCRIPTORS_RECORD = 'descriptors'

/**
 * The bound seed-store operations returned by `createSeedStore`.
 */
export interface SeedStore {
  /**
   * Persists the 32-byte master seed.
   */
  saveSeed(seed: Uint8Array): Promise<void>
  /**
   * Loads the persisted master seed, or `null`.
   */
  loadSeed(): Promise<Uint8Array | null>
  /**
   * Persists an opaque session record (see `appSession.ts`).
   */
  saveRecord(record: unknown): Promise<void>
  /**
   * Loads the persisted session record, or `null`.
   */
  loadRecord(): Promise<unknown | null>
  /**
   * Persists the collection-encryption descriptor cache (descriptors keyed by
   * WAS collection id, stamped with the controller DID they belong to), so an
   * offline / hot-restore session can rebuild its epoch-aware ciphers without
   * a live description read.
   */
  saveDescriptors(descriptors: unknown): Promise<void>
  /**
   * Loads the persisted descriptor cache, or `null`.
   */
  loadDescriptors(): Promise<unknown | null>
  /**
   * Wipes the seed, the session record, and the descriptor cache (logout).
   */
  clearSeedStore(): Promise<void>
}

/**
 * Creates a seed store bound to `dbName` and `idb`.
 *
 * @param options {object}
 * @param options.dbName {string}   the IndexedDB database name
 * @param [options.idb] {IDBFactory}   the IndexedDB factory (defaults to the
 *   global `indexedDB`; inject a fake for tests)
 * @returns {SeedStore}
 */
export function createSeedStore({
  dbName,
  idb = indexedDB
}: {
  dbName: string
  idb?: IDBFactory
}): SeedStore {
  async function openSessionDb(): Promise<IDBDatabase> {
    return await new Promise((resolve, reject) => {
      const request = idb.open(dbName, 1)
      request.onupgradeneeded = () => {
        request.result.createObjectStore(SESSION_STORE)
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () =>
        reject(request.error ?? new Error('IndexedDB open failed.'))
    })
  }

  async function withSessionStore(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest
  ): Promise<unknown> {
    const db = await openSessionDb()
    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction(SESSION_STORE, mode)
        const request = operation(transaction.objectStore(SESSION_STORE))
        request.onsuccess = () => resolve(request.result)
        request.onerror = () =>
          reject(request.error ?? new Error('IndexedDB operation failed.'))
      })
    } finally {
      db.close()
    }
  }

  return {
    async saveSeed(seed: Uint8Array): Promise<void> {
      await withSessionStore('readwrite', store => store.put(seed, SEED_RECORD))
    },
    async loadSeed(): Promise<Uint8Array | null> {
      const stored = await withSessionStore('readonly', store =>
        store.get(SEED_RECORD)
      )
      return stored instanceof Uint8Array && stored.length === 32
        ? stored
        : null
    },
    async saveRecord(record: unknown): Promise<void> {
      await withSessionStore('readwrite', store =>
        store.put(record, SESSION_RECORD)
      )
    },
    async loadRecord(): Promise<unknown | null> {
      const stored = await withSessionStore('readonly', store =>
        store.get(SESSION_RECORD)
      )
      return stored ?? null
    },
    async saveDescriptors(descriptors: unknown): Promise<void> {
      await withSessionStore('readwrite', store =>
        store.put(descriptors, DESCRIPTORS_RECORD)
      )
    },
    async loadDescriptors(): Promise<unknown | null> {
      const stored = await withSessionStore('readonly', store =>
        store.get(DESCRIPTORS_RECORD)
      )
      return stored ?? null
    },
    async clearSeedStore(): Promise<void> {
      // The object store holds exactly the seed, the session record, and the
      // descriptor cache, so one `clear()` is the whole wipe in one
      // transaction.
      await withSessionStore('readwrite', store => store.clear())
    }
  }
}

/**
 * Presents a {@link SeedStore}'s persisted descriptor record as the
 * `EncryptionDescriptorCache` seam that `@interop/wallet-core/descriptors`
 * acquires through: per-collection get/put over the single stored blob, already
 * scoped to one session's Space by the store it is bound to.
 *
 * The blob is stamped with the `controller` DID whose descriptors it holds, and
 * a cache bound to a different controller reads it as empty (and overwrites the
 * stamp on its first write). Descriptors name key-epoch rosters a specific
 * identity is a recipient of, so a login under a different controller than the
 * one that cached them must never trust them: a stale hit would build ciphers
 * the new identity cannot unwrap.
 *
 * The blob is read-modify-written on every put. That is fine at this scale (an
 * app registers a handful of collections) and it is the only shape the existing
 * one-record persistence allows; concurrent puts are serialized through a
 * promise chain so two of them cannot lose one another's entry.
 *
 * @param options {object}
 * @param options.store {SeedStore}   the session seed store to persist through
 * @param options.controller {string}   the controller DID the cached
 *   descriptors belong to
 * @returns {EncryptionDescriptorCache}
 */
export function createDescriptorCache({
  store,
  controller
}: {
  store: SeedStore
  controller: string
}): EncryptionDescriptorCache {
  async function readAll(): Promise<Record<string, CollectionEncryption>> {
    const stored = (await store.loadDescriptors()) as {
      controller?: unknown
      descriptors?: unknown
    } | null
    if (
      stored?.controller === controller &&
      stored.descriptors &&
      typeof stored.descriptors === 'object' &&
      !Array.isArray(stored.descriptors)
    ) {
      return { ...(stored.descriptors as Record<string, CollectionEncryption>) }
    }
    return {}
  }

  // Serializes the read-modify-write of the single stored record.
  let writes: Promise<void> = Promise.resolve()

  return {
    async readDescriptor({ collectionId }: { collectionId: string }) {
      return (await readAll())[collectionId]
    },
    writeDescriptor({
      collectionId,
      descriptor
    }: {
      collectionId: string
      descriptor: CollectionEncryption
    }) {
      const next = writes.then(async () => {
        const descriptors = await readAll()
        descriptors[collectionId] = descriptor
        await store.saveDescriptors({ controller, descriptors })
      })
      writes = next.then(
        () => {},
        () => {}
      )
      return next
    }
  }
}
