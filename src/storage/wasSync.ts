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
 *
 * SHARED collections are handled apart from all of that. They belong to the
 * wallet, so they never enter replication, never get a local replica, and are
 * excluded from the best-effort description PUTs (a read-only grant would draw
 * nothing but a pointless 403). Instead one {@link SharedCollectionReader} is
 * opened per configured shared collection the grant set actually covers; a
 * shared collection with no covering grant, or one this app turns out not to be
 * a recipient of, is skipped with a warning rather than failing the session.
 */
import type { ZcapClient } from '@interop/ezcap'
import type { RxChangeEvent } from 'rxdb/plugins/core'
import type { CollectionEncryption } from '@interop/was-client'
import type {
  IKeyAgreementKey,
  IKeyResolver
} from '@interop/data-integrity-core'
import type { SyncedDoc } from '../sync/index.js'
import type { SharedCollectionConfig, WasCollectionConfig } from '../config.js'
import type { ParsedGrants } from '../grants.js'
import { WasRemoteStore } from './wasRemoteStore.js'
import { SharedCollectionReader } from './sharedCollectionReader.js'
import type { LocalStore } from './localStore.js'
import type { SyncController } from './syncController.js'

/**
 * What the sync bootstrap hands back: the delegated remote store, plus a
 * read-only {@link SharedCollectionReader} per configured shared collection the
 * grant set covers and this app is a recipient of, keyed by the config `key`.
 */
export interface WasSyncBootstrap {
  remoteStore: WasRemoteStore
  sharedCollections: Record<string, SharedCollectionReader>
}

/**
 * Builds the remote store, opens the shared-collection readers, and starts
 * background replication.
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
 * @param [options.sharedCollections] {SharedCollectionConfig[]}   the shared
 *   (read-only, wallet-owned) registry; never replicated, never written to
 * @param [options.identityKeys] {object}   this app's IDENTITY key-agreement key
 *   and its resolver, the recipient identity a wallet writes into a shared
 *   collection's epoch roster. Required to open any shared-collection reader
 * @param [options.identityKeys.keyAgreementKey] {IKeyAgreementKey}
 * @param [options.identityKeys.keyResolver] {IKeyResolver}
 * @param [options.onAuthError] {() => void}   fired when replication hits a
 *   401/403 (expired/revoked access) -- wired to the reconnect banner
 * @param [options.onDescriptorsFetched] {(descriptors) => void | Promise<void>}   given
 *   the freshly fetched per-collection encryption descriptors (by WAS collection
 *   id), to refresh the offline descriptor cache
 * @returns {Promise<WasSyncBootstrap>}
 */
export async function startWasSync({
  parsed,
  zcapClient,
  collections,
  localStore,
  syncController,
  onRemoteChange,
  sharedCollections = [],
  identityKeys,
  onAuthError,
  onDescriptorsFetched
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
  sharedCollections?: SharedCollectionConfig[]
  identityKeys?: {
    keyAgreementKey: IKeyAgreementKey
    keyResolver: IKeyResolver
  }
  onAuthError?: () => void
  onDescriptorsFetched?: (
    descriptors: Record<string, CollectionEncryption>
  ) => void | Promise<void>
}): Promise<WasSyncBootstrap> {
  const remoteStore = WasRemoteStore.fromGrants({
    parsed,
    zcapClient,
    collections
  })

  // Best-effort collection-description PUTs; non-fatal either way (envelopes
  // replicate into an unmarked collection just the same, and a query against
  // undeclared indexes fails with a descriptive 400). Each helper skips the
  // collections it does not apply to (reported ok + skipped): the encryption
  // descriptor skips public collections, the indexes declaration skips private
  // ones and public ones with no declared indexes.
  const sharedIds = new Set(sharedCollections.map(entry => entry.id))
  await Promise.all(
    Object.keys(parsed.byCollectionId)
      .filter(collectionId => !sharedIds.has(collectionId))
      .map(async collectionId => {
        const declared = await remoteStore.markCollectionEncrypted(collectionId)
        if (!declared.ok) {
          console.warn(
            `Encryption descriptor PUT not authorized for "${collectionId}" (status ${declared.status ?? 'n/a'}).`
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

  // Fetch each granted private collection's encryption descriptor: rebuild that
  // collection's cipher when its epoch roster differs from what the local store
  // opened with (a wallet-side rotation, or first-ever epochs), and hand the
  // fresh set to the descriptor-cache refresher so an offline session can rebuild
  // its epoch-aware ciphers without a live read.
  const privateIds = collections
    .filter(collection => collection.visibility !== 'public')
    .map(collection => collection.id)
    .filter(id => parsed.byCollectionId[id] !== undefined)
  const descriptors: Record<string, CollectionEncryption> = {}
  await Promise.all(
    privateIds.map(async collectionId => {
      const encryption =
        await remoteStore.readCollectionEncryption(collectionId)
      if (encryption) {
        descriptors[collectionId] = encryption
        await localStore.applyRemoteDescriptor({ collectionId, encryption })
      }
    })
  )
  // Install the one-shot epoch refresher so a decrypt that meets an unseen epoch
  // (a rotation on another device) re-reads the descriptor and rebuilds the cipher.
  localStore.setEpochRefresher(collectionId =>
    remoteStore.readCollectionEncryption(collectionId)
  )
  if (onDescriptorsFetched) {
    await onDescriptorsFetched(descriptors)
  }

  // Shared collections stay entirely out of replication: one read-only reader
  // each, opened over the delegated read zcap and the collection's epoch
  // roster. Every failure mode here is a warn-and-skip -- an uncovered grant,
  // a collection with no roster, an app that is not (or is no longer) a
  // recipient -- so a removed share degrades one reader, never the session.
  const sharedReaders: Record<string, SharedCollectionReader> = {}
  for (const { key, id } of sharedCollections) {
    if (!parsed.byCollectionId[id]) {
      console.warn(
        `Skipping shared collection "${id}": no delegated capability covers it.`
      )
      continue
    }
    if (!identityKeys) {
      console.warn(
        `Skipping shared collection "${id}": no identity key-agreement key was ` +
          `supplied to decrypt it with.`
      )
      continue
    }
    try {
      sharedReaders[key] = await SharedCollectionReader.open({
        remoteStore,
        keyAgreementKey: identityKeys.keyAgreementKey,
        keyResolver: identityKeys.keyResolver,
        collectionId: id
      })
    } catch (err) {
      console.warn(`Skipping shared collection "${id}":`, err)
    }
  }

  await syncController.start({
    remoteStore,
    localStore,
    onRemoteChange,
    ...(onAuthError && { onAuthError })
  })
  return { remoteStore, sharedCollections: sharedReaders }
}
