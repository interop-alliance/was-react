/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Persistence of the per-install writer id: the last-write-wins tiebreak the
 * storage context stamps into every payload. {@link getWriterId} resolves it
 * from localStorage (minting one on a miss), {@link clearPersistedWriterId}
 * removes it (the clear-data grade of the wipe). The in-memory value a session
 * stamps with lives on its {@link StorageContext}; nothing here holds state
 * beyond the no-localStorage fallback.
 */
import { uuidv7 } from 'uuidv7'
import { DEFAULT_STORAGE_KEY_PREFIX } from '../config.js'

/**
 * The unpersisted fallback writer id for environments without `localStorage`
 * (tests, SSR): process-stable, so every resolution within one run agrees,
 * minted fresh on the next run.
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

/**
 * Clears the persisted writer id (the clear-data grade of the wipe): removes
 * both the current key and the pre-rename one, so nothing this library wrote
 * survives in localStorage. Only persistence is touched; the running session's
 * in-memory id is replaced by {@link StorageContext.resetWriterId}, because the
 * session keeps running over its new anonymous replica and its write verbs
 * still have to stamp.
 *
 * @param [options] {object}
 * @param [options.storageKeyPrefix] {string}   the localStorage key prefix
 *   (defaults to {@link DEFAULT_STORAGE_KEY_PREFIX})
 * @returns {void}
 */
export function clearPersistedWriterId({
  storageKeyPrefix = DEFAULT_STORAGE_KEY_PREFIX
}: { storageKeyPrefix?: string } = {}): void {
  try {
    localStorage.removeItem(`${storageKeyPrefix}writerId`)
    localStorage.removeItem(`${storageKeyPrefix}clientId`)
  } catch {
    // No localStorage in this environment: nothing was persisted to clear.
  }
  fallbackWriterId = null
}
