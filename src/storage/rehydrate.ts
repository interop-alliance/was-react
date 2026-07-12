/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The hydration MECHANISM: the per-collection re-hydrate hooks (decrypt the
 * localStore rows into the app's stores) plus the debounced remote-change
 * scheduler used by every sync entry point. Generic over an injected
 * {@link StoreRegistry} -- the app supplies the concrete per-collection
 * handlers; nothing here knows the domain entities.
 */
import type { Json } from '../sync/index.js'
import type { StoreRegistry } from '../config.js'
import { hasStore, requireStore } from './storageManager.js'

/**
 * Hydrates every registered store from the (already opened) localStore.
 *
 * @param registry {StoreRegistry}
 * @returns {Promise<void>}
 */
export async function hydrateAll(registry: StoreRegistry): Promise<void> {
  await Promise.all(Object.values(registry).map(entry => entry.hydrate()))
}

/**
 * Empties every registered store (logout).
 *
 * @param registry {StoreRegistry}
 * @returns {void}
 */
export function clearAllEntityStores(registry: StoreRegistry): void {
  for (const entry of Object.values(registry)) {
    entry.clear()
  }
}

/**
 * Patches ONE store from a single RxDB change event (per-doc, no whole-collection
 * re-hydrate): decrypt the changed envelope, then upsert the payload (INSERT /
 * UPDATE, including conflict-resolved rows) or drop it (DELETE / tombstone). The
 * `uuid -> envelopeId` index is kept in step so a later local edit of a
 * remotely-created doc still finds its envelope. Falls back to a debounced
 * whole-collection re-hydrate if the envelope is missing or fails to decrypt.
 *
 * @param registry {StoreRegistry}
 * @param collectionKey {string}
 * @param event {object}   an RxDB change event (operation + documentData)
 * @returns {Promise<void>}
 */
export async function patchFromChange(
  registry: StoreRegistry,
  collectionKey: string,
  event: {
    operation: string
    documentData?: { id: string; data?: Json; _deleted?: boolean }
  }
): Promise<void> {
  const entry = registry[collectionKey]
  if (!entry) {
    return
  }
  const row = event.documentData
  const envelope = row?.data
  const deleted = event.operation === 'DELETE' || row?._deleted === true
  if (!row || envelope === undefined) {
    scheduleRehydrate(registry, collectionKey)
    return
  }
  let payload: { id: string }
  try {
    payload = await requireStore().decryptEnvelope<{ id: string }>(
      collectionKey,
      envelope
    )
  } catch {
    scheduleRehydrate(registry, collectionKey)
    return
  }
  if (deleted) {
    // Only honor a tombstone for the envelope the entity currently lives in.
    // A delete of a DIFFERENT envelope that decrypts to the same logical id is
    // a stale duplicate being cleaned up (a reconciled singleton loser, or the
    // pre-resurrection row of a locally re-created doc) -- dropping the live
    // doc for it would undo the reconciliation/resurrection.
    const mapped = requireStore().envelopeIdFor(collectionKey, payload.id)
    if (mapped !== undefined && mapped !== row.id) {
      return
    }
    requireStore().forgetEnvelope(collectionKey, payload.id)
    entry.drop(payload.id)
  } else {
    requireStore().rememberEnvelope(collectionKey, payload.id, row.id)
    entry.upsert(payload)
  }
}

/**
 * Per-collection debounce timers coalescing a pull burst into one hydrate.
 */
const rehydrateTimers = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * Schedules a debounced re-hydrate of one collection's store after a pull.
 *
 * @param registry {StoreRegistry}
 * @param collectionKey {string}
 * @returns {void}
 */
export function scheduleRehydrate(
  registry: StoreRegistry,
  collectionKey: string
): void {
  const entry = registry[collectionKey]
  if (!entry) {
    return
  }
  const existing = rehydrateTimers.get(collectionKey)
  if (existing) {
    clearTimeout(existing)
  }
  rehydrateTimers.set(
    collectionKey,
    setTimeout(() => {
      rehydrateTimers.delete(collectionKey)
      // A timer that outlived logout must not touch a torn-down store: hydrate
      // reaches for `requireStore()`, which throws once the store is cleared.
      if (!hasStore()) {
        return
      }
      void entry.hydrate()
    }, 50)
  )
}

/**
 * Cancels every pending debounced re-hydrate. Called on logout so a timer that
 * fires after the LocalStore is torn down does not reach a `requireStore()` that
 * throws (an unhandled rejection).
 *
 * @returns {void}
 */
export function cancelScheduledRehydrates(): void {
  for (const timer of rehydrateTimers.values()) {
    clearTimeout(timer)
  }
  rehydrateTimers.clear()
}
