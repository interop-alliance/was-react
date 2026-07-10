/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Shared WAS replication bootstrap: given a parsed grant set and the invoking
 * ZcapClient, builds the delegated {@link WasRemoteStore}, best-effort marks
 * each collection encrypted, and starts the supplied {@link SyncController} with
 * reactive store patching. The caller injects the opened localStore, the
 * controller, and the per-doc `onRemoteChange` patcher (typically wired to the
 * rehydrate mechanism over the app's store registry) rather than this module
 * reaching for app-side globals.
 */
import type { ZcapClient } from '@interop/ezcap'
import type { RxChangeEvent } from 'rxdb/plugins/core'
import type { SyncedDoc } from '../sync/index.js'
import type { ParsedGrants } from '../grants.js'
import { WasRemoteStore } from './wasRemoteStore.js'
import type { LocalStore } from './localStore.js'
import type { SyncController } from './syncController.js'

/**
 * Builds the remote store and starts background replication.
 *
 * @param options {object}
 * @param options.parsed {ParsedGrants}
 * @param options.zcapClient {ZcapClient}   invocation signer = grants' controller
 * @param options.localStore {LocalStore}   the opened local encrypted replica
 * @param options.syncController {SyncController}   a fresh per-session controller
 * @param options.onRemoteChange {(collectionKey, event) => void}   per-doc
 *   reactive patcher for pulled/conflict-resolved remote changes
 * @param [options.onAuthError] {() => void}   fired when replication hits a
 *   401/403 (expired/revoked access) -- wired to the reconnect banner
 * @returns {Promise<WasRemoteStore>}
 */
export async function startWasSync({
  parsed,
  zcapClient,
  localStore,
  syncController,
  onRemoteChange,
  onAuthError
}: {
  parsed: ParsedGrants
  zcapClient: ZcapClient
  localStore: LocalStore
  syncController: SyncController
  onRemoteChange: (
    collectionKey: string,
    event: RxChangeEvent<SyncedDoc>
  ) => void
  onAuthError?: () => void
}): Promise<WasRemoteStore> {
  const remoteStore = WasRemoteStore.fromGrants({ parsed, zcapClient })

  // Best-effort encryption marker; non-fatal either way (envelopes replicate
  // into an unmarked collection just the same).
  await Promise.all(
    Object.keys(parsed.byCollectionId).map(async collectionId => {
      const result = await remoteStore.markCollectionEncrypted(collectionId)
      if (!result.ok) {
        console.warn(
          `Encryption marker PUT not authorized for "${collectionId}" (status ${result.status ?? 'n/a'}).`
        )
      }
    })
  )

  await syncController.start({
    remoteStore,
    localStore,
    onRemoteChange,
    ...(onAuthError && { onAuthError })
  })
  return remoteStore
}
