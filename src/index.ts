/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * `@interop/was-react`: build "Bring Your Own Everything" (BYOE) apps on Wallet
 * Attached Storage -- DID-Auth login via a CHAPI wallet, local-first encrypted
 * storage, and background sync to a WAS server.
 *
 * This is the core entry. The optional MUI + react-router components live at
 * `@interop/was-react/mui`; the Node-only dev-grant provisioner lives at
 * `@interop/was-react/dev`. Neither is re-exported here.
 */

// Configuration contract.
export {
  DEFAULT_DB_NAME,
  DEFAULT_STORAGE_KEY_PREFIX,
  DEFAULT_SYNC_POLL_MS,
  DEFAULT_EXPIRY_WARNING_MS,
  DEFAULT_EXPIRY_WATCH_MS,
  collectionKeyForId,
  validateCollections,
  validateSharedCollections,
  type WasCollectionConfig,
  type SharedCollectionConfig,
  type WasSyncConfig,
  type WasExpiryConfig,
  type WasAppConfig,
  type StoreRegistryEntry,
  type StoreRegistry
} from './config.js'

// Grant parsing / topology routing.
export {
  parseInvocationTarget,
  parseGrants,
  type ParsedGrants
} from './grants.js'

// Identity: the seed-derived agents, including the identity key-agreement key
// every encrypted collection is read with.
export {
  deriveIdentity,
  DEFAULT_IDENTITY_HANDLE,
  type IdentityAgents
} from './identity/agents.js'
export {
  createDocumentLoader,
  type DocumentLoader
} from './identity/documentLoader.js'
export {
  createSeedStore,
  createDescriptorCache,
  type SeedStore
} from './identity/seedStore.js'
export {
  APP_KEY_CREDENTIAL_TYPE,
  issueSeedCredential,
  parseSeedCredential,
  findSeedCredential,
  bytesToBase64url,
  base64urlToBytes,
  type SeedCredentialConfig,
  type ParsedSeedCredential
} from './identity/seedCredential.js'
export {
  persistAppSession,
  restoreAppSession,
  clearAppSession,
  isExpired,
  isNearExpiry,
  earliestExpiry,
  type AppSessionRecord,
  type RestoredAppSession
} from './identity/appSession.js'

// Auth: CHAPI bridge, VPR construction, response verification, login flow.
export { DEFAULT_MEDIATOR_BASE, loadChapi, chapiGet } from './auth/chapi.js'
export {
  RW_ACTIONS,
  SHARED_ACTIONS,
  newChallenge,
  buildAppConnectVpr,
  type GrantRequestCollection
} from './auth/loginRequest.js'
export {
  verifyLoginPresentation,
  grantsOf,
  checkGrants,
  type CheckedGrants
} from './auth/verifyResponse.js'
export {
  loginWithWallet,
  requestGrants,
  LoginCancelledError,
  WalletUnsupportedError,
  type LoginConfig,
  type LoginPhase,
  type LoginOutcome
} from './auth/loginFlow.js'
export type {
  IVPRDetails,
  IVPRQuery,
  IDIDAuthenticationQuery,
  IAppConnectQuery,
  IAppConnectCapabilityQuery,
  ICapabilityQueryDetail,
  IVerifiableCredential,
  IVerifiablePresentation,
  IZcap
} from './auth/walletRequestTypes.js'

// The collection-agnostic RxDB-WAS replication core.
export * from './sync/index.js'

// Storage: local encrypted replica, the process-wide store holder, entity
// stores, the delegated remote store, sync status, rehydrate mechanism, and the
// replication controller.
export { LocalStore } from './storage/localStore.js'
export {
  setLocalStore,
  requireStore,
  hasStore,
  clearLocalStore,
  setRemoteStore,
  requireRemoteStore,
  hasRemoteStore,
  clearRemoteStore,
  getClientId
} from './storage/storageManager.js'
export { createEntityStore, type EntityStore } from './storage/entityStore.js'
export {
  WasRemoteStore,
  remoteDescriptorSource,
  type DeclarationResult,
  type EqualityQueryPage
} from './storage/wasRemoteStore.js'
export {
  SharedCollectionReader,
  SharedCollectionUnavailableError,
  SHARED_CHANGES_PAGE_SIZE,
  type SharedResource
} from './storage/sharedCollectionReader.js'
export { publicUrlFor } from './storage/publicUrl.js'
export {
  useSyncStatusStore,
  deriveSyncRollup,
  type SyncStatus
} from './storage/syncStatusStore.js'
export {
  hydrateAll,
  clearAllEntityStores,
  patchFromChange,
  scheduleRehydrate,
  cancelScheduledRehydrates
} from './storage/rehydrate.js'
export { isAuthError, SyncController } from './storage/syncController.js'
export { startWasSync, type WasSyncBootstrap } from './storage/wasSync.js'

// Session lifecycle: the session auth store factory (the four-state machine).
export {
  createAuthStore,
  type SessionStatus,
  type AuthState,
  type WasAuthStore
} from './session/index.js'

// React: the session provider + hooks.
export {
  WasSessionProvider,
  WasSessionContext,
  useAuthStore,
  useSession,
  useLogin,
  useLogout,
  useClearData,
  useHasLocalData,
  useReconnect,
  useSharedCollection,
  useSyncStatus,
  type SyncRollup,
  defineDocumentApp,
  DOCUMENT_COLLECTION_KEY,
  DOCUMENT_EXPORT_FORMAT,
  type DocumentApp
} from './react/index.js'
