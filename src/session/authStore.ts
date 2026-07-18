/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The session auth store (zustand): a four-state machine
 * (`boot` | `local` | `connected` | `reconnect`) that owns the whole session
 * lifecycle -- boot (hot restore or fall to an anonymous local replica), Login
 * With Wallet, the non-CHAPI `connectWithGrants` path, logout, clear-data, and
 * the expired-access reconnect -- plus the open/hydrate/sync ordering.
 *
 * `boot` attempts a zero-popup session restore. A restore hit opens the
 * encrypted {@link LocalStore} under the session seed, hydrates the entity
 * stores, starts WAS replication, and lands `connected`. A restore miss (or any
 * error) opens the store under a persisted ANONYMOUS seed instead and lands
 * `local`: a fully usable, encrypted, local-only replica with no remote. Both
 * successors finish open+hydrate before leaving `boot`, so "app ready" is simply
 * `status !== 'boot'`.
 *
 * Login (or `connectWithGrants`) tears the anonymous replica down and opens the
 * connected replica under the wallet-derived seed. Logout returns to a fresh
 * `local` (optionally wiping the connected replica); `clearLocalData` mints a
 * brand-new anonymous seed and replica.
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
  DEFAULT_ONBOARDING,
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
  isNearExpiry,
  earliestExpiry
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

/**
 * The four session states:
 * - `boot`: attempting hot restore; both successors open + hydrate before this
 *   status is left.
 * - `local`: an encrypted anonymous-seed replica, no remote (the pre-connection
 *   product state; tier-1 apps may stay here indefinitely).
 * - `connected`: a wallet-derived identity, parsed grants, replication.
 * - `reconnect`: connected but access expired/revoked; the replica stays usable,
 *   remote invocations paused until re-login.
 */
export type SessionStatus = 'boot' | 'local' | 'connected' | 'reconnect'

interface ActiveSession {
  seed: Uint8Array
  identity: IdentityAgents
  parsed: ParsedGrants
  grants: IZcap[]
  expires: string
}

export interface AuthState {
  status: SessionStatus
  /**
   * The app's onboarding mode. Read by `ProtectedRoute` to decide whether to
   * render the app or redirect to login while in `local`; never affects the
   * store's own transitions.
   */
  onboarding: 'local-first' | 'login-gated'
  /**
   * A Login With Wallet flow is in flight (the transient the login page's busy
   * state keys off; distinct from the `status`, which stays `local` throughout).
   */
  authenticating: boolean
  /**
   * The current login phase, for the login page's progress line.
   */
  phase: LoginPhase | null
  error: string | null
  controllerDid: string | null
  /**
   * ISO expiry of the current grant set (earliest zcap expiry); `null` in
   * `local` (no grants).
   */
  expires: string | null
  /**
   * A live 401/403 was seen mid-session (or a proactive near-expiry): show the
   * reconnect banner. Always true iff `status === 'reconnect'`.
   */
  accessExpired: boolean
  reconnecting: boolean
  /**
   * Attempt a zero-popup hot restore; a restore hit lands `connected`, any
   * miss/error falls to `local` (a fresh anonymous replica), never a dead login
   * screen. No-op once the status has left `boot`.
   */
  boot: () => Promise<void>
  /**
   * Full Login With Wallet (first-run or returning). On success tears down the
   * anonymous replica and opens the connected one.
   */
  login: () => Promise<void>
  /**
   * Non-CHAPI connect from an explicit seed + grants (dev/test and provisioned
   * grants). Tears down the current replica and opens the connected one.
   *
   * @param options {object}
   * @param options.seed {Uint8Array}
   * @param options.grants {IZcap[]}
   * @returns {Promise<void>}
   */
  connectWithGrants: (options: {
    seed: Uint8Array
    grants: IZcap[]
  }) => Promise<void>
  /**
   * Re-run the grants flow with the existing seed (expired access).
   */
  reconnect: () => Promise<void>
  /**
   * Detach the wallet and return to a fresh `local` replica. `wipe` deletes the
   * connected replica's database; otherwise it is kept on the device.
   *
   * @param [options] {object}
   * @param [options.wipe] {boolean}
   * @returns {Promise<void>}
   */
  logout: (options?: { wipe?: boolean }) => Promise<void>
  /**
   * Delete the local replica, discard the anonymous seed, and mint a fresh
   * anonymous seed/DID + replica. The shared reset primitive behind the
   * `local`-mode "Clear data" button.
   */
  clearLocalData: () => Promise<void>
  notifyAccessExpired: () => void
  /**
   * Tears down the live replica (expiry watch, controller, local store) WITHOUT
   * wiping the persisted session record, and returns to `boot` so a fresh
   * `boot()` can re-open it. Called from the provider's unmount cleanup so an
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
 * A nominal far-future expiry (ms) for grants minted without one (dev/test).
 * Well past the near-expiry warning, so the watch never fires against them.
 */
const FAR_FUTURE_EXPIRY_MS = 100 * 365 * 24 * 60 * 60 * 1000

/**
 * Builds the session auth store bound to an app's config and store registry.
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
  const onboarding = config.onboarding ?? DEFAULT_ONBOARDING
  const sessionStore =
    seedStore ?? createSeedStore({ dbName: `${dbName}-session` })
  // The anonymous-seed persistence for `local` mode: only a raw 32-byte seed,
  // no session record, in its own IndexedDB so it never collides with the
  // wallet session or a connected replica.
  const anonStore = createSeedStore({ dbName: `${dbName}-anon` })
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
   * near-expiry watch. Shared by the connected activation and the reconnect
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
   * Opens the encrypted replica under `seed` (a per-controller database name),
   * installs it as the process-wide store, and hydrates every entity store.
   * Shared by `openLocal` and the connected activation.
   *
   * @param options {object}
   * @param options.seed {Uint8Array}
   * @param options.controllerDid {string}
   * @returns {Promise<void>}
   */
  async function openAndHydrate({
    seed,
    controllerDid
  }: {
    seed: Uint8Array
    controllerDid: string
  }): Promise<void> {
    const local = await LocalStore.init({
      seed,
      collections: config.collections,
      dbName: dbNameForController({ dbName, controllerDid }),
      ...(storage && { storage })
    })
    setLocalStore(local)
    await hydrateAll(registry)
  }

  /**
   * Loads the persisted anonymous seed, minting and persisting a fresh random
   * one on first use. `created` is true only when a new seed was generated (the
   * signal for the one-time `seedLocal` fixtures hook).
   *
   * @returns {Promise<{ seed: Uint8Array, created: boolean }>}
   */
  async function loadOrCreateAnonSeed(): Promise<{
    seed: Uint8Array
    created: boolean
  }> {
    const existing = await anonStore.loadSeed()
    if (existing) {
      return { seed: existing, created: false }
    }
    const seed = crypto.getRandomValues(new Uint8Array(32))
    await anonStore.saveSeed(seed)
    return { seed, created: true }
  }

  /**
   * Opens (or re-opens) the anonymous local replica and lands `local`. Seeds
   * dev fixtures only when the anonymous seed was just minted (so they run once
   * per fresh replica, never on reload).
   *
   * @returns {Promise<void>}
   */
  async function openLocal(): Promise<void> {
    const { seed, created } = await loadOrCreateAnonSeed()
    const identity = await initAppSession({ seed })
    await openAndHydrate({ seed, controllerDid: identity.controllerDid })
    if (created && config.seedLocal) {
      await config.seedLocal()
    }
    store.setState({
      status: 'local',
      controllerDid: identity.controllerDid,
      expires: null,
      accessExpired: false,
      error: null
    })
  }

  /**
   * Opens the connected replica under the session seed, hydrates, persists the
   * session, and starts sync. On any failure the store is torn back down and the
   * anonymous local replica re-opened (so the app never dead-ends), then the
   * error is surfaced and rethrown for the caller to finalize.
   *
   * @param session {ActiveSession}
   * @returns {Promise<void>}
   */
  async function activateConnected(session: ActiveSession): Promise<void> {
    try {
      await openAndHydrate({
        seed: session.seed,
        controllerDid: session.identity.controllerDid
      })
      await persistAndStartSync({
        seed: session.seed,
        identity: session.identity,
        parsed: session.parsed,
        grants: session.grants,
        expires: session.expires
      })
    } catch (err) {
      await deactivateStore()
      await openLocal()
      store.setState({ error: errorMessage(err) })
      throw err
    }
  }

  /**
   * Tears down the live replica + sync + entity stores WITHOUT touching either
   * persisted seed (the anonymous seed and the session record survive). Closes
   * the database; use {@link resetToFreshLocal} to delete it.
   *
   * @returns {Promise<void>}
   */
  async function deactivateStore(): Promise<void> {
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
  }

  /**
   * Tears the current replica down and re-opens a fresh `local` replica. `wipe`
   * (via `deleteDb`) deletes the current database rather than closing it (the
   * logout-wipe and clear-data paths); `discardAnonSeed` drops the persisted
   * anonymous seed BEFORE the re-open so `openLocal` mints a brand-new anonymous
   * seed/DID + database (the clear-data path).
   *
   * @param options {object}
   * @param options.deleteDb {boolean}
   * @param [options.discardAnonSeed] {boolean}
   * @returns {Promise<void>}
   */
  async function resetToFreshLocal({
    deleteDb,
    discardAnonSeed = false
  }: {
    deleteDb: boolean
    discardAnonSeed?: boolean
  }): Promise<void> {
    disarmExpiryWatch()
    cancelScheduledRehydrates()
    await stopController()
    if (hasStore()) {
      try {
        if (deleteDb) {
          await requireStore().remove()
        } else {
          await requireStore().close()
        }
      } catch (err) {
        console.warn('Error tearing down the local store:', err)
      }
      clearLocalStore()
    }
    clearAllEntityStores(registry)
    useSyncStatusStore.getState().reset()
    if (discardAnonSeed) {
      await anonStore.clearSeedStore()
    }
    await openLocal()
  }

  /**
   * The step-3 adoption seam: called from `login()` after the wallet returns
   * identity + grants and before the connected replica opens. In step 2 it only
   * tears the anonymous replica down; the anonymous seed and its IndexedDB are
   * left intact (not migrated, not deleted) so a later step can adopt them.
   *
   * @returns {Promise<void>}
   */
  async function adoptLocalIntoConnected(): Promise<void> {
    await deactivateStore()
  }

  // Declared last so `prefer-const` is satisfied; the lifecycle closures above
  // only dereference `store` at call time, by which point it is assigned.
  const store: WasAuthStore = createStore<AuthState>()((set, get) => ({
    status: 'boot',
    onboarding,
    authenticating: false,
    phase: null,
    error: null,
    controllerDid: null,
    expires: null,
    accessExpired: false,
    reconnecting: false,

    boot: async () => {
      if (get().status !== 'boot') {
        return
      }
      try {
        const restored = await restoreAppSession({ store: sessionStore })
        if (!restored) {
          await openLocal()
          return
        }
        const identity = await initAppSession({ seed: restored.seed })
        if (identity.controllerDid !== restored.controllerDid) {
          // A corrupt record; treat as logged out and fall to local.
          await clearAppSession({ store: sessionStore })
          await openLocal()
          return
        }
        const parsed = parseGrants(restored.grants)
        if (
          config.wasServerUrl !== undefined &&
          parsed.serverUrl !== config.wasServerUrl
        ) {
          await clearAppSession({ store: sessionStore })
          await openLocal()
          return
        }
        // Unlike login/reconnect (which run `checkGrants`), a hot restore trusts
        // the persisted grants; re-check that they still cover every configured
        // collection so a partially-covered grant set raises the reconnect
        // banner proactively rather than waiting for a per-collection 403.
        const uncovered = config.collections.filter(
          collection => parsed.byCollectionId[collection.id] === undefined
        )
        await activateConnected({
          seed: restored.seed,
          identity,
          parsed,
          grants: restored.grants,
          expires: restored.expires
        })
        set({
          status: uncovered.length > 0 ? 'reconnect' : 'connected',
          controllerDid: identity.controllerDid,
          expires: restored.expires,
          error: null,
          accessExpired: uncovered.length > 0
        })
      } catch (err) {
        console.warn('Session boot failed:', err)
        // `activateConnected` already re-opens local on its own failure; only
        // open local here for an earlier failure that never reached it.
        if (get().status === 'boot') {
          try {
            await openLocal()
          } catch (localErr) {
            // Even the anonymous local replica could not be opened: a genuine
            // storage failure, the only case that leaves `status` at `boot`
            // with an `error`. Surfacing it here (rather than a login/reconnect
            // failure, which only ever sets `error` after `status` has left
            // `boot`) is what lets `ProtectedRoute` scope its fatal alert to
            // boot/storage failures alone.
            set({ error: errorMessage(localErr) })
          }
        }
      }
    },

    login: async () => {
      if (get().authenticating || get().status === 'connected') {
        return
      }
      set({ authenticating: true, error: null, phase: 'probing' })
      try {
        const outcome = await loginWithWallet({
          config: loginConfig,
          onPhase: phase => set({ phase })
        })
        // The wallet succeeded: only now tear down the anonymous replica (a
        // cancel above leaves `local` intact).
        await adoptLocalIntoConnected()
        await activateConnected({
          seed: outcome.seed,
          identity: outcome.identity,
          parsed: outcome.parsed,
          grants: outcome.grants,
          expires: outcome.expires
        })
        set({
          status: 'connected',
          authenticating: false,
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
        set({ authenticating: false, phase: null, error: message })
      }
    },

    connectWithGrants: async ({ seed, grants }) => {
      const identity = await initAppSession({ seed })
      const parsed = parseGrants(grants)
      const expires =
        earliestExpiry(grants) ??
        new Date(Date.now() + FAR_FUTURE_EXPIRY_MS).toISOString()
      await deactivateStore()
      await activateConnected({ seed, identity, parsed, grants, expires })
      set({
        status: 'connected',
        controllerDid: identity.controllerDid,
        expires,
        error: null,
        accessExpired: false
      })
    },

    reconnect: async () => {
      const { reconnecting, status } = get()
      if (reconnecting || status !== 'reconnect') {
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
          status: 'connected',
          accessExpired: false,
          expires: checked.expires,
          reconnecting: false
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Reconnect failed.'
        set({ reconnecting: false, error: message })
      }
    },

    logout: async ({ wipe = false } = {}) => {
      await resetToFreshLocal({ deleteDb: wipe })
      await clearAppSession({ store: sessionStore })
      // `resetToFreshLocal` already landed `local` (fresh anon replica); clear
      // the remaining transients.
      set({ phase: null, reconnecting: false })
    },

    clearLocalData: async () => {
      await resetToFreshLocal({ deleteDb: true, discardAnonSeed: true })
      set({ phase: null, reconnecting: false })
    },

    notifyAccessExpired: () => {
      if (get().status === 'connected') {
        set({ status: 'reconnect', accessExpired: true })
      }
    },

    destroy: async () => {
      await deactivateStore()
      // Back to `boot` (not `local`) and both persisted seeds left intact: a
      // StrictMode remount's `boot()` re-opens the same session (or local).
      set({
        status: 'boot',
        authenticating: false,
        phase: null,
        error: null,
        controllerDid: null,
        expires: null,
        accessExpired: false,
        reconnecting: false
      })
    }
  }))

  return store
}
