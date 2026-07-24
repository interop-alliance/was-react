/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * LocalStore: the always-on local replica. A GENERIC per-entity envelope store
 * over an app's registered collections. Owns one RxDB (Dexie/IndexedDB)
 * database holding one collection per entity on the shared `syncedDocSchema()`;
 * every at-rest row is `{ id, updatedAt, version, data }`. On a PRIVATE
 * (default) collection `data` is the EDV envelope `{ id, sequence, jwe }` --
 * the server never sees plaintext. On a PUBLIC collection `data` is the
 * plaintext payload as-is, behind the same {@link DocCipher} seam (a
 * pass-through codec), so everything below this paragraph applies to both.
 *
 * Two id planes: the logical entity `uuid` lives INSIDE the encrypted payload;
 * the RxDB primary key is the opaque random EDV envelope id. An in-memory
 * `uuid -> envelopeId` index (built during hydration) routes updates/deletes.
 * (On a public collection the planes coincide -- the row id IS the payload
 * uuid, giving a public document a stable, shareable resource URL -- and the
 * index degenerates to identity.) Two timestamp planes: the row-level
 * `updatedAt` is only the sync checkpoint; the payload's own `createdAt` /
 * `updatedAt` (inside the ciphertext) drive domain sorting and LWW.
 *
 * Writes: create mints a fresh random envelope; update re-encrypts under the
 * SAME envelope id with `sequence`+1 (the mutable-head model); delete is an RxDB
 * soft-delete tombstone.
 */
import {
  createRxDatabase,
  removeRxDatabase,
  type RxCollection,
  type RxDatabase,
  type RxStorage
} from 'rxdb/plugins/core'
import { getRxStorageDexie } from 'rxdb/plugins/storage-dexie'
import {
  DEFAULT_DB_NAME,
  validateCollections,
  type WasCollectionConfig
} from '../config.js'
import type { CollectionEncryption } from '@interop/was-client'
import { UnknownEpochError } from '@interop/was-client/edv'
import {
  syncedDocSchema,
  createDocCipher,
  createPlaintextDocCodec,
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
 * The local store. Construct via {@link LocalStore.init}, which derives the
 * per-collection ciphers from the master seed (private collections) or wires
 * the pass-through plaintext codec (public collections) and opens RxDB.
 */
export class LocalStore {
  #db: RxDatabase
  #collections: Record<string, RxCollection<SyncedDoc>>
  #ciphers: Record<string, DocCipher>
  #configs: Record<string, WasCollectionConfig>
  // Per-collection logical-uuid -> envelope (RxDB primary key) index.
  #index: Record<string, Map<string, string>>
  // The master seed, kept so a private collection's cipher can be re-derived
  // when its epoch marker changes (a wallet-side rotation).
  #seed: Uint8Array
  // The encryption marker each private collection's current cipher was built
  // from (keyed by collection logical key), so a marker change can be detected.
  #markers: Record<string, CollectionEncryption | undefined>
  // Fetches a private collection's fresh encryption marker (by WAS collection
  // id) when a decrypt meets an unknown key epoch; injected once a remote store
  // exists. Absent offline / local-only.
  #epochRefresher?: (
    collectionId: string
  ) => Promise<CollectionEncryption | undefined>

  private constructor({
    db,
    collections,
    ciphers,
    configs,
    seed,
    markers
  }: {
    db: RxDatabase
    collections: Record<string, RxCollection<SyncedDoc>>
    ciphers: Record<string, DocCipher>
    configs: Record<string, WasCollectionConfig>
    seed: Uint8Array
    markers: Record<string, CollectionEncryption | undefined>
  }) {
    this.#db = db
    this.#collections = collections
    this.#ciphers = ciphers
    this.#configs = configs
    this.#index = {}
    this.#seed = seed
    this.#markers = markers
  }

  /**
   * Opens (or creates) the store: derives a per-collection KAK + cipher from
   * the master seed for each PRIVATE collection (a PUBLIC collection skips key
   * derivation entirely and gets the pass-through plaintext codec) and opens
   * one RxDB collection per entity.
   *
   * When `markers` carries an encryption marker for a private collection (from
   * the offline marker cache), that collection's cipher is built epoch-aware so
   * a multi-recipient envelope decrypts before any live description read; a
   * collection with no cached marker keeps the single-key behavior.
   *
   * @param options {object}
   * @param options.seed {Uint8Array}   the 32-byte master seed
   * @param options.collections {WasCollectionConfig[]}   the collection registry
   *   (logical key to WAS collection id)
   * @param [options.markers] {Record<string, CollectionEncryption>}   cached
   *   encryption markers keyed by WAS collection id (from the offline cache)
   * @param [options.storage] {RxStorage<unknown, unknown>}   defaults to
   *   Dexie/IndexedDB; injectable for tests
   * @param [options.dbName] {string}   defaults to {@link DEFAULT_DB_NAME}
   * @returns {Promise<LocalStore>}
   */
  static async init({
    seed,
    collections,
    markers = {},
    storage,
    dbName = DEFAULT_DB_NAME
  }: {
    seed: Uint8Array
    collections: WasCollectionConfig[]
    markers?: Record<string, CollectionEncryption>
    storage?: RxStorage<unknown, unknown>
    dbName?: string
  }): Promise<LocalStore> {
    validateCollections(collections)
    const ciphers: Record<string, DocCipher> = {}
    // The marker each private cipher was built from, keyed by logical key.
    const builtMarkers: Record<string, CollectionEncryption | undefined> = {}
    for (const { key, id, visibility } of collections) {
      // A public collection is stored plaintext: no key derivation, no EDV
      // cipher -- just the pass-through codec behind the same seam.
      if (visibility === 'public') {
        ciphers[key] = createPlaintextDocCodec({ collectionId: id })
        continue
      }
      const encryption = markers[id]
      const { keyAgreementKey, keyResolver } = await deriveCollectionKeys({
        seed,
        collectionId: id
      })
      ciphers[key] = await createDocCipher({
        keyAgreementKey,
        keyResolver,
        collectionId: id,
        ...(encryption && { encryption })
      })
      builtMarkers[key] = encryption
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
    // `updatedAt` (clientId tiebreak) rather than RxDB's default master-wins.
    // On a public collection the codec is pass-through, so the handler reads
    // those fields directly off the plaintext payload.
    const collectionsConfig = Object.fromEntries(
      collections.map(({ key }) => {
        if (!ciphers[key]) {
          throw new Error(`No cipher for collection "${key}".`)
        }
        return [
          key,
          {
            schema: syncedDocSchema(),
            // Reads the CURRENT cipher for this key at decrypt time (not a
            // captured reference), so a `rebuildCipher` after a marker change
            // takes effect here too. `ciphers` is the same object the instance
            // holds as `#ciphers`, so the swap is visible.
            conflictHandler: makeLwwConflictHandler(envelope => {
              const cipher = ciphers[key]
              if (!cipher) {
                throw new Error(`No cipher for collection "${key}".`)
              }
              return cipher.decrypt({ envelope })
            })
          }
        ]
      })
    )
    const collectionsMap = (await db.addCollections(
      collectionsConfig
    )) as unknown as Record<string, RxCollection<SyncedDoc>>

    return new LocalStore({
      db,
      collections: collectionsMap,
      ciphers,
      configs: Object.fromEntries(collections.map(entry => [entry.key, entry])),
      seed,
      markers: builtMarkers
    })
  }

  #collection(key: string): RxCollection<SyncedDoc> {
    const collection = this.#collections[key]
    if (!collection) {
      throw new Error(`Unknown collection "${key}".`)
    }
    return collection
  }

  /**
   * The registered {@link WasCollectionConfig} for one collection key (the
   * WAS collection id, visibility, and declared indexes the storage layer
   * routes on).
   *
   * @param key {string}   the collection logical key
   * @returns {WasCollectionConfig}
   */
  collectionConfig(key: string): WasCollectionConfig {
    const config = this.#configs[key]
    if (!config) {
      throw new Error(`Unknown collection "${key}".`)
    }
    return config
  }

  #cipher(key: string): DocCipher {
    const cipher = this.#ciphers[key]
    if (!cipher) {
      throw new Error(`No cipher for collection "${key}".`)
    }
    return cipher
  }

  /**
   * Installs the epoch-marker refresher: given a WAS collection id, it fetches
   * that collection's fresh encryption marker (a live description read). Called
   * once a remote store exists; a decrypt that meets an unknown key epoch uses
   * it to re-read the marker and rebuild the cipher exactly once.
   *
   * @param refresher {(collectionId: string) => Promise<CollectionEncryption | undefined>}
   * @returns {void}
   */
  setEpochRefresher(
    refresher: (
      collectionId: string
    ) => Promise<CollectionEncryption | undefined>
  ): void {
    this.#epochRefresher = refresher
  }

  /**
   * Decrypts an at-rest envelope through the collection's cipher, with a
   * one-shot recovery from a stale epoch marker: when the cipher throws
   * {@link UnknownEpochError} (an envelope written under an epoch this device has
   * not seen -- a rekey on another device / a wallet revoke-rotation) and a
   * refresher is installed, re-read the marker, rebuild the cipher, and retry
   * the decrypt once. A second failure propagates rather than looping.
   */
  async #decryptWithRefresh(key: string, envelope: Json): Promise<Json> {
    try {
      return await this.#cipher(key).decrypt({ envelope })
    } catch (err) {
      if (!(err instanceof UnknownEpochError) || !this.#epochRefresher) {
        throw err
      }
      const { id } = this.collectionConfig(key)
      const encryption = await this.#epochRefresher(id)
      if (!encryption) {
        throw err
      }
      await this.rebuildCipher({ key, encryption })
      // One retry only: a repeat UnknownEpochError propagates (no loop).
      return await this.#cipher(key).decrypt({ envelope })
    }
  }

  /**
   * Rebuilds one private collection's cipher from a new encryption marker,
   * re-deriving its per-collection key material from the master seed. A public
   * (plaintext) collection has no seed-derived cipher and is a no-op. The new
   * cipher replaces the held one in place, so the conflict handler and every
   * read path pick it up.
   *
   * @param options {object}
   * @param options.key {string}   the collection logical key
   * @param options.encryption {CollectionEncryption}   the new marker
   * @returns {Promise<void>}
   */
  async rebuildCipher({
    key,
    encryption
  }: {
    key: string
    encryption: CollectionEncryption
  }): Promise<void> {
    const config = this.collectionConfig(key)
    if (config.visibility === 'public') {
      return
    }
    const { keyAgreementKey, keyResolver } = await deriveCollectionKeys({
      seed: this.#seed,
      collectionId: config.id
    })
    this.#ciphers[key] = await createDocCipher({
      keyAgreementKey,
      keyResolver,
      collectionId: config.id,
      encryption
    })
    this.#markers[key] = encryption
  }

  /**
   * Applies a freshly fetched remote encryption marker (by WAS collection id):
   * rebuilds that collection's cipher when the marker's current epoch differs
   * from the one the current cipher was built from (a wallet-side rotation, or
   * first-ever epochs), so subsequent writes stamp the current epoch. Returns
   * whether a rebuild happened. Unknown / public collections are ignored.
   *
   * @param options {object}
   * @param options.collectionId {string}   the WAS collection id
   * @param options.encryption {CollectionEncryption}   the fetched marker
   * @returns {Promise<boolean>}
   */
  async applyRemoteMarker({
    collectionId,
    encryption
  }: {
    collectionId: string
    encryption: CollectionEncryption
  }): Promise<boolean> {
    const entry = Object.entries(this.#configs).find(
      ([, config]) => config.id === collectionId
    )
    if (!entry) {
      return false
    }
    const [key, config] = entry
    if (config.visibility === 'public') {
      return false
    }
    if (markersEqual(this.#markers[key], encryption)) {
      return false
    }
    await this.rebuildCipher({ key, encryption })
    return true
  }

  /**
   * Builds (or rebuilds) the `uuid -> envelopeId` index for one collection by
   * decrypting every live row. Returns the index map.
   */
  async #ensureIndex(key: string): Promise<Map<string, string>> {
    const existing = this.#index[key]
    if (existing) {
      return existing
    }
    const index = new Map<string, string>()
    const docs = await this.#collection(key).find().exec()
    // Decrypt rows concurrently: index building has no ordering dependency, so
    // serializing the per-row WebCrypto work would only stall the unlock path.
    const entries = await Promise.all(
      docs.map(async doc => {
        const { id: envelopeId, data } = doc.toMutableJSON()
        if (data === undefined) {
          return null
        }
        const payload = (await this.#decryptWithRefresh(
          key,
          data
        )) as EntityPayload
        return { envelopeId, uuid: payload.id }
      })
    )
    for (const entry of entries) {
      if (entry !== null) {
        index.set(entry.uuid, entry.envelopeId)
      }
    }
    this.#index[key] = index
    return index
  }

  /**
   * Encrypts `payload` into a fresh EDV envelope and inserts it as a new row.
   *
   * @param key {string}            the collection logical key
   * @param payload {EntityPayload} the plaintext entity (carries its own uuid)
   * @returns {Promise<void>}
   */
  async insertEntity<T extends EntityPayload>(
    key: string,
    payload: T
  ): Promise<void> {
    const cipher = this.#cipher(key)
    const { id: envelopeId, envelope } = await cipher.encrypt({
      data: payload as Json
    })
    await this.#collection(key).insert({
      id: envelopeId,
      updatedAt: new Date().toISOString(),
      version: 0,
      data: envelope
    })
    const index = await this.#ensureIndex(key)
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
  async updateEntity<T extends EntityPayload>(
    key: string,
    payload: T
  ): Promise<void> {
    const index = await this.#ensureIndex(key)
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
    const doc = await this.#collection(key).findOne(envelopeId).exec()
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
    const cipher = this.#cipher(key)
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
  async upsertEntity<T extends EntityPayload>(
    key: string,
    payload: T
  ): Promise<void> {
    const index = await this.#ensureIndex(key)
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
    const index = await this.#ensureIndex(key)
    const envelopeId = index.get(uuid)
    if (!envelopeId) {
      return
    }
    const doc = await this.#collection(key).findOne(envelopeId).exec()
    if (doc) {
      await doc.remove()
    }
    index.delete(uuid)
  }

  /**
   * The number of live (non-tombstoned) rows in a collection, without
   * decrypting any of them (e.g. the "is there anything to adopt?" check
   * behind a pre-login adoption prompt).
   *
   * @param key {string}
   * @returns {Promise<number>}
   */
  async countEntities(key: string): Promise<number> {
    const docs = await this.#collection(key).find().exec()
    return docs.length
  }

  /**
   * Decrypts every live row of a collection into its plaintext payload, and
   * (re)builds the `uuid -> envelopeId` index as a side effect of hydration.
   *
   * @param key {string}
   * @returns {Promise<T[]>}
   */
  async listEntities<T extends EntityPayload>(key: string): Promise<T[]> {
    const index = new Map<string, string>()
    const docs = await this.#collection(key).find().exec()
    // Decrypt every row concurrently (the unlock hot path): the store is keyed
    // by logical uuid, so payload order does not matter and serializing the
    // per-row WebCrypto work would only add latency.
    const decoded = await Promise.all(
      docs.map(async doc => {
        const { id: envelopeId, data } = doc.toMutableJSON()
        if (data === undefined) {
          return null
        }
        const payload = (await this.#decryptWithRefresh(key, data)) as T
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
    this.#index[key] = index
    return payloads
  }

  /**
   * Hydrates a singleton collection (at most one logical entity, e.g. an app's
   * current-selection doc) and reconciles any duplicates. Two devices that each
   * created the singleton before syncing produce distinct envelope rows that all
   * decrypt to the same logical id; because LWW conflict resolution is
   * per-envelope-id, those duplicates never reconcile on their own. This keeps
   * the last-writer-wins winner (payload `updatedAt`, `clientId` tiebreak) and
   * tombstones the losers so the deletion replicates and the space converges on
   * one row. Returns the winning payload, or `null` when the collection is empty.
   *
   * @param key {string}
   * @returns {Promise<T | null>}
   */
  async hydrateSingleton<
    T extends { id: string; updatedAt: string; clientId: string }
  >(key: string): Promise<T | null> {
    const collection = this.#collection(key)
    const rows = await collection.find().exec()
    const decoded: Array<{ envelopeId: string; payload: T }> = []
    for (const row of rows) {
      const { id: envelopeId, data } = row.toMutableJSON()
      if (data === undefined) {
        continue
      }
      const payload = (await this.#decryptWithRefresh(key, data)) as T
      decoded.push({ envelopeId, payload })
    }
    const index = new Map<string, string>()
    this.#index[key] = index
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
    return (await this.#decryptWithRefresh(key, envelope)) as T
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
    this.#index[key]?.set(uuid, envelopeId)
  }

  /**
   * Forgets a `uuid -> envelopeId` mapping (a remotely-pulled tombstone).
   *
   * @param key {string}
   * @param uuid {string}
   * @returns {void}
   */
  forgetEnvelope(key: string, uuid: string): void {
    this.#index[key]?.delete(uuid)
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
    return this.#index[key]?.get(uuid)
  }

  /**
   * The live RxDB collection handle, for reactive subscriptions and the sync
   * controller.
   *
   * @param key {string}
   * @returns {RxCollection<SyncedDoc>}
   */
  rxCollection(key: string): RxCollection<SyncedDoc> {
    return this.#collection(key)
  }

  /**
   * Closes the database (without removing data).
   *
   * @returns {Promise<void>}
   */
  async close(): Promise<void> {
    await this.#db.close()
  }

  /**
   * Removes the database and all its data (the clear-data / logout-wipe path).
   * Unlike {@link close}, this deletes the underlying Dexie/IndexedDB store.
   *
   * @returns {Promise<void>}
   */
  async remove(): Promise<void> {
    await this.#db.remove()
  }

  /**
   * Deletes a database and all its data by name, without opening it (the
   * post-adoption cleanup of a replica that is already closed).
   *
   * @param options {object}
   * @param options.dbName {string}   the full per-controller database name
   * @param [options.storage] {RxStorage<unknown, unknown>}   defaults to
   *   Dexie/IndexedDB; must match the storage the database was created with
   * @returns {Promise<void>}
   */
  static async removeDatabase({
    dbName,
    storage
  }: {
    dbName: string
    storage?: RxStorage<unknown, unknown>
  }): Promise<void> {
    await removeRxDatabase(dbName, storage ?? getRxStorageDexie())
  }
}

/**
 * Whether two encryption markers select the same writing epoch: same
 * `currentEpoch` and the same ordered epoch id list. That is all a cipher rebuild
 * turns on -- rotation only appends epochs and moves `currentEpoch` -- so a
 * marker that matches on both needs no rebuild. A cached `undefined` (no marker
 * built) never equals a real marker, so first-ever epochs always rebuild.
 *
 * @param current {CollectionEncryption | undefined}
 * @param next {CollectionEncryption}
 * @returns {boolean}
 */
function markersEqual(
  current: CollectionEncryption | undefined,
  next: CollectionEncryption
): boolean {
  if (current === undefined) {
    return false
  }
  if (current.currentEpoch !== next.currentEpoch) {
    return false
  }
  const currentIds = (current.epochs ?? []).map(epoch => epoch.id)
  const nextIds = (next.epochs ?? []).map(epoch => epoch.id)
  if (currentIds.length !== nextIds.length) {
    return false
  }
  return currentIds.every((id, index) => id === nextIds[index])
}
