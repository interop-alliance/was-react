/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The React hooks over the session store: thin selectors that read the bound
 * store from context (the logic lives in the auth store and the sync-status
 * store). Components consume these rather than reaching for a module singleton.
 */
import { useContext } from 'react'
import { useStore } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { WasSessionContext } from './WasSessionProvider.js'
import type { WasAuthStore } from '../session/authStore.js'
import { useSyncStatusStore } from '../storage/syncStatusStore.js'

export { useAppReady } from '../session/appReadyStore.js'

/**
 * The bound auth store from the nearest {@link WasSessionProvider}. Throws a
 * helpful error when used outside a provider.
 *
 * @returns {WasAuthStore}
 */
export function useAuthStore(): WasAuthStore {
  const store = useContext(WasSessionContext)
  if (!store) {
    throw new Error(
      'useAuthStore must be used within a <WasSessionProvider>. Wrap your app ' +
        'in <WasSessionProvider config={...} registry={...}>.'
    )
  }
  return store
}

/**
 * The current session state (status/phase/expiry/reconnect flags). Re-renders
 * only when one of the selected fields changes.
 *
 * @returns {object}
 */
export function useSession(): {
  status: ReturnType<WasAuthStore['getState']>['status']
  phase: ReturnType<WasAuthStore['getState']>['phase']
  error: string | null
  controllerDid: string | null
  expires: string | null
  accessExpired: boolean
  reconnecting: boolean
} {
  const store = useAuthStore()
  return useStore(
    store,
    useShallow(state => ({
      status: state.status,
      phase: state.phase,
      error: state.error,
      controllerDid: state.controllerDid,
      expires: state.expires,
      accessExpired: state.accessExpired,
      reconnecting: state.reconnecting
    }))
  )
}

/**
 * The login action plus the state the login page renders (status/phase/error).
 *
 * @returns {object}
 */
export function useLogin(): {
  login: () => Promise<void>
  status: ReturnType<WasAuthStore['getState']>['status']
  phase: ReturnType<WasAuthStore['getState']>['phase']
  error: string | null
} {
  const store = useAuthStore()
  const login = useStore(store, state => state.login)
  const { status, phase, error } = useStore(
    store,
    useShallow(state => ({
      status: state.status,
      phase: state.phase,
      error: state.error
    }))
  )
  return { login, status, phase, error }
}

/**
 * The logout action.
 *
 * @returns {() => Promise<void>}
 */
export function useLogout(): () => Promise<void> {
  const store = useAuthStore()
  return useStore(store, state => state.logout)
}

/**
 * The expired-access reconnect: the banner flags plus the reconnect action.
 *
 * @returns {object}
 */
export function useReconnect(): {
  accessExpired: boolean
  reconnecting: boolean
  reconnect: () => Promise<void>
} {
  const store = useAuthStore()
  const reconnect = useStore(store, state => state.reconnect)
  const { accessExpired, reconnecting } = useStore(
    store,
    useShallow(state => ({
      accessExpired: state.accessExpired,
      reconnecting: state.reconnecting
    }))
  )
  return { accessExpired, reconnecting, reconnect }
}

/** The aggregate replication rollup: no sync running, or error > syncing > synced. */
export type SyncRollup = 'offline' | 'error' | 'syncing' | 'synced'

/**
 * The aggregate sync status over the per-collection replication statuses. With
 * no replication running (offline / local-only) it reports `offline`; otherwise
 * it rolls the collection states up to error > syncing > synced.
 *
 * @returns {{ state: SyncRollup, label: string, title: string }}
 */
export function useSyncStatus(): {
  state: SyncRollup
  label: string
  title: string
} {
  const values = useSyncStatusStore(
    useShallow(state => Object.values(state.statuses))
  )

  if (values.length === 0) {
    return {
      state: 'offline',
      label: 'Offline',
      title: 'Local-only mode -- no storage sync running'
    }
  }
  if (values.includes('error')) {
    return {
      state: 'error',
      label: 'Sync error',
      title: 'A collection failed to sync; retrying'
    }
  }
  if (values.includes('syncing') || values.includes('idle')) {
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
