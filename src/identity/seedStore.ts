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
 */
const SESSION_STORE = 'session'
const SEED_RECORD = 'seed'
const SESSION_RECORD = 'record'
const MARKERS_RECORD = 'markers'

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
   * Persists the collection-encryption marker cache (keyed by WAS collection
   * id), so an offline / hot-restore session can rebuild its epoch-aware
   * ciphers without a live description read.
   */
  saveMarkers(markers: unknown): Promise<void>
  /**
   * Loads the persisted marker cache, or `null`.
   */
  loadMarkers(): Promise<unknown | null>
  /**
   * Wipes the seed, the session record, and the marker cache (logout).
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
    async saveMarkers(markers: unknown): Promise<void> {
      await withSessionStore('readwrite', store =>
        store.put(markers, MARKERS_RECORD)
      )
    },
    async loadMarkers(): Promise<unknown | null> {
      const stored = await withSessionStore('readonly', store =>
        store.get(MARKERS_RECORD)
      )
      return stored ?? null
    },
    async clearSeedStore(): Promise<void> {
      await withSessionStore('readwrite', store => store.delete(SEED_RECORD))
      await withSessionStore('readwrite', store => store.delete(SESSION_RECORD))
      await withSessionStore('readwrite', store => store.delete(MARKERS_RECORD))
    }
  }
}
