/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The storage manager: a thin process-wide holder for the one {@link LocalStore}
 * instance plus the per-install device id. Entity stores reach for the store
 * through {@link requireStore} inside their CRUD actions rather than importing it
 * directly, which keeps this module free of store imports (no cycle) and lets
 * the app own the init/hydrate ordering.
 */
import { uuidv7 } from 'uuidv7'
import { DEFAULT_STORAGE_KEY_PREFIX } from '../config.js'
import type { LocalStore } from './localStore.js'

let localStore: LocalStore | null = null

/**
 * Installs the opened store (called once by the app bootstrap).
 *
 * @param store {LocalStore}
 * @returns {void}
 */
export function setLocalStore(store: LocalStore): void {
  localStore = store
}

/**
 * The opened store, or throws if the app has not bootstrapped yet.
 *
 * @returns {LocalStore}
 */
export function requireStore(): LocalStore {
  if (!localStore) {
    throw new Error('LocalStore is not initialized; open it first.')
  }
  return localStore
}

/**
 * Whether the store has been opened.
 *
 * @returns {boolean}
 */
export function hasStore(): boolean {
  return localStore !== null
}

/**
 * Releases the held store reference (logout; the caller closes the db).
 *
 * @returns {void}
 */
export function clearLocalStore(): void {
  localStore = null
}

/**
 * A stable per-install device id (the last-write-wins tiebreak stamped into
 * every payload), persisted in localStorage under `<prefix>deviceId`.
 *
 * @param [options] {object}
 * @param [options.storageKeyPrefix] {string}   the localStorage key prefix
 *   (defaults to {@link DEFAULT_STORAGE_KEY_PREFIX})
 * @returns {string}
 */
export function getDeviceId({
  storageKeyPrefix = DEFAULT_STORAGE_KEY_PREFIX
}: { storageKeyPrefix?: string } = {}): string {
  const deviceIdKey = `${storageKeyPrefix}deviceId`
  let id = localStorage.getItem(deviceIdKey)
  if (!id) {
    id = uuidv7()
    localStorage.setItem(deviceIdKey, id)
  }
  return id
}
