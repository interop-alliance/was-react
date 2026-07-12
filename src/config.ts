/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The central configuration contract for a WAS-backed local-first app: the app
 * identity/origin, the registry of storage collections, the seed-credential
 * naming, and the (all-optional) sync/expiry tuning. An app builds one
 * {@link WasAppConfig} and threads it through the auth, storage, and sync
 * layers.
 *
 * A collection is a logical `key` (the app-side / RxDB collection handle) mapped
 * to its WAS collection `id` (the deliberately unprefixed, generic name shared
 * across interoperable apps). The auth layer consumes only the `id`s; this
 * config layer owns the `{ key, id }` registry the storage layer routes on.
 *
 * The STORE REGISTRY ({@link StoreRegistry}) is the injection seam that replaces
 * the storage-layer's former hardcoded per-entity maps: an app supplies, per
 * collection key, the four handlers the rehydrate mechanism drives (hydrate the
 * whole collection, per-doc upsert/drop of an already-decrypted payload, and
 * clear-on-logout). Expressing each collection as its own set of functions lets
 * an app special-case a singleton collection (e.g. a current-focus doc) without
 * a rigid CRUD interface.
 */
import type { SeedCredentialConfig } from './identity/seedCredential.js'

/**
 * One storage collection: the logical `key` (app-side / RxDB collection handle)
 * mapped to its WAS collection `id` (the generic, interoperable name).
 */
export interface WasCollectionConfig {
  /**
   * App-side name; the localStore / RxDB collection handle.
   */
  key: string
  /**
   * WAS collection id (the unprefixed, cross-app generic name).
   */
  id: string
}

/**
 * Optional replication tuning; each field falls back to a documented default.
 */
export interface WasSyncConfig {
  /**
   * Replication batch size; `undefined` leaves the adapter default.
   */
  batchSize?: number
  /**
   * RxDB `retryTime` backoff (ms); `undefined` leaves the adapter default.
   */
  retryMs?: number
  /**
   * Periodic re-sync interval (ms) that keeps an open session converging while
   * the pull side is poll-based. Defaults to {@link DEFAULT_SYNC_POLL_MS}; set
   * to 0 to disable the periodic poll.
   */
  pollMs?: number
}

/**
 * Optional near-expiry warning tuning; each field has the same default.
 */
export interface WasExpiryConfig {
  /**
   * How close to grant expiry (ms) the reconnect warning is raised proactively.
   * Defaults to {@link DEFAULT_EXPIRY_WARNING_MS} (1h).
   */
  warningMs?: number
  /**
   * Poll interval (ms) for the near-expiry watch (grant expiry is
   * coarse-grained). Defaults to {@link DEFAULT_EXPIRY_WATCH_MS} (1min).
   */
  watchMs?: number
}

/**
 * The cohesive, app-wide configuration. Built once by the app and threaded
 * through the auth, storage, and sync layers.
 */
export interface WasAppConfig {
  /**
   * Human-readable app name, used in the wallet consent reason lines.
   */
  appName: string
  /**
   * This app's own web origin (the anti-phishing bind on the app key).
   */
  appOrigin: string
  /**
   * The expected WAS server URL. When set, every granted zcap must target it;
   * grants pointing anywhere else are rejected at login.
   */
  wasServerUrl?: string
  /**
   * The CHAPI mediator base URL (the requesting origin is appended).
   */
  mediatorBase?: string
  /**
   * The storage collections (logical key to WAS collection id).
   */
  collections: WasCollectionConfig[]
  /**
   * The seed-credential type name + vocabulary namespace.
   */
  credential: SeedCredentialConfig
  /**
   * Base name for the local RxDB database and session IndexedDB naming. Defaults
   * to {@link DEFAULT_DB_NAME}.
   */
  dbName?: string
  /**
   * Prefix for this app's `localStorage` keys (e.g. the device id). Defaults to
   * {@link DEFAULT_STORAGE_KEY_PREFIX}. Migrating apps should set their prior
   * prefix so an existing per-install device id is preserved.
   */
  storageKeyPrefix?: string
  /**
   * Replication tuning; all fields optional with documented defaults.
   */
  sync?: WasSyncConfig
  /**
   * Near-expiry warning tuning; all fields optional with the same default.
   */
  expiry?: WasExpiryConfig
}

/**
 * One collection's re-hydrate + patch handlers, supplied by the app. The
 * rehydrate mechanism drives these; expressing each collection as its own set of
 * functions lets an app special-case a singleton (e.g. a current-focus doc)
 * without a rigid CRUD interface.
 */
export interface StoreRegistryEntry {
  /**
   * Decrypt every live row of this collection into the app's store.
   */
  hydrate: () => Promise<void>
  /**
   * Upsert one already-decrypted payload into the store WITHOUT persisting (the
   * sync stream already owns the persisted row).
   */
  upsert: (doc: { id: string }) => void
  /**
   * Drop one payload (by logical uuid) from the store WITHOUT persisting.
   */
  drop: (uuid: string) => void
  /**
   * Empty this collection's store (logout).
   */
  clear: () => void
}

/**
 * The per-collection store handlers, keyed by the collection logical `key`. The
 * injection seam replacing the storage layer's former hardcoded maps.
 */
export type StoreRegistry = Record<string, StoreRegistryEntry>

/**
 * Default base name for the local RxDB database + session IndexedDB naming.
 */
export const DEFAULT_DB_NAME = 'was-react'

/**
 * Default `localStorage` key prefix (e.g. `was-react:deviceId`).
 */
export const DEFAULT_STORAGE_KEY_PREFIX = 'was-react:'

/**
 * Default periodic re-sync interval (ms). The pull side is poll-based (no
 * server-side live stream yet), so an open session only sees another device's
 * changes when it re-pulls; a low-frequency periodic re-sync keeps open sessions
 * converging live.
 */
export const DEFAULT_SYNC_POLL_MS = 15000

/**
 * Default near-expiry warning threshold (ms): 1 hour.
 */
export const DEFAULT_EXPIRY_WARNING_MS = 60 * 60 * 1000

/**
 * Default near-expiry watch poll interval (ms): 1 minute.
 */
export const DEFAULT_EXPIRY_WATCH_MS = 60 * 1000

/**
 * Resolves a localStore/RxDB collection `key` from its WAS collection `id`.
 *
 * @param options {object}
 * @param options.collections {WasCollectionConfig[]}   the collection registry
 * @param options.id {string}   the WAS collection id
 * @returns {string | undefined}
 */
export function collectionKeyForId({
  collections,
  id
}: {
  collections: WasCollectionConfig[]
  id: string
}): string | undefined {
  return collections.find(entry => entry.id === id)?.key
}
