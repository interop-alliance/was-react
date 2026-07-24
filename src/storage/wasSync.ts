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
import type { CollectionEncryption } from '@interop/was-client'
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
 * @param [options.onMarkersFetched] {(markers) => void | Promise<void>}   given
 *   the freshly fetched per-collection encryption markers (by WAS collection
 *   id), to refresh the offline marker cache
 * @returns {Promise<WasRemoteStore>}
 */
export async function startWasSync({
  parsed,
  zcapClient,
  collections,
  localStore,
  syncController,
  onRemoteChange,
  onAuthError,
  onMarkersFetched
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
  onMarkersFetched?: (
    markers: Record<string, CollectionEncryption>
  ) => void | Promise<void>
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

  // Fetch each granted private collection's encryption marker: rebuild that
  // collection's cipher when its epoch roster differs from what the local store
  // opened with (a wallet-side rotation, or first-ever epochs), and hand the
  // fresh set to the marker-cache refresher so an offline session can rebuild
  // its epoch-aware ciphers without a live read.
  const privateIds = collections
    .filter(collection => collection.visibility !== 'public')
    .map(collection => collection.id)
    .filter(id => parsed.byCollectionId[id] !== undefined)
  const markers: Record<string, CollectionEncryption> = {}
  await Promise.all(
    privateIds.map(async collectionId => {
      const encryption =
        await remoteStore.readCollectionEncryption(collectionId)
      if (encryption) {
        markers[collectionId] = encryption
        await localStore.applyRemoteMarker({ collectionId, encryption })
      }
    })
  )
  // Install the one-shot epoch refresher so a decrypt that meets an unseen epoch
  // (a rotation on another device) re-reads the marker and rebuilds the cipher.
  localStore.setEpochRefresher(collectionId =>
    remoteStore.readCollectionEncryption(collectionId)
  )
  if (onMarkersFetched) {
    await onMarkersFetched(markers)
  }

  await syncController.start({
    remoteStore,
    localStore,
    onRemoteChange,
    ...(onAuthError && { onAuthError })
  })
  return remoteStore
}
