/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Zustand store holding per-collection replication status, mirroring the WAS
 * per-replica sync-status vocabulary. The sync controller writes to it off the
 * RxDB replication `active$` / `error$` streams; UI (e.g. a header indicator or
 * a settings page) reads from it. In-memory only, like the session -- cleared on
 * logout.
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

interface SyncStatusState {
  /**
   * Keyed by WAS collection id (e.g. `action-items`).
   */
  statuses: Record<string, SyncStatus>
  setStatus: (collectionId: string, status: SyncStatus) => void
  reset: () => void
}

export const useSyncStatusStore = create<SyncStatusState>()(set => ({
  statuses: {},
  setStatus: (collectionId, status) =>
    set(state => ({
      statuses: { ...state.statuses, [collectionId]: status }
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
      label: 'Offline',
      title: 'Local-only mode -- no storage sync running'
    }
  }
  if (statuses.includes('error')) {
    return {
      state: 'error',
      label: 'Sync error',
      title: 'A collection failed to sync; retrying'
    }
  }
  if (statuses.includes('syncing') || statuses.includes('idle')) {
    return {
      state: 'syncing',
      label: 'Syncing',
      title: 'Replicating with your wallet storage'
    }
  }
  return {
    state: 'synced',
    label: 'Synced',
    title: 'All collections replicated'
  }
}
