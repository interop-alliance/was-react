/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Zustand store holding per-collection replication status, mirroring the WAS
 * per-replica sync-status vocabulary, keyed by the registry's logical collection
 * key. The sync controller writes to it off the RxDB replication `active$` /
 * `error$` streams; UI (e.g. a header indicator or a settings page) reads from
 * it. In-memory only, like the session -- cleared on logout.
 */
import { create } from 'zustand'

/**
 * A single collection's replication status:
 * - `idle`    -- configured but no cycle has run yet
 * - `syncing` -- a pull/push cycle is in flight
 * - `synced`  -- last cycle completed without error
 * - `error`   -- last cycle failed (RxDB is backing off / will retry)
 */
export type SyncStatus = 'idle' | 'syncing' | 'synced' | 'error'

export const useSyncStatusStore = create<{
  /**
   * Keyed by the registry's LOGICAL collection key (`WasCollectionConfig.key`,
   * e.g. `actionItems`), not the WAS wire id. Two registry entries may share one
   * WAS id, so the id is not a unique status key; every other layer (the entity
   * stores, the rehydrate mechanism, the local replica's RxDB collections)
   * routes on the logical key too.
   */
  statuses: Record<string, SyncStatus>
  setStatus: (collectionKey: string, status: SyncStatus) => void
  reset: () => void
}>()(set => ({
  statuses: {},
  setStatus: (collectionKey, status) =>
    set(state => ({
      statuses: { ...state.statuses, [collectionKey]: status }
    })),
  reset: () => set({ statuses: {} })
}))

/**
 * The aggregate replication status derived from the per-collection statuses:
 * `offline` when no replication is running (local-only), otherwise rolled up as
 * error > syncing > synced.
 */
export type SyncRollup = 'offline' | 'error' | 'syncing' | 'synced'

/**
 * Rolls the per-collection replication statuses up to a single aggregate plus
 * its display copy. With no collections registered it reports `offline`
 * (local-only, no sync running); otherwise it applies the
 * error > syncing > synced precedence (`idle` counts as syncing -- a collection
 * configured but not yet cycled). Kept beside the status vocabulary so the
 * precedence lives with the store rather than the view; `useSyncStatus` is a
 * thin subscription over it.
 *
 * @param statuses {SyncStatus[]}   the per-collection statuses (store values)
 * @returns {{ state: SyncRollup, label: string, title: string }}
 */
export function deriveSyncRollup(statuses: SyncStatus[]): {
  state: SyncRollup
  label: string
  title: string
} {
  if (statuses.length === 0) {
    return {
      state: 'offline',
      label: 'Local only',
      title: 'Local-only mode -- your data stays on this device'
    }
  }
  if (statuses.includes('error')) {
    return {
      state: 'error',
      label: 'Sync error',
      title: 'Connected to storage -- a collection failed to sync; retrying'
    }
  }
  if (statuses.includes('syncing') || statuses.includes('idle')) {
    return {
      state: 'syncing',
      label: 'Syncing',
      title: 'Connected to storage -- replicating your collections'
    }
  }
  return {
    state: 'synced',
    label: 'Synced',
    title: 'Connected to storage -- all collections replicated'
  }
}
