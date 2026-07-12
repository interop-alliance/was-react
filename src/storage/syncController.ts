/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * SyncController: the app-side lifecycle around background WAS replication for
 * the delegated RP model.
 *
 * The local RxDB collections owned by {@link LocalStore} are the always-on active
 * replica; `start()` spins up one `replicateRxCollection` state machine per
 * entity collection against the user's WAS Space, invoking that collection's
 * delegated capability. Reachability is not polled -- the replication attempt is
 * the probe; RxDB's `retryTime` backoff retries a down server and surfaces
 * failures on `error$`. The one explicit reachability wire is the `online`
 * listener, which fires `reSync()` on reconnect so a long-offline session
 * recovers promptly rather than waiting out the backoff.
 *
 * Reactivity (multi-device live updates): each collection's RxDB change stream
 * (`rxCollection.$`) triggers `onRemoteChange(collectionKey, event)`, which the
 * caller wires to re-decrypt and patch the app store per-doc. Subscribing to the
 * collection stream (rather than the replication `received$`) is deliberate: it
 * also fires for documents rewritten by CONFLICT RESOLUTION on the push path
 * (when this replica adopts the remote master under LWW), which `received$`
 * (pull-only) misses -- otherwise the losing side's UI would show its stale local
 * edit until the next unrelated pull. The caller debounces, and a re-hydrate
 * after this replica's own optimistic write is idempotent.
 *
 * Construct via {@link createSyncController}, which captures the collection
 * registry and sync tuning; the returned controller is single-use per session
 * (started once, stopped on logout).
 */
import type { RxReplicationState } from 'rxdb/plugins/replication'
import type { RxChangeEvent } from 'rxdb/plugins/core'
import {
  createWasReplication,
  createWasSyncPort,
  withFeedMasterRead,
  WasSyncAuthError,
  type SyncCheckpoint,
  type SyncedDoc
} from '../sync/index.js'
import {
  DEFAULT_SYNC_POLL_MS,
  type WasCollectionConfig,
  type WasSyncConfig
} from '../config.js'
import type { LocalStore } from './localStore.js'
import type { WasRemoteStore } from './wasRemoteStore.js'
import { useSyncStatusStore } from './syncStatusStore.js'

/**
 * The subset of an RxJS `Subscription` we hold (rxjs is a transitive dep).
 */
type Unsubscribable = { unsubscribe: () => void }

/**
 * Whether a replication error signals expired/revoked storage access. Every WAS
 * request the replication makes funnels through the sync port, which maps a
 * `401` / `403` to a typed {@link WasSyncAuthError} at the boundary. RxDB then
 * wraps that thrown error inside an RxError (nested under `cause` / `errors` /
 * `parameters.errors`), so this walks the error graph looking for a
 * `WasSyncAuthError` instance rather than re-extracting raw status codes.
 *
 * @param err {unknown}
 * @returns {boolean}
 */
export function isAuthError(err: unknown): boolean {
  const seen = new Set<unknown>()
  const queue: unknown[] = [err]
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === null || typeof current !== 'object' || seen.has(current)) {
      continue
    }
    seen.add(current)
    if (current instanceof WasSyncAuthError) {
      return true
    }
    const candidate = current as {
      cause?: unknown
      parameters?: { errors?: unknown[] }
      errors?: unknown[]
    }
    if (candidate.cause) {
      queue.push(candidate.cause)
    }
    if (Array.isArray(candidate.errors)) {
      queue.push(...candidate.errors)
    }
    if (Array.isArray(candidate.parameters?.errors)) {
      queue.push(...candidate.parameters.errors)
    }
  }
  return false
}

interface CollectionReplication {
  state: RxReplicationState<SyncedDoc, SyncCheckpoint>
  subscriptions: Unsubscribable[]
}

/**
 * A per-session controller around background replication. Construct via
 * {@link createSyncController}.
 */
export class SyncController {
  private _collections: WasCollectionConfig[]
  private _sync: WasSyncConfig
  private _replications: CollectionReplication[] = []
  private _onlineHandler?: () => void
  private _pollTimer?: ReturnType<typeof setInterval>
  private _started = false
  private _stopped = false

  constructor({
    collections,
    sync
  }: {
    collections: WasCollectionConfig[]
    sync?: WasSyncConfig
  }) {
    this._collections = collections
    this._sync = sync ?? {}
  }

  /**
   * Starts background replication for every entity collection covered by the
   * grant set. Idempotent (a no-op if already running).
   *
   * @param options {object}
   * @param options.remoteStore {WasRemoteStore}
   * @param options.localStore {LocalStore}
   * @param [options.onRemoteChange] {(collectionKey: string, event) => void}
   *   fired per RxDB change (pull or conflict-resolved push) for reactive
   *   per-doc store patching
   * @param [options.onAuthError] {() => void}   fired when a replication error
   *   carries a 401/403 (storage access expired/revoked)
   * @returns {Promise<void>}
   */
  async start({
    remoteStore,
    localStore,
    onRemoteChange,
    onAuthError
  }: {
    remoteStore: WasRemoteStore
    localStore: LocalStore
    onRemoteChange?: (
      collectionKey: string,
      event: RxChangeEvent<SyncedDoc>
    ) => void
    onAuthError?: () => void
  }): Promise<void> {
    // `stop()` is terminal: a controller stopped before `start()` ran (a logout
    // that raced an in-flight session bootstrap) must never spin up
    // replications against the now-closed database.
    if (this._started || this._stopped) {
      return
    }
    this._started = true
    const setStatus = useSyncStatusStore.getState().setStatus
    const batchSize = this._sync.batchSize
    const retryMs = this._sync.retryMs
    const pollMs = this._sync.pollMs ?? DEFAULT_SYNC_POLL_MS

    try {
      for (const { key, id } of this._collections) {
        const capability = remoteStore.collectionCapability(id)
        // A collection the grant set does not cover would otherwise sync with no
        // capability and draw a fail-closed 403, tripping the session-wide
        // "storage access expired" banner. Skip it (and flag it) instead so an
        // uncovered collection never masquerades as expired access.
        if (!capability) {
          console.warn(
            `Skipping sync for "${id}": no delegated capability covers it.`
          )
          setStatus(id, 'error')
          continue
        }
        setStatus(id, 'idle')
        // Wrap the verbatim port so the 412 conflict re-read resolves `version`
        // from the changes-feed body (CORS hides the `GET` ETag cross-origin).
        const wasPort = withFeedMasterRead(
          createWasSyncPort({
            was: remoteStore.was,
            spaceId: remoteStore.spaceId,
            collectionId: id,
            capability
          })
        )
        const state = createWasReplication({
          rxCollection: localStore.rxCollection(key),
          wasPort,
          replicationIdentifier: `was-sync:${remoteStore.serverUrl}:${remoteStore.spaceId}:${id}`,
          ...(batchSize !== undefined && { batchSize }),
          ...(retryMs !== undefined && { retryTime: retryMs })
        })

        const subscriptions: Unsubscribable[] = [
          state.active$.subscribe(active => {
            setStatus(id, active ? 'syncing' : 'synced')
          }),
          state.error$.subscribe(err => {
            console.error(`Sync error for "${id}":`, err)
            setStatus(id, 'error')
            if (onAuthError && isAuthError(err)) {
              onAuthError()
            }
          })
        ]
        if (onRemoteChange) {
          subscriptions.push(
            localStore
              .rxCollection(key)
              .$.subscribe(event => onRemoteChange(key, event))
          )
        }
        this._replications.push({ state, subscriptions })
      }

      this._onlineHandler = () => this.reSync()
      window.addEventListener('online', this._onlineHandler)

      // The pull side has no server-side live stream, so an already-open session
      // would otherwise never see another device's edits. A low-frequency
      // periodic reSync polls the changes feed so multi-device edits converge
      // live (the change subscriptions above then patch the stores).
      if (pollMs > 0) {
        this._pollTimer = setInterval(() => this.reSync(), pollMs)
      }
    } catch (err) {
      console.error('Failed to start sync controller:', err)
      await this.stop()
    }
  }

  /**
   * Triggers an immediate replication cycle on every running collection, rather
   * than waiting for RxDB's next scheduled tick. Fire-and-forget.
   *
   * @returns {void}
   */
  reSync(): void {
    for (const { state } of this._replications) {
      state.reSync()
    }
  }

  /**
   * Stops replication and releases resources (the database is owned by the
   * caller). Idempotent.
   *
   * @returns {Promise<void>}
   */
  async stop(): Promise<void> {
    // Latch first so a concurrent `start()` (a logout racing the session
    // bootstrap) sees the controller as terminally stopped and bails.
    this._stopped = true
    if (this._onlineHandler) {
      window.removeEventListener('online', this._onlineHandler)
      this._onlineHandler = undefined
    }
    if (this._pollTimer) {
      clearInterval(this._pollTimer)
      this._pollTimer = undefined
    }
    for (const { state, subscriptions } of this._replications) {
      for (const subscription of subscriptions) {
        subscription.unsubscribe()
      }
      try {
        await state.cancel()
      } catch (err) {
        console.error('Error cancelling replication:', err)
      }
    }
    this._replications = []
    useSyncStatusStore.getState().reset()
    this._started = false
  }
}

/**
 * Builds a fresh {@link SyncController} bound to the collection registry and
 * sync tuning. Prefer one controller per session (started once, stopped on
 * logout) over a module-level singleton.
 *
 * @param options {object}
 * @param options.collections {WasCollectionConfig[]}
 * @param [options.sync] {WasSyncConfig}
 * @returns {SyncController}
 */
export function createSyncController({
  collections,
  sync
}: {
  collections: WasCollectionConfig[]
  sync?: WasSyncConfig
}): SyncController {
  return new SyncController({ collections, ...(sync && { sync }) })
}
