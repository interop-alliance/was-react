/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The storage manager: a thin process-wide holder for the one {@link LocalStore}
 * instance, the per-session {@link WasRemoteStore}, plus the per-install writer
 * id. Entity stores reach for the stores through {@link requireStore} /
 * {@link requireRemoteStore} inside their verbs rather than importing them
 * directly, which keeps this module free of store imports (no cycle) and lets
 * the app own the init/hydrate ordering.
 *
 * It also owns the writer-id concern end to end: {@link getWriterId} resolves
 * the per-install id, {@link setWriterId} installs the session's resolved value,
 * and {@link stampLww} is the one place a payload's last-write-wins fields are
 * minted, so no caller has to remember to stamp.
 */
import { uuidv7 } from 'uuidv7'
import { DEFAULT_STORAGE_KEY_PREFIX } from '../config.js'
import type { LwwFields } from '../sync/lww.js'
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
 * The unpersisted fallback writer id for environments without `localStorage`
 * (tests, SSR): process-stable, so every stamp within one run agrees, minted
 * fresh on the next run.
 */
let fallbackWriterId: string | null = null

/**
 * A stable per-install writer id (the last-write-wins tiebreak stamped into
 * every payload), persisted in localStorage under `<prefix>writerId`. In an
 * environment without `localStorage` it falls back to a process-stable
 * unpersisted id instead of throwing.
 *
 * The id is an unkeyed, clearable attribution label -- never an identity. On a
 * miss it adopts a value left under the pre-rename `<prefix>clientId` key and
 * removes the old one, so an existing install keeps stamping the same id
 * across the rename rather than looking like a second writer.
 *
 * @param [options] {object}
 * @param [options.storageKeyPrefix] {string}   the localStorage key prefix
 *   (defaults to {@link DEFAULT_STORAGE_KEY_PREFIX})
 * @returns {string}
 */
export function getWriterId({
  storageKeyPrefix = DEFAULT_STORAGE_KEY_PREFIX
}: { storageKeyPrefix?: string } = {}): string {
  const writerIdKey = `${storageKeyPrefix}writerId`
  const legacyKey = `${storageKeyPrefix}clientId`
  try {
    let id = localStorage.getItem(writerIdKey)
    if (!id) {
      id = localStorage.getItem(legacyKey) || uuidv7()
      localStorage.setItem(writerIdKey, id)
      localStorage.removeItem(legacyKey)
    }
    return id
  } catch {
    fallbackWriterId ??= uuidv7()
    return fallbackWriterId
  }
}

let resolvedWriterId: string | null = null

/**
 * Installs the session's resolved writer id (called once by the session store,
 * under the app's configured `storageKeyPrefix`, before any replica opens).
 *
 * @param id {string}
 * @returns {void}
 */
export function setWriterId(id: string): void {
  resolvedWriterId = id
}

/**
 * The session's resolved writer id, or throws if it has not been installed
 * yet. Deliberately never falls back to {@link getWriterId}: that would resolve
 * under the DEFAULT key prefix, so an app with a custom `storageKeyPrefix`
 * would silently stamp a second writer id.
 *
 * @returns {string}
 */
export function requireWriterId(): string {
  if (!resolvedWriterId) {
    throw new Error(
      'Writer id is not resolved; create the session store first.'
    )
  }
  return resolvedWriterId
}

/**
 * Stamps a payload with fresh last-write-wins fields: the current instant as
 * `updatedAt` and the session's resolved writer id. Any values the caller
 * supplied are overwritten -- a stamp must describe THIS write, or a hydrated
 * doc's older `updatedAt` would ride a later edit and lose the conflict.
 *
 * @param payload {object}
 * @returns {object}   the payload with the LWW fields set
 */
export function stampLww<T extends { id: string }>(payload: T): T & LwwFields {
  return {
    ...payload,
    updatedAt: new Date().toISOString(),
    writerId: requireWriterId()
  }
}
