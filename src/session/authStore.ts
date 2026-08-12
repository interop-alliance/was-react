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
 * connected replica under the wallet-derived seed. By default it ADOPTS the
 * anonymous replica's data first (`adopt: 'merge'`): the replica is detached,
 * its decrypted payloads are collected through a fresh handle re-derived from
 * the persisted seed, LWW-merged into the connected replica before its
 * first hydrate/sync (so they reach the server as ordinary creates), and the
 * anonymous seed + database are deleted once the activation lands. `adopt:
 * 'leave'` sets the anonymous replica aside untouched instead (it returns after
 * a logout). Logout returns to a fresh `local` (optionally wiping the connected
 * replica); `clearLocalData` mints a brand-new anonymous seed and replica and
 * drops any persisted connected session.
 *
 * The library cannot bind a module-level store to app config, so this is a
 * FACTORY: {@link createAuthStore} captures the app's {@link WasAppConfig} and
 * {@link StoreRegistry} once (the React provider calls it once) and returns a
 * vanilla zustand store the hooks consume through context.
 */
import { createStore, type StoreApi } from 'zustand/vanilla'
import type { RxStorage } from 'rxdb/plugins/core'
import type { IZcap } from '@interop/data-integrity-core'
import type { CollectionEncryption } from '@interop/was-client'
import { acquireDescriptors } from '@interop/wallet-core/descriptors'
import { mintRecordEncryption } from '@interop/wallet-core/keyring'
import {
  DEFAULT_DB_NAME,
  DEFAULT_EXPIRY_WARNING_MS,
  DEFAULT_EXPIRY_WATCH_MS,
  DEFAULT_ONBOARDING,
  type StoreRegistry,
  type WasAppConfig
} from '../config.js'
import type { SharedCollectionReader } from '../storage/sharedCollectionReader.js'
import { createDocumentLoader } from '../identity/documentLoader.js'
import { deriveIdentity, type IdentityAgents } from '../identity/agents.js'
import {
  createDescriptorCache,
  createSeedStore,
  type SeedStore
} from '../identity/seedStore.js'
import {
  clearAppSession,
  peekAppSession,
  persistAppSession,
  restoreAppSession,
  isNearExpiry,
  earliestExpiry,
  NO_EXPIRY_MS
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
  clearRemoteStore,
  getWriterId,
  hasStore,
  requireStore,
  setLocalStore,
  setRemoteStore
} from '../storage/storageManager.js'
import {
  cancelScheduledRehydrates,
  clearAllEntityStores,
  hydrateAll,
  patchFromChange
} from '../storage/rehydrate.js'
import { mergeAdopted } from '../storage/adopt.js'
import { readRemoteDescriptors, startWasSync } from '../storage/wasSync.js'
import { errorMessage } from '../sync/index.js'
import { SyncController } from '../storage/syncController.js'
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

/**
 * What adoption carries from the anonymous replica into the connected one: the
 * decrypted payloads per collection key, plus the anonymous controller DID
 * (whose per-controller database is deleted once the merge lands).
 */
interface AdoptSource {
  controllerDid: string
  entities: Record<string, Array<{ id: string }>>
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
   * The per-install LWW attribution id, resolved once at store creation from
   * `WasAppConfig.storageKeyPrefix`. Stamp it (with a fresh `updatedAt`) onto
   * every entity insert and update; the adoption repair uses the same value,
   * so one install writes under one identity.
   */
  writerId: string
  /**
   * The current login phase, for the login page's progress line, and the single
   * source of truth for "a Login With Wallet flow is in flight" (non-`null`
   * throughout the flow; the `status` stays `local` meanwhile). `useSession` /
   * `useLogin` expose the boolean as `authenticating`, computed from this.
   */
  phase: LoginPhase | null
  error: string | null
  controllerDid: string | null
  /**
   * ISO expiry of the current grant set (earliest zcap expiry); `null` in
   * `local` (no grants).
   */
  expires: string | null
  reconnecting: boolean
  /**
   * The read-only readers over the wallet-owned collections the wallet shared
   * with this app, keyed by the `sharedCollections` config `key`. Populated once
   * replication bootstraps; empty in `local`, and cleared on logout / teardown.
   * A shared collection the wallet declined to grant (or that this app is not a
   * recipient of) is simply absent -- never a session failure.
   */
  sharedCollections: Record<string, SharedCollectionReader>
  /**
   * Attempt a zero-popup hot restore; a restore hit lands `connected`, any
   * miss/error falls to `local` (a fresh anonymous replica), never a dead login
   * screen. No-op once the status has left `boot`.
   */
  boot: () => Promise<void>
  /**
   * Full Login With Wallet (first-run or returning). On success tears down the
   * anonymous replica and opens the connected one. `adopt` decides what happens
   * to data created in `local` before this login: `'merge'` (the default)
   * LWW-merges it into the connected replica and then deletes the anonymous
   * seed + database; `'leave'` sets the anonymous replica aside untouched (it
   * returns after a logout). A cancel or failure leaves `local` intact either
   * way.
   *
   * Resolves with `{ firstRun }` on success (`firstRun` is true when this login
   * created a brand-new app key, so the app can show a "connected for the first
   * time" confirmation). Resolves with `null` when the user cancels a wallet
   * popup (not an error). REJECTS on any genuine failure, after recording the
   * message in `error` so the UI state still reflects it.
   *
   * @param [options] {object}
   * @param [options.adopt] {'merge' | 'leave'}
   * @returns {Promise<{ firstRun: boolean } | null>}
   */
  login: (options?: {
    adopt?: 'merge' | 'leave'
  }) => Promise<{ firstRun: boolean } | null>
  /**
   * Non-CHAPI connect from an explicit seed + grants (dev/test and provisioned
   * grants). Tears down the current replica and opens the connected one, with
   * the same `adopt` choice (and `'merge'` default) as `login`, so this path
   * exercises adoption exactly as a wallet login does.
   *
   * @param options {object}
   * @param options.seed {Uint8Array}
   * @param options.grants {IZcap[]}
   * @param [options.adopt] {'merge' | 'leave'}
   * @returns {Promise<void>}
   */
  connectWithGrants: (options: {
    seed: Uint8Array
    grants: IZcap[]
    adopt?: 'merge' | 'leave'
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
   * anonymous seed/DID + replica. Also clears any persisted connected session,
   * so clearing while connected fully disconnects (a later boot lands `local`
   * instead of silently reconnecting and syncing the data back down). The
   * reset primitive behind the "Clear data" button.
   */
  clearLocalData: () => Promise<void>
  /**
   * Whether the anonymous `local` replica currently holds any documents -- the
   * check a login screen runs to decide whether to offer the adoption choice
   * before `login()`. Always false outside `local`.
   */
  hasLocalData: () => Promise<boolean>
  notifyAccessExpired: () => void
  /**
   * Tears down the live replica (expiry watch, controller, local store) WITHOUT
   * wiping the persisted session record, and returns to `boot` so a fresh
   * `boot()` can re-open it. Called from the provider's unmount cleanup so an
   * unmount (or a React dev-mode remount) never orphans the replication loop or
   * the expiry-watch interval. Serialized with `boot` so a destroy fired while a
   * boot is still in flight tears down only once that boot has fully settled,
   * and a boot queued after it re-opens cleanly.
   */
  destroy: () => Promise<void>
}

/**
 * The vanilla zustand store returned by {@link createAuthStore}.
 */
export type WasAuthStore = StoreApi<AuthState>

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
  // Resolve the per-install LWW writer id ONCE, honoring the configured
  // localStorage prefix, so every stamp -- the app's own writes and the
  // adoption repair -- carries the same attribution identity.
  const writerId = getWriterId({
    ...(config.storageKeyPrefix !== undefined && {
      storageKeyPrefix: config.storageKeyPrefix
    })
  })
  const sessionStore =
    seedStore ?? createSeedStore({ dbName: `${dbName}-session` })
  // The offline encryption-descriptor cache, presented as the seam
  // `@interop/wallet-core/descriptors` acquires through. Reads serve the
  // connected replica's epoch-aware open (cache-only, no network); writes land
  // the descriptors the sync bootstrap fetched. Bound per controller DID at
  // each use: a login under a different controller than the one that cached
  // the descriptors reads the cache as empty rather than building ciphers the
  // new identity is no epoch recipient of.
  function sessionDescriptorCache(controllerDid: string) {
    return createDescriptorCache({
      store: sessionStore,
      controller: controllerDid
    })
  }
  // The anonymous-seed persistence for `local` mode: only a raw 32-byte seed,
  // no session record, in its own IndexedDB so it never collides with the
  // wallet session or a connected replica.
  const anonStore = createSeedStore({ dbName: `${dbName}-anon` })
  const documentLoader = createDocumentLoader()

  // The login flow consumes only the WAS collection ids + visibility; this
  // config layer owns the `{ key, id }` registry.
  const loginConfig: LoginConfig = {
    appOrigin: config.appOrigin,
    appName: config.appName,
    collections: config.collections.map(collection => ({
      id: collection.id,
      ...(collection.visibility !== undefined && {
        visibility: collection.visibility
      })
    })),
    appUrl: config.appUrl,
    ...(config.sharedCollections && {
      sharedCollections: config.sharedCollections.map(entry => entry.id)
    }),
    documentLoader,
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
  let expiryInitialCheck: ReturnType<typeof setTimeout> | undefined
  // The per-session controller: single-use, stopped on logout and replaced on a
  // reconnect (started once per grant set).
  let controller: SyncController | null = null
  // The in-flight `beginSync` promise (controller.start() awaits network round
  // trips first). Awaited before teardown so a logout racing the bootstrap
  // cannot stop the controller before it has finished starting.
  let pendingSync: Promise<unknown> | null = null

  // Serializes the boot/destroy lifecycle so their multi-await bring-up and
  // teardown never overlap. A fast unmount/remount of the session provider
  // (React dev-mode double effects) fires boot -> destroy -> boot in quick
  // succession; run unserialized, the first boot's continuations (open,
  // hydrate, start sync) race the destroy's teardown -- installing a
  // closed/duplicate replica as the process-wide holder, hydrating against a
  // torn-down store, or leaking an interval/controller behind the losing boot.
  // Chaining every boot/destroy through this promise makes each run to
  // completion before the next begins: destroy always tears down a fully-open
  // session, and a queued boot re-opens cleanly on top of it. Neither routine
  // awaits user interaction (boot starts replication in the background, never
  // blocking on it), so the chain cannot deadlock. `connectWithGrants` rides
  // the same chain (fired from mount-time effects, it IS part of this race --
  // see its comment), and so do `logout` and `clearLocalData` -- user-driven,
  // but they tear down and re-open the process-wide holder, so overlapping an
  // in-flight boot's bring-up would race two open/teardown sequences (see the
  // comment at `logout`). `login` and `reconnect` stay off it: they are
  // guarded by their own flags, and both await the CHAPI popup -- chaining
  // them would hold boots and destroys hostage to user interaction.
  let lifecycle: Promise<void> = Promise.resolve()
  function serializeLifecycle(task: () => Promise<void>): Promise<void> {
    const run = lifecycle.then(task, task)
    lifecycle = run.then(
      () => {},
      () => {}
    )
    return run
  }

  /**
   * Stops the near-expiry watch (logout / re-grant).
   */
  function disarmExpiryWatch(): void {
    if (expiryTimer) {
      clearInterval(expiryTimer)
      expiryTimer = undefined
    }
    if (expiryInitialCheck) {
      clearTimeout(expiryInitialCheck)
      expiryInitialCheck = undefined
    }
  }

  /**
   * Watches the session's earliest grant expiry and raises the reconnect banner
   * once it is within `warningMs` (or already past). The first check is
   * DEFERRED a macrotask rather than run synchronously: every caller awaits
   * `persistAndStartSync` (which arms this watch) BEFORE writing
   * `status: 'connected'`, so a synchronous check
   * would always be swallowed by `notifyAccessExpired`'s connected gate and
   * then actively cleared -- leaving a restored near-expiry session without
   * its proactive banner until the first `watchMs` tick. Deferring runs the
   * check after the caller's continuation has set the status. Then checks on a
   * coarse interval; re-armed with the fresh expiry after a reconnect.
   */
  function armExpiryWatch(expires: string): void {
    disarmExpiryWatch()
    const check = () => {
      if (isNearExpiry(expires, warningMs)) {
        store.getState().notifyAccessExpired()
      }
    }
    expiryInitialCheck = setTimeout(check, 0)
    expiryTimer = setInterval(check, watchMs)
  }

  /**
   * Starts a fresh per-session controller replicating the granted collections,
   * wiring reactive per-doc store patching and the auth-error (401/403) signal.
   * The bootstrapped remote store is installed as the process-wide holder so
   * entity-store verbs that need the server (e.g. `query`) can reach it;
   * `stopController` clears it.
   */
  async function beginSync({
    parsed,
    identity
  }: {
    parsed: ParsedGrants
    identity: IdentityAgents
  }): Promise<unknown> {
    const { controllerDid, zcapClient, keyAgreementKey, keyResolver } = identity
    controller = new SyncController({
      collections: config.collections,
      ...(config.sync && { sync: config.sync })
    })
    const { remoteStore, sharedCollections } = await startWasSync({
      parsed,
      zcapClient,
      collections: config.collections,
      localStore: requireStore(),
      syncController: controller,
      onRemoteChange: (key, event) =>
        void patchFromChange(registry, key, event),
      ...(config.sharedCollections && {
        sharedCollections: config.sharedCollections
      }),
      identityKeys: { keyAgreementKey, keyResolver },
      onAuthError: () => store.getState().notifyAccessExpired(),
      onDescriptorsFetched: descriptors =>
        void cacheDescriptors({ descriptors, controllerDid }).catch(err =>
          console.warn('Failed to cache encryption descriptors:', err)
        )
    })
    setRemoteStore(remoteStore)
    store.setState({ sharedCollections })
    return remoteStore
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
    pendingSync = beginSync({ parsed, identity })
    // A failed bootstrap must not resolve silently: surface it on the session
    // `error` (the sync rollup shows the per-collection error statuses the
    // controller leaves behind). The session stays usable -- local-first --
    // but the UI no longer reports "Local only" over a wallet-connected
    // session that simply failed to start replicating.
    void pendingSync.catch(err => {
      console.warn('WAS sync failed to start:', err)
      // Deferred a macrotask: an immediate bootstrap failure would otherwise
      // race the caller's own `set({ ..., error: null })` (which lands right
      // after `persistAndStartSync` resolves) and be wiped by it.
      setTimeout(
        () =>
          store.setState({
            error: `Sync failed to start: ${errorMessage(err)}`
          }),
        0
      )
    })
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
    // The remote store belongs to the session that just stopped (a reconnect
    // re-grant installs a fresh one via `beginSync`). The shared-collection
    // readers hold that same store and its delegated zcaps, so they go with it.
    clearRemoteStore()
    store.setState({ sharedCollections: {} })
  }

  /**
   * Opens the encrypted replica under `identity` (its identity KAK encrypts
   * every private collection; its controller DID names the database), installs
   * it as the process-wide store, and hydrates every entity store.
   * Shared by `openLocal` and the connected activation. When `adopt` is given
   * (a connected activation following a merge login), the collected anonymous
   * payloads are LWW-merged in BEFORE the hydrate -- and before sync starts --
   * so the entity stores and the first push both see them as ordinary rows.
   *
   * @param options {object}
   * @param options.identity {IdentityAgents}
   * @param [options.adopt] {AdoptSource}
   * @param [options.descriptors] {Record<string, CollectionEncryption>}   cached
   *   encryption descriptors, so a connected (incl. offline hot-restore) or
   *   anonymous replica opens epoch-aware before any live description read
   * @returns {Promise<void>}
   */
  async function openAndHydrate({
    identity,
    adopt,
    descriptors
  }: {
    identity: IdentityAgents
    adopt?: AdoptSource
    descriptors?: Record<string, CollectionEncryption>
  }): Promise<void> {
    const local = await LocalStore.init({
      keyAgreementKey: identity.keyAgreementKey,
      keyResolver: identity.keyResolver,
      collections: config.collections,
      ...(config.sharedCollections && {
        sharedCollections: config.sharedCollections
      }),
      dbName: dbNameForController({
        dbName,
        controllerDid: identity.controllerDid
      }),
      ...(descriptors && { descriptors }),
      ...(storage && { storage })
    })
    setLocalStore(local)
    if (adopt) {
      await mergeAdopted({ store: local, entities: adopt.entities, writerId })
    }
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
   * Loads -- or on first use mints and persists -- the anonymous replica's
   * per-collection encryption descriptors. Epoch-from-birth applies locally
   * too: a private collection's cipher only exists from an epoch-bearing
   * descriptor, and with no wallet to provision one the app mints it at the
   * collection's local birth -- a one-epoch roster sealed to the anonymous
   * identity's KAK alone (the same record-own-epoch construction wallet-core
   * uses for its own locally stored records). Persisted so a reload decrypts
   * the rows the previous session sealed.
   *
   * @param identity {IdentityAgents}   the anonymous identity
   * @returns {Promise<Record<string, CollectionEncryption>>}
   */
  async function loadOrMintAnonDescriptors(
    identity: IdentityAgents
  ): Promise<Record<string, CollectionEncryption>> {
    // The anonymous replica's descriptor cache, persisted alongside the anon
    // seed (and wiped with it). Kept apart from the connected session's cache
    // and bound to the anon controller: the two identities' epochs must never
    // cross.
    const cache = createDescriptorCache({
      store: anonStore,
      controller: identity.controllerDid
    })
    const descriptors: Record<string, CollectionEncryption> = {}
    for (const { id, visibility } of config.collections) {
      if (visibility === 'public') {
        continue
      }
      let descriptor = await cache.readDescriptor({ collectionId: id })
      if (!descriptor) {
        descriptor = await mintRecordEncryption({
          keyAgreementKey: identity.keyAgreementKey
        })
        await cache.writeDescriptor({ collectionId: id, descriptor })
      }
      descriptors[id] = descriptor
    }
    return descriptors
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
    const identity = await deriveIdentity({ seed })
    await openAndHydrate({
      identity,
      descriptors: await loadOrMintAnonDescriptors(identity)
    })
    if (created && config.seedLocal) {
      await config.seedLocal()
    }
    store.setState({
      status: 'local',
      controllerDid: identity.controllerDid,
      expires: null,
      error: null
    })
  }

  /**
   * Opens the connected replica under the session seed, hydrates, persists the
   * session, and starts sync. On any failure the store is torn back down and the
   * anonymous local replica re-opened (so the app never dead-ends), then the
   * error is surfaced and rethrown for the caller to finalize.
   *
   * @param session {object}   the session to open: its seed, identity, parsed
   *   grants and expiry, plus the payloads to adopt (merge logins only)
   * @returns {Promise<void>}
   */
  /**
   * Loads the cached encryption descriptors for the registered collections
   * (keyed by WAS collection id), or `undefined` when none are cached.
   *
   * Acquired CACHE-ONLY -- `acquireDescriptors` with no `source` -- because
   * this runs before any remote store exists and must not touch the network:
   * the whole point is that an offline hot restore opens epoch-aware. The
   * connected session refreshes them from the server once sync bootstraps.
   * Best-effort: on a read failure the private collections open fail-closed
   * until the sync bootstrap supplies live descriptors.
   */
  async function loadCachedDescriptors({
    controllerDid
  }: {
    controllerDid: string
  }): Promise<Record<string, CollectionEncryption> | undefined> {
    try {
      const descriptors = await acquireDescriptors({
        cache: sessionDescriptorCache(controllerDid),
        collectionIds: config.collections.map(collection => collection.id)
      })
      return Object.keys(descriptors).length > 0 ? descriptors : undefined
    } catch (err) {
      console.warn('Failed to load cached encryption descriptors:', err)
      return undefined
    }
  }

  /**
   * Writes the descriptors the sync bootstrap fetched into the offline cache,
   * through the same seam {@link loadCachedDescriptors} reads.
   *
   * @param options {object}
   * @param options.descriptors {Record<string, CollectionEncryption>}
   * @param options.controllerDid {string}   the identity the descriptors were
   *   fetched for (the cache stamp)
   * @returns {Promise<void>}
   */
  async function cacheDescriptors({
    descriptors,
    controllerDid
  }: {
    descriptors: Record<string, CollectionEncryption>
    controllerDid: string
  }): Promise<void> {
    const cache = sessionDescriptorCache(controllerDid)
    await Promise.all(
      Object.entries(descriptors).map(([collectionId, descriptor]) =>
        cache.writeDescriptor({ collectionId, descriptor })
      )
    )
  }

  /**
   * Completes the cached descriptor set with live reads for any granted
   * private collection the cache does not cover. A first login has no cache at
   * all, and the connected replica must open epoch-aware BEFORE sync starts:
   * the adoption merge writes into it right after open, and epoch-from-birth
   * leaves no single-key fallback to write under. Best-effort: a failed read
   * leaves those collections fail-closed until the sync bootstrap's own
   * descriptor read lands. Freshly fetched descriptors enter the offline cache
   * immediately.
   *
   * @param options {object}
   * @param [options.cached] {Record<string, CollectionEncryption>}
   * @param options.identity {IdentityAgents}
   * @param options.parsed {ParsedGrants}
   * @returns {Promise<Record<string, CollectionEncryption> | undefined>}
   */
  async function completeDescriptors({
    cached,
    identity,
    parsed
  }: {
    cached?: Record<string, CollectionEncryption>
    identity: IdentityAgents
    parsed: ParsedGrants
  }): Promise<Record<string, CollectionEncryption> | undefined> {
    const missing = config.collections.filter(
      ({ id, visibility }) =>
        visibility !== 'public' &&
        parsed.byCollectionId[id] !== undefined &&
        !cached?.[id]
    )
    if (missing.length === 0) {
      return cached
    }
    try {
      const fetched = await readRemoteDescriptors({
        parsed,
        zcapClient: identity.zcapClient,
        collections: missing
      })
      if (Object.keys(fetched).length > 0) {
        await cacheDescriptors({
          descriptors: fetched,
          controllerDid: identity.controllerDid
        })
        return { ...fetched, ...cached }
      }
    } catch (err) {
      console.warn('Failed to read encryption descriptors at login:', err)
    }
    return cached
  }

  async function activateConnected(session: {
    seed: Uint8Array
    identity: IdentityAgents
    parsed: ParsedGrants
    grants: IZcap[]
    expires: string
    adopt?: AdoptSource
  }): Promise<void> {
    try {
      // Load the cached encryption descriptors so the connected replica opens
      // epoch-aware: an offline hot restore then decrypts multi-recipient
      // envelopes with no live description read, while a first login (no cache
      // yet) completes the set with live reads before the replica opens.
      const descriptors = await completeDescriptors({
        cached: await loadCachedDescriptors({
          controllerDid: session.identity.controllerDid
        }),
        identity: session.identity,
        parsed: session.parsed
      })
      await openAndHydrate({
        identity: session.identity,
        ...(session.adopt && { adopt: session.adopt }),
        ...(descriptors && { descriptors })
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
   * the database by default; `deleteDb` deletes it instead (the wipe paths, via
   * {@link resetToFreshLocal}).
   *
   * @param [options] {object}
   * @param [options.deleteDb] {boolean}   delete the database rather than
   *   closing it
   * @returns {Promise<void>}
   */
  async function deactivateStore({
    deleteDb = false
  }: { deleteDb?: boolean } = {}): Promise<void> {
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
    await deactivateStore({ deleteDb })
    if (discardAnonSeed) {
      await anonStore.clearSeedStore()
    }
    await openLocal()
  }

  /**
   * Reads every decrypted payload out of the anonymous replica (adoption is a
   * copy: the anonymous and connected replicas derive their ciphers from
   * different seeds, so envelopes cannot move across). Returns null when there
   * is nothing to adopt -- not in `local`, or every collection empty -- in
   * which case the anonymous database is simply left in place, exactly as an
   * `adopt: 'leave'` login leaves it.
   *
   * Reads through a FRESH handle on the anonymous database (re-derived from
   * the persisted anonymous seed), not the process-wide holder -- the holder
   * has already been torn down by {@link detachAndCollect} (and even before
   * that ordering existed, a provider unmount firing `destroy` mid-login could
   * close the holder out from under this read; `login`/`connectWithGrants`
   * are OFF the serialized boot/destroy lifecycle chain). Re-deriving from the
   * seed keeps the collect independent of the holder's lifecycle.
   *
   * Decides off the caller's PRE-FLOW snapshot of `{ status, controllerDid }`,
   * never the live state: a provider unmount (a route change or StrictMode
   * remount) firing `destroy` while the CHAPI popup is open resets the live
   * status to `boot`, and reading it here would silently collect nothing --
   * an `adopt: 'merge'` login would then resolve successfully while the
   * user's pre-login data never reaches their Web Space.
   *
   * @param snapshot {object}   the caller's state snapshot from before its
   *   first await
   * @returns {Promise<AdoptSource | null>}
   */
  async function collectAdoptable(snapshot: {
    status: SessionStatus
    controllerDid: string | null
  }): Promise<AdoptSource | null> {
    const { status, controllerDid } = snapshot
    if (status !== 'local' || controllerDid === null) {
      return null
    }
    const seed = await anonStore.loadSeed()
    if (!seed) {
      return null
    }
    const identity = await deriveIdentity({ seed })
    const anonLocal = await LocalStore.init({
      keyAgreementKey: identity.keyAgreementKey,
      keyResolver: identity.keyResolver,
      collections: config.collections,
      dbName: dbNameForController({ dbName, controllerDid }),
      descriptors: await loadOrMintAnonDescriptors(identity),
      ...(storage && { storage })
    })
    try {
      // Read every collection at once: the replica is detached for the whole
      // read, so the transition is as short as the slowest collection rather
      // than the sum of them all.
      const listed = await Promise.all(
        config.collections.map(async ({ key }) => ({
          key,
          payloads: await anonLocal.listEntities(key)
        }))
      )
      const entities: AdoptSource['entities'] = {}
      let total = 0
      for (const { key, payloads } of listed) {
        if (payloads.length > 0) {
          entities[key] = payloads
          total += payloads.length
        }
      }
      return total > 0 ? { controllerDid, entities } : null
    } finally {
      await anonLocal.close()
    }
  }

  /**
   * The connect-transition prologue shared by `login` and `connectWithGrants`:
   * tears the anonymous holder down FIRST and only then reads the adoptable
   * payloads (merge only) through the fresh handle `collectAdoptable` opens.
   * The ordering is load-bearing: the holder and the collect handle each open
   * every configured collection, so holding both at once doubles the open-
   * collection count and trips RxDB's process-wide open-collections cap for
   * apps with many collections (COL23). Detaching first keeps at most one
   * replica's collections open at any moment during the transition.
   *
   * After the holder is gone a collect failure would otherwise strand the
   * session with no open store, so it re-opens the anonymous replica (nothing
   * has been adopted yet; `local` survives intact) and rethrows.
   *
   * @param adopt {'merge' | 'leave'}
   * @param snapshot {object}   the caller's pre-flow `{ status, controllerDid }`
   *   snapshot (see {@link collectAdoptable})
   * @returns {Promise<AdoptSource | null>}
   */
  async function detachAndCollect(
    adopt: 'merge' | 'leave',
    snapshot: { status: SessionStatus; controllerDid: string | null }
  ): Promise<AdoptSource | null> {
    await deactivateStore()
    if (adopt !== 'merge') {
      return null
    }
    try {
      return await collectAdoptable(snapshot)
    } catch (err) {
      await openLocal()
      throw err
    }
  }

  /**
   * Deletes the adopted anonymous replica -- its persisted seed and its
   * per-controller database -- so the data lives on only in the connected
   * replica and a later logout lands in a genuinely fresh `local`. Called only
   * after the connected activation has landed (status written); any earlier
   * failure leaves the anonymous replica intact for the fallback to re-open.
   *
   * Best-effort: a deletion failure (an anonymous Dexie database still open in
   * another tab, an IndexedDB quota error) is logged and swallowed. The
   * connected session is already live and syncing at this point, so failing
   * the login over its cleanup would report `local` over a genuinely connected
   * session; at worst a stale anonymous replica lingers and its (already
   * merged) payloads are re-collected by a later login's idempotent LWW merge.
   *
   * @param controllerDid {string}   the anonymous controller DID
   * @returns {Promise<void>}
   */
  async function discardAnonReplica(controllerDid: string): Promise<void> {
    try {
      await anonStore.clearSeedStore()
      await LocalStore.removeDatabase({
        dbName: dbNameForController({ dbName, controllerDid }),
        ...(storage && { storage })
      })
    } catch (err) {
      console.warn('Failed to delete the adopted anonymous replica:', err)
    }
  }

  // Declared last so `prefer-const` is satisfied; the lifecycle closures above
  // only dereference `store` at call time, by which point it is assigned.
  const store: WasAuthStore = createStore<AuthState>()((set, get) => {
    const bootImpl = async (): Promise<void> => {
      if (get().status !== 'boot') {
        return
      }
      try {
        const restored = await restoreAppSession({ store: sessionStore })
        if (!restored) {
          await openLocal()
          return
        }
        const identity = await deriveIdentity({ seed: restored.seed })
        if (identity.controllerDid !== restored.controllerDid) {
          // A corrupt record; treat as logged out and fall to local.
          await clearAppSession({ store: sessionStore })
          await openLocal()
          return
        }
        const parsed = parseGrants(restored.grants)
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
          error: null
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
    }

    const destroyImpl = async (): Promise<void> => {
      await deactivateStore()
      // Back to `boot` (not `local`) and both persisted seeds left intact: a
      // remount's `boot()` re-opens the same session (or local). Serialized with
      // `boot` (see `serializeLifecycle`), so this teardown always runs against a
      // fully-open session, never an in-flight one.
      set({
        status: 'boot',
        phase: null,
        error: null,
        controllerDid: null,
        expires: null,
        reconnecting: false,
        sharedCollections: {}
      })
    }

    return {
      status: 'boot',
      onboarding,
      writerId,
      phase: null,
      error: null,
      controllerDid: null,
      expires: null,
      reconnecting: false,
      sharedCollections: {},

      boot: () => serializeLifecycle(bootImpl),

      login: async ({ adopt = 'merge' } = {}) => {
        if (get().phase !== null || get().status === 'connected') {
          return null
        }
        // Snapshot the pre-login state BEFORE the popup await: a provider
        // unmount (`destroy`) landing while CHAPI is open resets the live
        // status to `boot`, and the adoption collect must still see the
        // `local` session this login left.
        const preLogin = {
          status: get().status,
          controllerDid: get().controllerDid
        }
        set({ error: null, phase: 'connecting' })
        try {
          const outcome = await loginWithWallet({
            config: loginConfig,
            onPhase: phase => set({ phase })
          })
          // The wallet succeeded: tear the anonymous holder down and collect
          // its payloads (merge only) -- a cancel above leaves `local` intact.
          // The anonymous seed and database are deleted only after the
          // activation lands, so a failure below still falls back to an intact
          // `local`.
          const source = await detachAndCollect(adopt, preLogin)
          await activateConnected({
            seed: outcome.seed,
            identity: outcome.identity,
            parsed: outcome.parsed,
            grants: outcome.grants,
            expires: outcome.expires,
            ...(source && { adopt: source })
          })
          set({
            status: 'connected',
            controllerDid: outcome.identity.controllerDid,
            expires: outcome.expires,
            phase: null,
            error: null
          })
          // Adopted-replica cleanup runs AFTER the connected status lands (and
          // is best-effort): a cleanup failure must not leave the session
          // reporting `local` over a live, syncing connected session.
          if (source) {
            await discardAnonReplica(source.controllerDid)
          }
          return { firstRun: outcome.firstRun }
        } catch (err) {
          // A cancel is not a failure: clear the in-flight flags without leaving a
          // scary error, and resolve with `null` so the caller can distinguish it
          // from a connected outcome. `local` stays intact.
          if (err instanceof LoginCancelledError) {
            set({ phase: null, error: null })
            return null
          }
          // A genuine failure: record the message so the UI state still reflects
          // it, then rethrow so the caller's promise rejects.
          const message = `Login failed: ${errorMessage(err)}`
          set({ phase: null, error: message })
          throw err
        }
      },

      connectWithGrants: async ({ seed, grants, adopt = 'merge' }) => {
        // Serialized with boot/destroy, unlike `login`: connectWithGrants is
        // typically fired from an effect at mount, exactly when a dev-mode
        // remount's queued destroy/boot pair is still draining the lifecycle
        // chain. Run off the chain, that pair tears down and re-opens the
        // anonymous replica UNDERNEATH the in-flight connect, and the adoption
        // collect races it -- nondeterministically dropping the local data the
        // merge was meant to carry over. Nothing here awaits user interaction
        // (the grants are already in hand), so the chain cannot deadlock;
        // `login` stays off it because it blocks on a wallet popup that must
        // not stall a queued destroy, and being user-driven it never runs as
        // part of the mount race. The connected guard makes a double-fired
        // connect (dev-mode double effects again) a no-op instead of a
        // re-activation.
        await serializeLifecycle(async () => {
          if (get().status === 'connected') {
            return
          }
          const preConnect = {
            status: get().status,
            controllerDid: get().controllerDid
          }
          const identity = await deriveIdentity({ seed })
          const parsed = parseGrants(grants)
          const expires =
            earliestExpiry(grants) ??
            new Date(Date.now() + NO_EXPIRY_MS).toISOString()
          const source = await detachAndCollect(adopt, preConnect)
          await activateConnected({
            seed,
            identity,
            parsed,
            grants,
            expires,
            ...(source && { adopt: source })
          })
          set({
            status: 'connected',
            controllerDid: identity.controllerDid,
            expires,
            error: null
          })
          // After the status lands, and best-effort (see `discardAnonReplica`).
          if (source) {
            await discardAnonReplica(source.controllerDid)
          }
        })
      },

      reconnect: async () => {
        const { reconnecting, status } = get()
        if (reconnecting || status !== 'reconnect') {
          return
        }
        set({ reconnecting: true, error: null })
        try {
          // The seed survives grant expiry; only the grants need renewing, and
          // the record carries the storage location the continuity check below
          // compares against. Peeked (not `restoreAppSession`, which WIPES an
          // expired record -- seed included -- exactly in the case reconnect
          // exists for), and read before the popup so the comparison baseline
          // cannot be overwritten mid-flow. A missing seed means the session is
          // unrecoverable in place.
          const { seed, record } = await peekAppSession({ store: sessionStore })
          if (!seed) {
            await get().logout()
            return
          }
          const identity = await deriveIdentity({ seed })
          const checked = await requestGrants({ identity, config: loginConfig })
          // Continuity check: `parseGrants` only asserts the returned set is
          // INTERNALLY consistent. Without this comparison, a reconnect
          // returning internally-consistent grants for a DIFFERENT server or
          // space would silently re-point the whole encrypted replica (whose
          // database name derives from the controller DID alone) at a new
          // storage location the user never chose. Refuse instead; switching
          // storage is a logout + fresh login, an explicit user action.
          if (
            record !== null &&
            (checked.parsed.serverUrl !== record.serverUrl ||
              checked.parsed.spaceId !== record.spaceId)
          ) {
            throw new Error(
              `The renewed grants point at a different storage location ` +
                `("${checked.parsed.serverUrl}", space ` +
                `"${checked.parsed.spaceId}") than this session's ` +
                `("${record.serverUrl}", space "${record.spaceId}"). ` +
                `Refusing to re-point the session; log out and log in again ` +
                `to switch storage.`
            )
          }
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
            expires: checked.expires,
            reconnecting: false
          })
        } catch (err) {
          set({ reconnecting: false, error: errorMessage(err) })
        }
      },

      // Serialized with boot/destroy: a logout clicked during the StrictMode
      // remount churn after a reload (boot -> destroy -> boot, each a
      // multi-await bring-up/teardown) would otherwise tear the store down and
      // re-open the anonymous replica CONCURRENTLY with the queued boot's hot
      // restore -- two overlapping open/teardown sequences on the process-wide
      // holder, which can deadlock the re-open. Queued behind the chain, the
      // in-flight boot completes first and logout tears down a fully-open
      // session. Neither body awaits user interaction, so the chain cannot
      // deadlock.
      logout: ({ wipe = false } = {}) =>
        serializeLifecycle(async () => {
          await resetToFreshLocal({ deleteDb: wipe })
          await clearAppSession({ store: sessionStore })
          // `resetToFreshLocal` already landed `local` (fresh anon replica);
          // clear the remaining transients.
          set({ phase: null, reconnecting: false })
        }),

      clearLocalData: () =>
        serializeLifecycle(async () => {
          await resetToFreshLocal({ deleteDb: true, discardAnonSeed: true })
          await clearAppSession({ store: sessionStore })
          set({ phase: null, reconnecting: false })
        }),

      hasLocalData: async () => {
        if (get().status !== 'local' || !hasStore()) {
          return false
        }
        try {
          // Counted in parallel: this runs on a login-button click, so the
          // probe costs one round of counts rather than one per collection.
          const counts = await Promise.all(
            config.collections.map(({ key }) =>
              requireStore().countEntities(key)
            )
          )
          return counts.some(count => count > 0)
        } catch {
          // A defensive guard: this probe runs off the serialized boot/destroy
          // lifecycle chain (the login page calls it while in `local`), so a
          // concurrent provider unmount could close the holder mid-read. `false`
          // only skips the adoption prompt, and login's `'merge'` default still
          // collects (through a fresh handle) whatever exists.
          return false
        }
      },

      notifyAccessExpired: () => {
        if (get().status === 'connected') {
          set({ status: 'reconnect' })
        }
      },

      destroy: () => serializeLifecycle(destroyImpl)
    }
  })

  return store
}
