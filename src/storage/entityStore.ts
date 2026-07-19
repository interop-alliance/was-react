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
 * edits and tombstones live without re-hydrate storms. Those per-doc remote
 * patches are coalesced: a pull burst is buffered and flushed on a microtask as a
 * single Map clone + single `set`, so an initial device sync of N docs is one
 * re-render rather than N (and O(N) Map copies rather than O(N^2)). Interactive
 * local writes stay immediate so a single edit is snappy.
 */
import { create, type UseBoundStore, type StoreApi } from 'zustand'
import { requireStore } from './storageManager.js'
import { lwwFields, remotePayloadWins } from '../sync/lww.js'

export interface EntityStore<T extends { id: string }> {
  /**
   * Decrypted payloads keyed by logical uuid.
   */
  byId: Map<string, T>
  /**
   * Decrypt every live row of the collection into the Map.
   */
  hydrate: () => Promise<void>
  /**
   * Encrypt+insert a new doc, then add it to the Map.
   */
  insert: (doc: T) => Promise<void>
  /**
   * Re-encrypt a doc in place (sequence+1), then replace it in the Map.
   */
  update: (doc: T) => Promise<void>
  /**
   * Tombstone a doc, then drop it from the Map.
   */
  remove: (uuid: string) => Promise<void>
  /**
   * Replace the whole Map WITHOUT persisting. This is the app-facing bulk
   * reset verb: the registry pattern wires `StoreRegistryEntry.clear` to
   * `replaceAll([])` on logout (see the README). Discards any buffered pull
   * burst so it cannot resurrect docs past the reset.
   */
  replaceAll: (docs: T[]) => void
  /**
   * Upsert one already-decrypted doc into the Map WITHOUT persisting (the sync
   * stream owns the persisted row already). Used for per-doc reactive patching
   * of pulled/conflict-resolved remote changes; coalesced into one store update
   * per pull burst (see the reactivity note above). When both the incoming and
   * the held doc carry the LWW fields (`updatedAt` + `deviceId`), a stale
   * incoming doc is discarded rather than clobbering the newer held one.
   */
  patch: (doc: T) => void
  /**
   * Drop one doc from the Map WITHOUT persisting (remote tombstone patch);
   * coalesced with `patch` into one store update per pull burst.
   */
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
  return create<EntityStore<T>>(set => {
    // The pull path (`patch` / `drop`) can fire once per remote change; an
    // initial device sync of N docs would otherwise clone the byId Map N times
    // and push N separate store updates (O(N^2) copies + N re-renders). Buffer
    // the per-doc remote patches and flush the whole burst in ONE Map clone +
    // ONE `set` on a microtask, preserving per-event insert/drop ordering.
    const pending: Array<
      { type: 'upsert'; doc: T } | { type: 'drop'; uuid: string }
    > = []
    let flushScheduled = false

    /**
     * Applies the buffered pull burst in one Map clone + one `set`.
     */
    function flushPending(): void {
      flushScheduled = false
      if (pending.length === 0) {
        return
      }
      const ops = pending.splice(0)
      set(state => {
        let changed = false
        const byId = new Map(state.byId)
        for (const op of ops) {
          if (op.type === 'upsert') {
            // LWW guard: `patch` events decrypt asynchronously, so two events
            // for the same doc can arrive out of order, and a pull echo can
            // trail a newer optimistic local write. When both payloads carry
            // the LWW fields, a stale incoming doc must not clobber the newer
            // held one.
            const held = byId.get(op.doc.id)
            const incoming = lwwFields(op.doc)
            const current = held === undefined ? null : lwwFields(held)
            if (incoming && current && !remotePayloadWins(incoming, current)) {
              continue
            }
            byId.set(op.doc.id, op.doc)
            changed = true
          } else if (byId.delete(op.uuid)) {
            changed = true
          }
        }
        // A burst of stray drops (ids not present) leaves the Map untouched;
        // keep the old reference so no needless re-render fires.
        return changed ? { byId } : state
      })
    }

    /**
     * Schedules a single microtask flush per pull burst.
     */
    function schedulePendingFlush(): void {
      if (!flushScheduled) {
        flushScheduled = true
        queueMicrotask(flushPending)
      }
    }

    return {
      byId: new Map<string, T>(),
      hydrate: async () => {
        const docs = await requireStore().listEntities<T>(collectionKey)
        set({ byId: new Map(docs.map(d => [d.id, d])) })
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
        pending.length = 0
        set({ byId: new Map(docs.map(doc => [doc.id, doc])) })
      },
      patch: doc => {
        pending.push({ type: 'upsert', doc })
        schedulePendingFlush()
      },
      drop: uuid => {
        pending.push({ type: 'drop', uuid })
        schedulePendingFlush()
      }
    }
  })
}
