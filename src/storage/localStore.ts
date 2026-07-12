/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * LocalStore: the always-on local encrypted replica. A GENERIC per-entity
 * envelope store over an app's registered collections. Owns one RxDB
 * (Dexie/IndexedDB) database holding one collection per entity on the shared
 * `syncedDocSchema()`; every at-rest row is `{ id, updatedAt, version, data }`
 * where `data` is the EDV envelope `{ id, sequence, jwe }` -- the server never
 * sees plaintext.
 *
 * Two id planes: the logical entity `uuid` lives INSIDE the encrypted payload;
 * the RxDB primary key is the opaque random EDV envelope id. An in-memory
 * `uuid -> envelopeId` index (built during hydration) routes updates/deletes.
 * Two timestamp planes: the row-level `updatedAt` is only the sync checkpoint;
 * the payload's own `createdAt` / `updatedAt` (inside the ciphertext) drive
 * domain sorting and LWW.
 *
 * Writes: create mints a fresh random envelope; update re-encrypts under the
 * SAME envelope id with `sequence`+1 (the mutable-head model); delete is an RxDB
 * soft-delete tombstone.
 */
import {
  createRxDatabase,
  type RxCollection,
  type RxDatabase,
  type RxStorage
} from 'rxdb/plugins/core'
import { getRxStorageDexie } from 'rxdb/plugins/storage-dexie'
import { DEFAULT_DB_NAME, type WasCollectionConfig } from '../config.js'
import {
  syncedDocSchema,
  createDocCipher,
  makeLwwConflictHandler,
  remotePayloadWins,
  type Json,
  type SyncedDoc,
  type DocCipher
} from '../sync/index.js'
import { deriveCollectionKeys } from '../identity/agents.js'

// A logical entity payload: the minimum this store needs is a logical `id`
// (uuidv7) to index and route mutable-head updates by. The rest of the payload
// is opaque JSON to this generic layer.
type EntityPayload = { id: string }

/**
 * A stable, RxDB-safe database name per controller DID (FNV-1a hex), so two
 * wallet users on one browser never collide on the same local database.
 *
 * @param options {object}
 * @param options.dbName {string}   the app's base database name
 * @param options.controllerDid {string}   the session controller DID
 * @returns {string}
 */
export function dbNameForController({
  dbName,
  controllerDid
}: {
  dbName: string
  controllerDid: string
}): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < controllerDid.length; index++) {
    hash ^= controllerDid.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${dbName}-${hash.toString(16).padStart(8, '0')}`
}

/**
 * The local encrypted store. Construct via {@link LocalStore.init}, which
 * derives the per-collection ciphers from the master seed and opens RxDB.
 */
export class LocalStore {
  private _db: RxDatabase
  private _collections: Record<string, RxCollection<SyncedDoc>>
  private _ciphers: Record<string, DocCipher>
  // Per-collection logical-uuid -> envelope (RxDB primary key) index.
  private _index: Record<string, Map<string, string>>

  private constructor({
    db,
    collections,
    ciphers
  }: {
    db: RxDatabase
    collections: Record<string, RxCollection<SyncedDoc>>
    ciphers: Record<string, DocCipher>
  }) {
    this._db = db
    this._collections = collections
    this._ciphers = ciphers
    this._index = {}
  }

  /**
   * Opens (or creates) the encrypted store: derives a per-collection KAK + cipher
   * from the master seed and opens one RxDB collection per entity.
   *
   * @param options {object}
   * @param options.seed {Uint8Array}   the 32-byte master seed
   * @param options.collections {WasCollectionConfig[]}   the collection registry
   *   (logical key to WAS collection id)
   * @param [options.storage] {RxStorage<unknown, unknown>}   defaults to
   *   Dexie/IndexedDB; injectable for tests
   * @param [options.dbName] {string}   defaults to {@link DEFAULT_DB_NAME}
   * @returns {Promise<LocalStore>}
   */
  static async init({
    seed,
    collections,
    storage,
    dbName = DEFAULT_DB_NAME
  }: {
    seed: Uint8Array
    collections: WasCollectionConfig[]
    storage?: RxStorage<unknown, unknown>
    dbName?: string
  }): Promise<LocalStore> {
    const ciphers: Record<string, DocCipher> = {}
    for (const { key, id } of collections) {
      const { keyAgreementKey, keyResolver } = await deriveCollectionKeys({
        seed,
        collectionId: id
      })
      ciphers[key] = await createDocCipher({
        keyAgreementKey,
        keyResolver,
        collectionId: id
      })
    }

    const db = await createRxDatabase({
      name: dbName,
      storage: storage ?? getRxStorageDexie(),
      closeDuplicates: true,
      // Single-tab: RxDB gates replication on leadership under multiInstance;
      // multi-tab is deferred, so replicate directly in this tab.
      multiInstance: false
    })
    // Each collection gets an LWW conflict handler bound to its own cipher, so
    // a 412 push conflict (concurrent multi-device edit of the same mutable
    // head) is settled by decrypting both sides and comparing payload
    // `updatedAt` (deviceId tiebreak) rather than RxDB's default master-wins.
    const collectionsConfig = Object.fromEntries(
      collections.map(({ key }) => {
        const cipher = ciphers[key]
        if (!cipher) {
          throw new Error(`No cipher for collection "${key}".`)
        }
        return [
          key,
          {
            schema: syncedDocSchema(),
            conflictHandler: makeLwwConflictHandler(envelope =>
              cipher.decrypt({ envelope })
            )
          }
        ]
      })
    )
    const collectionsMap = (await db.addCollections(
      collectionsConfig
    )) as unknown as Record<string, RxCollection<SyncedDoc>>

    return new LocalStore({ db, collections: collectionsMap, ciphers })
  }

  private _collection(key: string): RxCollection<SyncedDoc> {
    const collection = this._collections[key]
    if (!collection) {
      throw new Error(`Unknown collection "${key}".`)
    }
    return collection
  }

  private _cipher(key: string): DocCipher {
    const cipher = this._ciphers[key]
    if (!cipher) {
      throw new Error(`No cipher for collection "${key}".`)
    }
    return cipher
  }

  /**
   * Builds (or rebuilds) the `uuid -> envelopeId` index for one collection by
   * decrypting every live row. Returns the index map.
   */
  private async _ensureIndex(key: string): Promise<Map<string, string>> {
    const existing = this._index[key]
    if (existing) {
      return existing
    }
    const index = new Map<string, string>()
    const cipher = this._cipher(key)
    const docs = await this._collection(key).find().exec()
    // Decrypt rows concurrently: index building has no ordering dependency, so
    // serializing the per-row WebCrypto work would only stall the unlock path.
    const entries = await Promise.all(
      docs.map(async doc => {
        const { id: envelopeId, data } = doc.toMutableJSON()
        if (data === undefined) {
          return null
        }
        const payload = (await cipher.decrypt({
          envelope: data
        })) as EntityPayload
        return { envelopeId, uuid: payload.id }
      })
    )
    for (const entry of entries) {
      if (entry !== null) {
        index.set(entry.uuid, entry.envelopeId)
      }
    }
    this._index[key] = index
    return index
  }

  /**
   * Encrypts `payload` into a fresh EDV envelope and inserts it as a new row.
   *
   * @param key {string}            the collection logical key
   * @param payload {EntityPayload} the plaintext entity (carries its own uuid)
   * @returns {Promise<void>}
   */
  async insertEntity(key: string, payload: EntityPayload): Promise<void> {
    const cipher = this._cipher(key)
    const { id: envelopeId, envelope } = await cipher.encrypt({
      data: payload as Json
    })
    await this._collection(key).insert({
      id: envelopeId,
      updatedAt: new Date().toISOString(),
      version: 0,
      data: envelope
    })
    const index = await this._ensureIndex(key)
    index.set(payload.id, envelopeId)
  }

  /**
   * Re-encrypts `payload` in place under its existing envelope id, advancing the
   * envelope `sequence` (the mutable-head update). The row keeps its primary key;
   * only `data` and the checkpoint `updatedAt` change.
   *
   * @param key {string}
   * @param payload {EntityPayload}
   * @returns {Promise<void>}
   */
  async updateEntity(key: string, payload: EntityPayload): Promise<void> {
    const index = await this._ensureIndex(key)
    const envelopeId = index.get(payload.id)
    // The entity's envelope may be gone -- another device deleted it and the
    // tombstone was pulled (which forgets the index entry), or its row was
    // otherwise removed. Rather than throwing (which loses the edit), resurrect
    // the entity as a fresh create. This matches the mutable-head LWW rule the
    // conflict handler already applies: a live local edit beats a remote
    // tombstone, so re-asserting the payload under a new envelope is correct.
    if (!envelopeId) {
      await this.insertEntity(key, payload)
      return
    }
    const doc = await this._collection(key).findOne(envelopeId).exec()
    if (!doc) {
      index.delete(payload.id)
      await this.insertEntity(key, payload)
      return
    }
    const current = doc.toMutableJSON().data
    if (current === undefined) {
      index.delete(payload.id)
      await this.insertEntity(key, payload)
      return
    }
    const cipher = this._cipher(key)
    const { envelope } = await cipher.encryptUpdate({
      id: envelopeId,
      data: payload as Json,
      current
    })
    await doc.incrementalPatch({
      data: envelope,
      updatedAt: new Date().toISOString()
    })
  }

  /**
   * Inserts the entity if the collection has no row for its uuid yet, otherwise
   * re-encrypts it in place. The hydration index is the source of truth for
   * existence, so callers (e.g. an app's singleton collection) need not track
   * an insert-vs-update flag of their own.
   *
   * @param key {string}
   * @param payload {EntityPayload}
   * @returns {Promise<void>}
   */
  async upsertEntity(key: string, payload: EntityPayload): Promise<void> {
    const index = await this._ensureIndex(key)
    if (index.has(payload.id)) {
      await this.updateEntity(key, payload)
    } else {
      await this.insertEntity(key, payload)
    }
  }

  /**
   * Tombstones the entity's row (RxDB soft delete) so the deletion replicates.
   *
   * @param key {string}
   * @param uuid {string}   the logical entity uuid
   * @returns {Promise<void>}
   */
  async deleteEntity(key: string, uuid: string): Promise<void> {
    const index = await this._ensureIndex(key)
    const envelopeId = index.get(uuid)
    if (!envelopeId) {
      return
    }
    const doc = await this._collection(key).findOne(envelopeId).exec()
    if (doc) {
      await doc.remove()
    }
    index.delete(uuid)
  }

  /**
   * Decrypts every live row of a collection into its plaintext payload, and
   * (re)builds the `uuid -> envelopeId` index as a side effect of hydration.
   *
   * @param key {string}
   * @returns {Promise<T[]>}
   */
  async listEntities<T extends EntityPayload>(key: string): Promise<T[]> {
    const cipher = this._cipher(key)
    const index = new Map<string, string>()
    const docs = await this._collection(key).find().exec()
    // Decrypt every row concurrently (the unlock hot path): the store is keyed
    // by logical uuid, so payload order does not matter and serializing the
    // per-row WebCrypto work would only add latency.
    const decoded = await Promise.all(
      docs.map(async doc => {
        const { id: envelopeId, data } = doc.toMutableJSON()
        if (data === undefined) {
          return null
        }
        const payload = (await cipher.decrypt({ envelope: data })) as T
        return { envelopeId, payload }
      })
    )
    const payloads: T[] = []
    for (const entry of decoded) {
      if (entry === null) {
        continue
      }
      index.set(entry.payload.id, entry.envelopeId)
      payloads.push(entry.payload)
    }
    this._index[key] = index
    return payloads
  }

  /**
   * Hydrates a singleton collection (at most one logical entity, e.g. an app's
   * current-selection doc) and reconciles any duplicates. Two devices that each
   * created the singleton before syncing produce distinct envelope rows that all
   * decrypt to the same logical id; because LWW conflict resolution is
   * per-envelope-id, those duplicates never reconcile on their own. This keeps
   * the last-writer-wins winner (payload `updatedAt`, `deviceId` tiebreak) and
   * tombstones the losers so the deletion replicates and the space converges on
   * one row. Returns the winning payload, or `null` when the collection is empty.
   *
   * @param key {string}
   * @returns {Promise<T | null>}
   */
  async hydrateSingleton<
    T extends { id: string; updatedAt: string; deviceId: string }
  >(key: string): Promise<T | null> {
    const cipher = this._cipher(key)
    const collection = this._collection(key)
    const rows = await collection.find().exec()
    const decoded: Array<{ envelopeId: string; payload: T }> = []
    for (const row of rows) {
      const { id: envelopeId, data } = row.toMutableJSON()
      if (data === undefined) {
        continue
      }
      const payload = (await cipher.decrypt({ envelope: data })) as T
      decoded.push({ envelopeId, payload })
    }
    const index = new Map<string, string>()
    this._index[key] = index
    if (decoded.length === 0) {
      return null
    }
    let winner = decoded[0]!
    for (const entry of decoded) {
      if (entry === winner) {
        continue
      }
      if (remotePayloadWins(entry.payload, winner.payload)) {
        winner = entry
      }
    }
    for (const entry of decoded) {
      if (entry.envelopeId === winner.envelopeId) {
        continue
      }
      const doc = await collection.findOne(entry.envelopeId).exec()
      if (doc) {
        await doc.remove()
      }
    }
    index.set(winner.payload.id, winner.envelopeId)
    return winner.payload
  }

  /**
   * Decrypts a single EDV envelope into its plaintext payload, for per-doc
   * reactive patching of a pulled remote change (without a whole-collection
   * re-hydrate).
   *
   * @param key {string}
   * @param envelope {Json}   the `data` field of the at-rest row
   * @returns {Promise<T>}
   */
  async decryptEnvelope<T extends EntityPayload>(
    key: string,
    envelope: Json
  ): Promise<T> {
    return (await this._cipher(key).decrypt({ envelope })) as T
  }

  /**
   * Records a `uuid -> envelopeId` mapping for a remotely-pulled row so a
   * subsequent LOCAL edit of that entity can find its envelope. A no-op until
   * the collection has been hydrated once (hydration builds the full index).
   *
   * @param key {string}
   * @param uuid {string}
   * @param envelopeId {string}
   * @returns {void}
   */
  rememberEnvelope(key: string, uuid: string, envelopeId: string): void {
    this._index[key]?.set(uuid, envelopeId)
  }

  /**
   * Forgets a `uuid -> envelopeId` mapping (a remotely-pulled tombstone).
   *
   * @param key {string}
   * @param uuid {string}
   * @returns {void}
   */
  forgetEnvelope(key: string, uuid: string): void {
    this._index[key]?.delete(uuid)
  }

  /**
   * The envelope id the hydration index currently maps a logical uuid to, or
   * `undefined` when unknown (not yet hydrated, or no such entity). Lets the
   * sync patch path tell a tombstone for the LIVE envelope apart from one for a
   * stale duplicate (a reconciled singleton loser or a pre-resurrection row).
   *
   * @param key {string}
   * @param uuid {string}
   * @returns {string | undefined}
   */
  envelopeIdFor(key: string, uuid: string): string | undefined {
    return this._index[key]?.get(uuid)
  }

  /**
   * The live RxDB collection handle, for reactive subscriptions and the sync
   * controller.
   *
   * @param key {string}
   * @returns {RxCollection<SyncedDoc>}
   */
  rxCollection(key: string): RxCollection<SyncedDoc> {
    return this._collection(key)
  }

  /**
   * Closes the database (without removing data).
   *
   * @returns {Promise<void>}
   */
  async close(): Promise<void> {
    await this._db.close()
  }
}
