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
import {
  useSyncStatusStore,
  deriveSyncRollup,
  type SyncRollup
} from '../storage/syncStatusStore.js'

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
  onboarding: ReturnType<WasAuthStore['getState']>['onboarding']
  authenticating: boolean
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
      onboarding: state.onboarding,
      authenticating: state.authenticating,
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
 * The login action plus the state the login page renders. `authenticating` is
 * the in-flight flag (the `status` stays `local` during login); `status` is
 * exposed so a login page can redirect once it reads `connected`. `login`
 * accepts `{ adopt }` -- `'merge'` (default) migrates data created in `local`
 * into the connected replica, `'leave'` sets it aside untouched.
 *
 * @returns {object}
 */
export function useLogin(): {
  login: (options?: { adopt?: 'merge' | 'leave' }) => Promise<void>
  authenticating: boolean
  status: ReturnType<WasAuthStore['getState']>['status']
  phase: ReturnType<WasAuthStore['getState']>['phase']
  error: string | null
} {
  const store = useAuthStore()
  const login = useStore(store, state => state.login)
  const { authenticating, status, phase, error } = useStore(
    store,
    useShallow(state => ({
      authenticating: state.authenticating,
      status: state.status,
      phase: state.phase,
      error: state.error
    }))
  )
  return { login, authenticating, status, phase, error }
}

/**
 * The logout action; accepts `{ wipe }` to delete the connected replica rather
 * than keep it on the device.
 *
 * @returns {(options?: { wipe?: boolean }) => Promise<void>}
 */
export function useLogout(): (options?: { wipe?: boolean }) => Promise<void> {
  const store = useAuthStore()
  return useStore(store, state => state.logout)
}

/**
 * The clear-data action: deletes the local replica, discards the anonymous
 * seed, and mints a fresh anonymous seed/DID + replica (the `local`-mode
 * "Clear data" affordance).
 *
 * @returns {() => Promise<void>}
 */
export function useClearData(): () => Promise<void> {
  const store = useAuthStore()
  return useStore(store, state => state.clearLocalData)
}

/**
 * Whether the anonymous `local` replica currently holds any documents -- the
 * check a login affordance runs at decision time (e.g. on the login button
 * click) to choose between opening the adoption dialog and calling `login()`
 * directly. Returns the async check, not a subscription.
 *
 * @returns {() => Promise<boolean>}
 */
export function useHasLocalData(): () => Promise<boolean> {
  const store = useAuthStore()
  return useStore(store, state => state.hasLocalData)
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

/**
 * The aggregate replication rollup: no sync running, or error > syncing >
 * synced. Re-exported from the sync-status store, where the derivation lives.
 */
export type { SyncRollup }

/**
 * The aggregate sync status over the per-collection replication statuses. A thin
 * subscription over the sync-status store: it reads the collection statuses and
 * defers the offline / error > syncing > synced precedence to
 * {@link deriveSyncRollup}.
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
  return deriveSyncRollup(values)
}
