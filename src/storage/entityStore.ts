/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * A generic zustand store over one localStore collection. Holds the decrypted
 * payloads as a `Map<uuid, Doc>` and exposes the CRUD verbs that (1) persist
 * through the encrypted {@link LocalStore} and (2) patch the in-memory Map. UI
 * reads through selectors and applies the app's own comparators/filters; this
 * layer stays domain-agnostic so every entity shares it.
 *
 * Reactivity note: local writes patch the Map optimistically after the localStore
 * write resolves. Pulled remote changes are applied per-doc by the sync layer
 * through `patch` / `drop` (no whole-collection re-hydrate), keeping multi-device
 * edits and tombstones live without re-hydrate storms.
 */
import { create, type UseBoundStore, type StoreApi } from 'zustand'
import { requireStore } from './storageManager.js'

export interface EntityStore<T extends { id: string }> {
  /** Decrypted payloads keyed by logical uuid. */
  byId: Map<string, T>
  hydrated: boolean
  /** Decrypt every live row of the collection into the Map. */
  hydrate: () => Promise<void>
  /** Encrypt+insert a new doc, then add it to the Map. */
  insert: (doc: T) => Promise<void>
  /** Re-encrypt a doc in place (sequence+1), then replace it in the Map. */
  update: (doc: T) => Promise<void>
  /** Tombstone a doc, then drop it from the Map. */
  remove: (uuid: string) => Promise<void>
  /** Replace the whole Map (used by hydrate and, later, the sync stream). */
  replaceAll: (docs: T[]) => void
  /**
   * Upsert one already-decrypted doc into the Map WITHOUT persisting (the sync
   * stream owns the persisted row already). Used for per-doc reactive patching
   * of pulled/conflict-resolved remote changes.
   */
  patch: (doc: T) => void
  /** Drop one doc from the Map WITHOUT persisting (remote tombstone patch). */
  drop: (uuid: string) => void
}

/**
 * Builds a zustand hook for the collection whose localStore key is `collectionKey`.
 *
 * @param collectionKey {string}
 * @returns {UseBoundStore<StoreApi<EntityStore<T>>>}
 */
export function createEntityStore<T extends { id: string }>(
  collectionKey: string
): UseBoundStore<StoreApi<EntityStore<T>>> {
  return create<EntityStore<T>>(set => ({
    byId: new Map<string, T>(),
    hydrated: false,
    hydrate: async () => {
      const docs = await requireStore().listEntities<T>(collectionKey)
      set({ byId: new Map(docs.map(d => [d.id, d])), hydrated: true })
    },
    insert: async doc => {
      await requireStore().insertEntity(collectionKey, doc)
      set(state => {
        const byId = new Map(state.byId)
        byId.set(doc.id, doc)
        return { byId }
      })
    },
    update: async doc => {
      await requireStore().updateEntity(collectionKey, doc)
      set(state => {
        const byId = new Map(state.byId)
        byId.set(doc.id, doc)
        return { byId }
      })
    },
    remove: async uuid => {
      await requireStore().deleteEntity(collectionKey, uuid)
      set(state => {
        const byId = new Map(state.byId)
        byId.delete(uuid)
        return { byId }
      })
    },
    replaceAll: docs => {
      set({ byId: new Map(docs.map(d => [d.id, d])), hydrated: true })
    },
    patch: doc => {
      set(state => {
        const byId = new Map(state.byId)
        byId.set(doc.id, doc)
        return { byId }
      })
    },
    drop: uuid => {
      set(state => {
        if (!state.byId.has(uuid)) {
          return state
        }
        const byId = new Map(state.byId)
        byId.delete(uuid)
        return { byId }
      })
    }
  }))
}
