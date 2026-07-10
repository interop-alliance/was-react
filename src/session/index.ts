/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The session lifecycle layer: the wallet-mode auth store factory and the shared
 * app-ready gate.
 */
export {
  createAuthStore,
  type AuthStatus,
  type AuthState,
  type WasAuthStore
} from './authStore.js'
export { useAppReady } from './appReadyStore.js'
