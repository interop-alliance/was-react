/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The app-ready gate: a tiny shared zustand store the auth store flips once the
 * session seed has opened the local store and hydrated every entity store. The
 * router gate (`ProtectedRoute` / the `useAppReady` hook) waits on it before
 * rendering the app.
 *
 * This is only the ready-flag store extracted from the app-side bootstrap; the
 * dev-mode `initApp` open/hydrate driver stays app-side. In wallet mode the auth
 * store owns the open/hydrate ordering and reuses this same gate.
 */
import { create } from 'zustand'

interface AppReadyState {
  ready: boolean
  error: string | null
  setReady: () => void
  setError: (message: string) => void
  reset: () => void
}

export const useAppReady = create<AppReadyState>(set => ({
  ready: false,
  error: null,
  setReady: () => set({ ready: true, error: null }),
  setError: message => set({ error: message }),
  reset: () => set({ ready: false, error: null })
}))
