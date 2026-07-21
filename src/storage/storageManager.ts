/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The storage manager: a thin process-wide holder for the one {@link LocalStore}
 * instance, the per-session {@link WasRemoteStore}, plus the per-install client
 * id. Entity stores reach for the stores through {@link requireStore} /
 * {@link requireRemoteStore} inside their verbs rather than importing them
 * directly, which keeps this module free of store imports (no cycle) and lets
 * the app own the init/hydrate ordering.
 */
import { uuidv7 } from 'uuidv7'
import { DEFAULT_STORAGE_KEY_PREFIX } from '../config.js'
import type { LocalStore } from './localStore.js'
import type { WasRemoteStore } from './wasRemoteStore.js'

let localStore: LocalStore | null = null
let remoteStore: WasRemoteStore | null = null

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
 * Installs the per-session delegated remote store (set once background sync
 * has bootstrapped it from the granted zcaps).
 *
 * @param store {WasRemoteStore}
 * @returns {void}
 */
export function setRemoteStore(store: WasRemoteStore): void {
  remoteStore = store
}

/**
 * The connected session's remote store, or throws while no wallet-connected
 * session is active (local-only mode, or sync has not bootstrapped yet).
 *
 * @returns {WasRemoteStore}
 */
export function requireRemoteStore(): WasRemoteStore {
  if (!remoteStore) {
    throw new Error(
      'No WAS remote store is available; connect a wallet session first.'
    )
  }
  return remoteStore
}

/**
 * Whether a connected session's remote store is available.
 *
 * @returns {boolean}
 */
export function hasRemoteStore(): boolean {
  return remoteStore !== null
}

/**
 * Releases the held remote store reference (logout / sync teardown).
 *
 * @returns {void}
 */
export function clearRemoteStore(): void {
  remoteStore = null
}

/**
 * A stable per-install client id (the last-write-wins tiebreak stamped into
 * every payload), persisted in localStorage under `<prefix>clientId`.
 *
 * @param [options] {object}
 * @param [options.storageKeyPrefix] {string}   the localStorage key prefix
 *   (defaults to {@link DEFAULT_STORAGE_KEY_PREFIX})
 * @returns {string}
 */
export function getClientId({
  storageKeyPrefix = DEFAULT_STORAGE_KEY_PREFIX
}: { storageKeyPrefix?: string } = {}): string {
  const clientIdKey = `${storageKeyPrefix}clientId`
  let id = localStorage.getItem(clientIdKey)
  if (!id) {
    id = uuidv7()
    localStorage.setItem(clientIdKey, id)
  }
  return id
}
