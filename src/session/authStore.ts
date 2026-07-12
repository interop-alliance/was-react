/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The wallet-mode auth store (zustand): owns the session lifecycle -- hot
 * restore (zero popups), Login With Wallet, logout, and the expired-access
 * reconnect -- plus the open/hydrate/sync ordering.
 *
 * On a successful login/restore it opens the encrypted {@link LocalStore} from
 * the session seed (a per-controller database name, so two wallet users on one
 * browser never collide), hydrates the entity stores, flips the shared
 * `useAppReady` gate, and starts WAS replication from the granted zcaps.
 *
 * `status` is the router gate: `ProtectedRoute` waits for the restore attempt to
 * settle before deciding between the app and the login page.
 *
 * The library cannot bind a module-level store to app config, so this is a
 * FACTORY: {@link createAuthStore} captures the app's {@link WasAppConfig} and
 * {@link StoreRegistry} once (the React provider calls it once) and returns a
 * vanilla zustand store the hooks consume through context.
 */
import { createStore, type StoreApi } from 'zustand/vanilla'
import type { RxStorage } from 'rxdb/plugins/core'
import type { IZcap } from '@interop/data-integrity-core'
import {
  DEFAULT_DB_NAME,
  DEFAULT_EXPIRY_WARNING_MS,
  DEFAULT_EXPIRY_WATCH_MS,
  type StoreRegistry,
  type WasAppConfig
} from '../config.js'
import { createDocumentLoader } from '../identity/documentLoader.js'
import { initAppSession } from '../identity/initAppSession.js'
import type { IdentityAgents } from '../identity/agents.js'
import { createSeedStore, type SeedStore } from '../identity/seedStore.js'
import {
  clearAppSession,
  persistAppSession,
  restoreAppSession,
  isNearExpiry
} from '../identity/appSession.js'
import {
  loginWithWallet,
  requestGrants,
  LoginCancelledError,
  type LoginConfig,
  type LoginPhase
} from '../auth/loginFlow.js'
import { parseGrants, type ParsedGrants } from '../grants.js'
import { LocalStore, dbNameForController } from '../storage/localStore.js'
import {
  clearLocalStore,
  hasStore,
  requireStore,
  setLocalStore
} from '../storage/storageManager.js'
import {
  cancelScheduledRehydrates,
  clearAllEntityStores,
  hydrateAll,
  patchFromChange
} from '../storage/rehydrate.js'
import { startWasSync } from '../storage/wasSync.js'
import { errorMessage } from '../sync/index.js'
import {
  createSyncController,
  type SyncController
} from '../storage/syncController.js'
import { useSyncStatusStore } from '../storage/syncStatusStore.js'
import { useAppReady } from './appReadyStore.js'

export type AuthStatus =
  'idle' | 'restoring' | 'unauthenticated' | 'authenticating' | 'authenticated'

interface ActiveSession {
  seed: Uint8Array
  identity: IdentityAgents
  parsed: ParsedGrants
  grants: IZcap[]
  expires: string
}

export interface AuthState {
  status: AuthStatus
  /**
   * The current login phase, for the login page's progress line.
   */
  phase: LoginPhase | null
  error: string | null
  controllerDid: string | null
  /**
   * ISO expiry of the current grant set (earliest zcap expiry).
   */
  expires: string | null
  /**
   * A live 401/403 was seen mid-session: show the reconnect banner.
   */
  accessExpired: boolean
  reconnecting: boolean
  /**
   * Hot restore from the persisted session; falls to `unauthenticated`.
   */
  restore: () => Promise<void>
  /**
   * Full Login With Wallet (first-run or returning).
   */
  login: () => Promise<void>
  /**
   * Re-run the grants flow with the existing seed (expired access).
   */
  reconnect: () => Promise<void>
  logout: () => Promise<void>
  notifyAccessExpired: () => void
  /**
   * Tears down the live session (expiry watch, controller, local store) WITHOUT
   * wiping the persisted session record, and returns to `idle` so a fresh
   * `restore()` can re-open it. Called from the provider's unmount cleanup so an
   * unmount (or a React StrictMode dev remount) never orphans the replication
   * loop or the expiry-watch interval.
   */
  destroy: () => Promise<void>
}

/**
 * The vanilla zustand store returned by {@link createAuthStore}.
 */
export type WasAuthStore = StoreApi<AuthState>

/**
 * Builds the wallet-mode auth store bound to an app's config and store registry.
 * Call once (the React provider does) and share the returned store through
 * context; the hooks read it via `useStore`.
 *
 * @param options {object}
 * @param options.config {WasAppConfig}   the app-wide configuration
 * @param options.registry {StoreRegistry}   the per-collection hydrate/patch
 *   handlers the rehydrate mechanism drives
 * @param [options.seedStore] {SeedStore}   the session IndexedDB persistence
 *   (defaults to one bound to `<dbName>-session`; inject a fake for tests)
 * @param [options.storage] {RxStorage}   the RxDB storage for the local store
 *   (defaults to Dexie/IndexedDB; inject a fake for tests)
 * @returns {WasAuthStore}
 */
export function createAuthStore({
  config,
  registry,
  seedStore,
  storage
}: {
  config: WasAppConfig
  registry: StoreRegistry
  seedStore?: SeedStore
  storage?: RxStorage<unknown, unknown>
}): WasAuthStore {
  const dbName = config.dbName ?? DEFAULT_DB_NAME
  const sessionStore =
    seedStore ?? createSeedStore({ dbName: `${dbName}-session` })
  const documentLoader = createDocumentLoader(
    config.wasServerUrl !== undefined
      ? { wasServerUrl: config.wasServerUrl }
      : {}
  )

  // The login flow consumes only the WAS collection ids; this config layer owns
  // the `{ key, id }` registry.
  const loginConfig: LoginConfig = {
    appOrigin: config.appOrigin,
    appName: config.appName,
    collections: config.collections.map(collection => collection.id),
    credential: config.credential,
    documentLoader,
    ...(config.wasServerUrl !== undefined && {
      wasServerUrl: config.wasServerUrl
    }),
    ...(config.mediatorBase !== undefined && {
      mediatorBase: config.mediatorBase
    })
  }

  /**
   * How close to grant expiry the reconnect banner is raised proactively (so the
   * user re-grants before a live request fails). Wallet grants default to a long
   * TTL, so a short lead time never fires spuriously mid-session.
   */
  const warningMs = config.expiry?.warningMs ?? DEFAULT_EXPIRY_WARNING_MS
  /**
   * Poll interval for the near-expiry watch (grant expiry is coarse-grained).
   */
  const watchMs = config.expiry?.watchMs ?? DEFAULT_EXPIRY_WATCH_MS

  let expiryTimer: ReturnType<typeof setInterval> | undefined
  // The per-session controller: single-use, stopped on logout and replaced on a
  // reconnect (started once per grant set).
  let controller: SyncController | null = null
  // The in-flight `beginSync` promise (controller.start() awaits network round
  // trips first). Awaited before teardown so a logout racing the bootstrap
  // cannot stop the controller before it has finished starting.
  let pendingSync: Promise<unknown> | null = null

  /**
   * Stops the near-expiry watch (logout / re-grant).
   */
  function disarmExpiryWatch(): void {
    if (expiryTimer) {
      clearInterval(expiryTimer)
      expiryTimer = undefined
    }
  }

  /**
   * Watches the session's earliest grant expiry and raises the reconnect banner
   * once it is within `warningMs` (or already past). Checks immediately, then on
   * a coarse interval; re-armed with the fresh expiry after a reconnect.
   */
  function armExpiryWatch(expires: string): void {
    disarmExpiryWatch()
    const check = () => {
      if (isNearExpiry(expires, warningMs)) {
        store.getState().notifyAccessExpired()
      }
    }
    check()
    expiryTimer = setInterval(check, watchMs)
  }

  /**
   * Starts a fresh per-session controller replicating the granted collections,
   * wiring reactive per-doc store patching and the auth-error (401/403) signal.
   */
  function beginSync({
    parsed,
    zcapClient
  }: {
    parsed: ParsedGrants
    zcapClient: IdentityAgents['zcapClient']
  }): Promise<unknown> {
    controller = createSyncController({
      collections: config.collections,
      ...(config.sync && { sync: config.sync })
    })
    return startWasSync({
      parsed,
      zcapClient,
      localStore: requireStore(),
      syncController: controller,
      onRemoteChange: (key, event) =>
        void patchFromChange(registry, key, event),
      onAuthError: () => store.getState().notifyAccessExpired()
    })
  }

  /**
   * Persists the session record, kicks off background replication, and arms the
   * near-expiry watch. Shared by the login/restore activation and the reconnect
   * re-grant paths (identical persist + begin-sync + arm sequence).
   *
   * @param options {object}
   * @param options.seed {Uint8Array}
   * @param options.identity {IdentityAgents}
   * @param options.parsed {ParsedGrants}
   * @param options.grants {IZcap[]}
   * @param options.expires {string}
   * @returns {Promise<void>}
   */
  async function persistAndStartSync({
    seed,
    identity,
    parsed,
    grants,
    expires
  }: {
    seed: Uint8Array
    identity: IdentityAgents
    parsed: ParsedGrants
    grants: IZcap[]
    expires: string
  }): Promise<void> {
    await persistAppSession({
      session: {
        seed,
        controllerDid: identity.controllerDid,
        serverUrl: parsed.serverUrl,
        spaceId: parsed.spaceId,
        grants,
        expires
      },
      store: sessionStore
    })
    // Replication starts in the background; a down server never blocks entry.
    pendingSync = beginSync({ parsed, zcapClient: identity.zcapClient })
    void pendingSync.catch(err =>
      console.warn('WAS sync failed to start:', err)
    )
    armExpiryWatch(expires)
  }

  /**
   * Awaits any in-flight `beginSync` (so the controller has finished starting)
   * and then stops and releases the controller. Idempotent.
   */
  async function stopController(): Promise<void> {
    if (pendingSync) {
      try {
        await pendingSync
      } catch {
        // A failed bootstrap is already logged by the `.catch` on `pendingSync`.
      }
      pendingSync = null
    }
    if (controller) {
      await controller.stop()
      controller = null
    }
  }

  /**
   * Opens storage + hydrates + starts sync for a validated session, persists it,
   * and flips the ready gate. Shared by login and restore. Any failure after the
   * store is installed tears the store back down (so a later login never reuses a
   * half-open controller's database) and surfaces the open error before
   * rethrowing.
   */
  async function activateSession(session: ActiveSession): Promise<void> {
    try {
      if (!hasStore()) {
        const local = await LocalStore.init({
          seed: session.seed,
          collections: config.collections,
          dbName: dbNameForController({
            dbName,
            controllerDid: session.identity.controllerDid
          }),
          ...(storage && { storage })
        })
        setLocalStore(local)
      }
      await hydrateAll(registry)
      // Flip the ready gate only once the session is durably persisted.
      await persistAndStartSync({
        seed: session.seed,
        identity: session.identity,
        parsed: session.parsed,
        grants: session.grants,
        expires: session.expires
      })
      useAppReady.getState().setReady()
    } catch (err) {
      await deactivateSession()
      const message = errorMessage(err)
      useAppReady.getState().setError(message)
      throw err
    }
  }

  /**
   * Tears down storage + sync + entity stores (logout and re-login paths).
   */
  async function deactivateSession(): Promise<void> {
    disarmExpiryWatch()
    cancelScheduledRehydrates()
    await stopController()
    if (hasStore()) {
      try {
        await requireStore().close()
      } catch (err) {
        console.warn('Error closing the local store:', err)
      }
      clearLocalStore()
    }
    clearAllEntityStores(registry)
    useSyncStatusStore.getState().reset()
    useAppReady.getState().reset()
  }

  // Declared last so `prefer-const` is satisfied; the lifecycle closures above
  // only dereference `store` at call time, by which point it is assigned.
  const store: WasAuthStore = createStore<AuthState>()((set, get) => ({
    status: 'idle',
    phase: null,
    error: null,
    controllerDid: null,
    expires: null,
    accessExpired: false,
    reconnecting: false,

    restore: async () => {
      if (get().status !== 'idle') {
        return
      }
      set({ status: 'restoring' })
      try {
        const restored = await restoreAppSession({ store: sessionStore })
        if (!restored) {
          set({ status: 'unauthenticated' })
          return
        }
        const identity = await initAppSession({ seed: restored.seed })
        if (identity.controllerDid !== restored.controllerDid) {
          // A corrupt record; treat as logged out.
          await clearAppSession({ store: sessionStore })
          set({ status: 'unauthenticated' })
          return
        }
        const parsed = parseGrants(restored.grants)
        if (
          config.wasServerUrl !== undefined &&
          parsed.serverUrl !== config.wasServerUrl
        ) {
          await clearAppSession({ store: sessionStore })
          set({ status: 'unauthenticated' })
          return
        }
        // Unlike login/reconnect (which run `checkGrants`), a hot restore trusts
        // the persisted grants; re-check that they still cover every configured
        // collection so a partially-covered grant set raises the reconnect banner
        // proactively rather than waiting for a per-collection 403 mid-session.
        const uncovered = config.collections.filter(
          collection => parsed.byCollectionId[collection.id] === undefined
        )
        await activateSession({
          seed: restored.seed,
          identity,
          parsed,
          grants: restored.grants,
          expires: restored.expires
        })
        set({
          status: 'authenticated',
          controllerDid: identity.controllerDid,
          expires: restored.expires,
          error: null,
          accessExpired: uncovered.length > 0
        })
      } catch (err) {
        console.warn('Session restore failed:', err)
        set({ status: 'unauthenticated' })
      }
    },

    login: async () => {
      const { status } = get()
      if (status === 'authenticating' || status === 'authenticated') {
        return
      }
      set({ status: 'authenticating', error: null, phase: 'probing' })
      try {
        const outcome = await loginWithWallet({
          config: loginConfig,
          onPhase: phase => set({ phase })
        })
        await activateSession({
          seed: outcome.seed,
          identity: outcome.identity,
          parsed: outcome.parsed,
          grants: outcome.grants,
          expires: outcome.expires
        })
        set({
          status: 'authenticated',
          controllerDid: outcome.identity.controllerDid,
          expires: outcome.expires,
          phase: null,
          error: null,
          accessExpired: false
        })
      } catch (err) {
        const message =
          err instanceof LoginCancelledError
            ? err.message
            : err instanceof Error
              ? `Login failed: ${err.message}`
              : 'Login failed.'
        set({ status: 'unauthenticated', phase: null, error: message })
      }
    },

    reconnect: async () => {
      const { reconnecting, status } = get()
      if (reconnecting || status !== 'authenticated') {
        return
      }
      set({ reconnecting: true, error: null })
      try {
        // The seed survives grant expiry; only the grants need renewing. Read it
        // directly (not via `restoreAppSession`, which WIPES an expired record
        // -- seed included -- exactly in the case reconnect exists for). A
        // missing seed means the session is unrecoverable in place.
        const seed = await sessionStore.loadSeed()
        if (!seed) {
          await get().logout()
          return
        }
        const identity = await initAppSession({ seed })
        const checked = await requestGrants({ identity, config: loginConfig })
        await stopController()
        await persistAndStartSync({
          seed,
          identity,
          parsed: checked.parsed,
          grants: checked.grants,
          expires: checked.expires
        })
        set({
          accessExpired: false,
          expires: checked.expires,
          reconnecting: false
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Reconnect failed.'
        set({ reconnecting: false, error: message })
      }
    },

    logout: async () => {
      await deactivateSession()
      await clearAppSession({ store: sessionStore })
      set({
        status: 'unauthenticated',
        phase: null,
        error: null,
        controllerDid: null,
        expires: null,
        accessExpired: false,
        reconnecting: false
      })
    },

    notifyAccessExpired: () => {
      if (!get().accessExpired) {
        set({ accessExpired: true })
      }
    },

    destroy: async () => {
      await deactivateSession()
      // Back to `idle` (not `unauthenticated`) and the record left intact: a
      // StrictMode remount's `restore()` re-opens the same session from disk.
      set({
        status: 'idle',
        phase: null,
        error: null,
        accessExpired: false,
        reconnecting: false
      })
    }
  }))

  return store
}
