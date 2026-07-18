/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The session provider: instantiates the wallet-mode auth store once (from the
 * app's config + store registry) and shares it through React context. The hooks
 * (`useAuthStore`, `useSession`, ...) read the bound store from this context.
 *
 * One provider per app; wrap the router (or the whole tree) in it. The store is
 * created lazily in a `useState` initializer so it survives re-renders and is
 * never rebuilt.
 */
import { createContext, useEffect, useState, type ReactNode } from 'react'
import type { StoreRegistry, WasAppConfig } from '../config.js'
import { createAuthStore, type WasAuthStore } from '../session/authStore.js'

/**
 * The bound auth store, or `null` outside a provider. The `useAuthStore` hook
 * throws a helpful error on the `null` case.
 */
export const WasSessionContext = createContext<WasAuthStore | null>(null)

/**
 * Provides the wallet-mode session store to the tree beneath it.
 *
 * @param props {object}
 * @param props.config {WasAppConfig}   the app-wide configuration
 * @param props.registry {StoreRegistry}   the per-collection hydrate/patch
 *   handlers
 * @param props.children {ReactNode}
 * @returns {ReactNode}
 */
export function WasSessionProvider({
  config,
  registry,
  children
}: {
  config: WasAppConfig
  registry: StoreRegistry
  children: ReactNode
}): ReactNode {
  const [store] = useState<WasAuthStore>(() =>
    createAuthStore({ config, registry })
  )
  // Kick off boot on mount (so a local-first app that never renders
  // `ProtectedRoute` still boots), and tear the live session down on unmount so
  // an abandoned provider never leaves the expiry-watch interval and the
  // replication loop firing against a store no one is reading (reliably hit by
  // React StrictMode dev remounts and by tests). `destroy()` returns the store
  // to `boot` with both persisted seeds intact, so a StrictMode remount's
  // `boot()` re-opens the same session (or fresh local).
  useEffect(() => {
    void store.getState().boot()
    return () => {
      void store.getState().destroy()
    }
  }, [store])
  return (
    <WasSessionContext.Provider value={store}>
      {children}
    </WasSessionContext.Provider>
  )
}
