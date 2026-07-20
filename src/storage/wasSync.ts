/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Shared WAS replication bootstrap: given a parsed grant set and the invoking
 * ZcapClient, builds the delegated {@link WasRemoteStore}, best-effort marks
 * each private collection encrypted and declares each public collection's
 * equality `indexes`, and starts the supplied {@link SyncController} with
 * reactive store patching. The caller injects the opened localStore, the
 * controller, and the per-doc `onRemoteChange` patcher (typically wired to the
 * rehydrate mechanism over the app's store registry) rather than this module
 * reaching for app-side globals.
 */
import type { ZcapClient } from '@interop/ezcap'
import type { RxChangeEvent } from 'rxdb/plugins/core'
import type { SyncedDoc } from '../sync/index.js'
import type { WasCollectionConfig } from '../config.js'
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
 * @param options.collections {WasCollectionConfig[]}   the collection registry;
 *   public (plaintext) collections are never marked encrypted
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
  collections,
  localStore,
  syncController,
  onRemoteChange,
  onAuthError
}: {
  parsed: ParsedGrants
  zcapClient: ZcapClient
  collections: WasCollectionConfig[]
  localStore: LocalStore
  syncController: SyncController
  onRemoteChange: (
    collectionKey: string,
    event: RxChangeEvent<SyncedDoc>
  ) => void
  onAuthError?: () => void
}): Promise<WasRemoteStore> {
  const remoteStore = WasRemoteStore.fromGrants({
    parsed,
    zcapClient,
    collections
  })

  // Best-effort collection-description PUTs; non-fatal either way (envelopes
  // replicate into an unmarked collection just the same, and a query against
  // undeclared indexes fails with a descriptive 400). Each helper skips the
  // collections it does not apply to (reported ok + skipped): the encryption
  // marker skips public collections, the indexes declaration skips private
  // ones and public ones with no declared indexes.
  await Promise.all(
    Object.keys(parsed.byCollectionId).map(async collectionId => {
      const marker = await remoteStore.markCollectionEncrypted(collectionId)
      if (!marker.ok) {
        console.warn(
          `Encryption marker PUT not authorized for "${collectionId}" (status ${marker.status ?? 'n/a'}).`
        )
      }
      const indexes = await remoteStore.declareCollectionIndexes(collectionId)
      if (!indexes.ok) {
        console.warn(
          `Indexes declaration PUT not authorized for "${collectionId}" (status ${indexes.status ?? 'n/a'}).`
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
