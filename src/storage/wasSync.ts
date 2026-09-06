/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Shared WAS replication bootstrap: given a parsed grant set and the invoking
 * ZcapClient, builds the delegated {@link WasRemoteStore}, best-effort marks
 * each private collection encrypted and declares each collection's equality
 * indexes -- in the collection description for a public one, in the
 * collection's encrypted metadata (as blinded-index attributes) for a private
 * one -- and starts the supplied {@link SyncController} with
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
import { hasKeyEpochs } from '@interop/was-client/edv'
import type { SyncedDoc } from '@interop/was-sync'
import {
  isPublicCollection,
  type SharedCollectionConfig,
  type WasCollectionConfig
} from '../config.js'
import type { ParsedGrants } from '../grants.js'
import { WasRemoteStore, remoteDescriptorSource } from './wasRemoteStore.js'
import { SharedCollectionReader } from './sharedCollectionReader.js'
import type { LocalStore } from './localStore.js'
import type { SyncController } from './syncController.js'
import { log } from '../log.js'

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
 * The one read-filter-cache pass over a grant set, shared by the login-time
 * {@link readRemoteDescriptors} and the sync bootstrap: per REGISTERED
 * collection the grants actually cover, read the private ones' encryption
 * descriptor ONCE (reusing one the caller already read) and keep only the
 * epoch-bearing ones -- a rosterless descriptor cannot build a cipher. A
 * granted id the app never registered is nobody's business here, and a public
 * collection carries no descriptor at all.
 *
 * `onCollection` is the bootstrap's hook: it runs per granted collection --
 * public ones included -- with the RAW descriptor as read (epoch-bearing or
 * not), so the description PUTs and the cipher rebuild ride the same single
 * read. Collections are processed concurrently, hook included, so one slow
 * collection never holds up the others.
 *
 * A read that FAILS (rather than answering "no descriptor") is never taken
 * for an absent descriptor. The collection is skipped entirely, hook included,
 * and reported on `failures`, so neither a placeholder cipher nor a bare
 * descriptor PUT is built on a guess about a collection whose roster could not
 * be read. Every collection settles: an outage affecting several reports each
 * of them, and the caller decides what a non-empty `failures` means (the
 * login-time read rejects on it, the bootstrap warns and skips).
 *
 * @param options {object}
 * @param options.remoteStore {WasRemoteStore}
 * @param options.collections {WasCollectionConfig[]}
 * @param options.parsed {ParsedGrants}
 * @param [options.knownDescriptors] {Record<string, CollectionEncryption>}
 *   descriptors already read live in this bring-up, reused instead of re-read
 * @param [options.onCollection] {(options) => Promise<void>}   per granted
 *   collection, with its raw descriptor (absent for a public one)
 * @returns {Promise<DescriptorReadOutcome>}   the epoch-bearing descriptors,
 *   keyed by WAS collection id, and the collections whose read failed
 */
async function readGrantedEncryption({
  remoteStore,
  collections,
  parsed,
  knownDescriptors = {},
  onCollection
}: {
  remoteStore: WasRemoteStore
  collections: WasCollectionConfig[]
  parsed: ParsedGrants
  knownDescriptors?: Record<string, CollectionEncryption>
  onCollection?: (options: {
    collection: WasCollectionConfig
    encryption?: CollectionEncryption
  }) => Promise<void>
}): Promise<DescriptorReadOutcome> {
  const granted = collections.filter(
    collection => parsed.byCollectionId[collection.id] !== undefined
  )
  const descriptors: Record<string, CollectionEncryption> = {}
  const failures: DescriptorReadOutcome['failures'] = []
  await Promise.all(
    granted.map(async collection => {
      const { id: collectionId } = collection
      let encryption: CollectionEncryption | undefined
      if (!isPublicCollection(collection)) {
        // A descriptor the caller read seconds ago is reused as-is; only ids it
        // did not cover (or a hot restore, which passes none) are read live.
        encryption = knownDescriptors[collectionId]
        if (!encryption) {
          try {
            encryption =
              await remoteStore.readCollectionEncryption(collectionId)
          } catch (err) {
            failures.push({ collection, err })
            return
          }
        }
        if (hasKeyEpochs(encryption)) {
          descriptors[collectionId] = encryption
        }
      }
      if (onCollection) {
        await onCollection({
          collection,
          ...(encryption && { encryption })
        })
      }
    })
  )
  return { descriptors, failures }
}

/**
 * What one pass of descriptor reads settled to: the epoch-bearing descriptors
 * (a rosterless one cannot build a cipher) and, apart from them, every
 * collection whose read failed rather than answering "no descriptor".
 */
export type DescriptorReadOutcome = {
  descriptors: Record<string, CollectionEncryption>
  failures: Array<{ collection: WasCollectionConfig; err: unknown }>
}

/**
 * One live encryption-descriptor read per granted private collection, invoked
 * with the grants' delegated zcaps and keyed by WAS collection id. Used at
 * login time, BEFORE any replication exists: the connected replica must open
 * epoch-aware -- epoch-from-birth leaves no single-key fallback, and the
 * adoption merge writes into it before sync starts. The sync bootstrap reuses
 * these reads (its `knownDescriptors` input) rather than re-issuing them.
 *
 * A failed read is reported on `failures` rather than rejecting, so the caller
 * chooses: a login rejects on any failure (the adoption merge would write
 * into a replica opened over a guess), while a hot restore skips the
 * collection fail-closed and leaves the sync bootstrap to repair it.
 *
 * @param options {object}
 * @param options.parsed {ParsedGrants}
 * @param options.zcapClient {ZcapClient}   invocation signer = grants' controller
 * @param options.collections {WasCollectionConfig[]}   the collections to read
 *   descriptors for (public ones are skipped)
 * @returns {Promise<DescriptorReadOutcome>}
 */
export async function readRemoteDescriptors({
  parsed,
  zcapClient,
  collections
}: {
  parsed: ParsedGrants
  zcapClient: ZcapClient
  collections: WasCollectionConfig[]
}): Promise<DescriptorReadOutcome> {
  const remoteStore = WasRemoteStore.fromGrants({
    parsed,
    zcapClient,
    collections
  })
  return await readGrantedEncryption({ remoteStore, collections, parsed })
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
 *   collection's epoch roster. Required to open any shared-collection reader,
 *   and to run the codec-driven blinded-index verbs on a private collection
 * @param [options.identityKeys.keyAgreementKey] {IKeyAgreementKey}
 * @param [options.identityKeys.keyResolver] {IKeyResolver}
 * @param [options.onAuthError] {() => void}   fired when replication hits a
 *   401/403 (expired/revoked access) -- wired to the reconnect banner
 * @param [options.onDescriptorsFetched] {(descriptors) => void | Promise<void>}   given
 *   the freshly fetched per-collection encryption descriptors (by WAS collection
 *   id), to refresh the offline descriptor cache
 * @param [options.knownDescriptors] {Record<string, CollectionEncryption>}
 *   descriptors the caller ALREADY read live in this same bring-up (the
 *   login-time {@link readRemoteDescriptors} pass); the bootstrap reuses them
 *   instead of re-issuing the same GET seconds later. A hot restore passes
 *   none -- there the bootstrap read IS the freshness refresh over the
 *   offline cache
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
  onDescriptorsFetched,
  knownDescriptors = {}
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
  knownDescriptors?: Record<string, CollectionEncryption>
}): Promise<WasSyncBootstrap> {
  const remoteStore = WasRemoteStore.fromGrants({
    parsed,
    zcapClient,
    collections,
    // The same identity keys that open a shared-collection reader also let the
    // client's EDV keystore build a codec, which the blinded-index verbs need.
    ...(identityKeys && { keys: identityKeys })
  })

  // One pass per REGISTERED collection the grant set covers -- the registry is
  // what this app declared, so a granted id it never registered is none of this
  // bootstrap's business. Two things happen per collection:
  //
  // - the best-effort collection-description PUTs; non-fatal either way
  //   (envelopes replicate into an unmarked collection just the same, and a
  //   query against undeclared indexes fails with a descriptive 400). Each
  //   helper skips the collections it does not apply to (reported ok +
  //   skipped): the encryption descriptor skips public collections, the indexes
  //   declaration skips private ones and public ones with no declared indexes;
  // - the private collection's encryption descriptor is fetched: rebuild that
  //   collection's cipher when its epoch roster differs from what the local
  //   store opened with (a wallet-side rotation, or first-ever epochs), and hand
  //   the fresh set to the descriptor-cache refresher so an offline session can
  //   rebuild its epoch-aware ciphers without a live read.
  //
  // A private collection with a blinding key gets one more ride-along on the
  // same pass: its stored collection metadata is fetched RAW (the opaque
  // envelope, not the decoded form) and installed on that collection's local
  // cipher, which carries the persisted blinded-index schema. Documents written
  // from then on carry blinded `indexed` entries and are findable by
  // `collection.find()`. It runs AFTER the declaration deliberately: the
  // declaration may have written fresh attributes into the persisted schema, and
  // the metadata read must see them.
  //
  // The description is READ ONCE per collection and feeds both: the same
  // descriptor answers the encryption PUT's read-before-write roster-clobber
  // guard and the cipher rebuild, rather than each fetching it separately.
  //
  // SHARED collections never appear here: they are wallet-owned, absent from
  // the app-owned registry, and a read-only grant would draw nothing but a
  // pointless 403.
  const { descriptors, failures } = await readGrantedEncryption({
    remoteStore,
    collections,
    parsed,
    knownDescriptors,
    onCollection: async ({ collection, encryption }) => {
      const { id: collectionId } = collection
      if (!isPublicCollection(collection)) {
        // Only an epoch-bearing descriptor enters the offline cache or
        // rebuilds a cipher; a collection without a key-epoch roster stays
        // fail-closed, stated plainly here rather than surfacing later as
        // per-row decrypt failures.
        if (hasKeyEpochs(encryption)) {
          await localStore.applyRemoteDescriptor({ collectionId, encryption })
        } else {
          log.warn(
            'A collection has no key-epoch roster on its encryption ' +
              'descriptor; it stays unreadable (fail-closed) until its ' +
              'provisioner installs one.',
            { collectionId }
          )
        }
        const declared = await remoteStore.markCollectionEncrypted(
          collectionId,
          { encryption }
        )
        if (!declared.ok) {
          log.warn('Encryption descriptor PUT not authorized.', {
            collectionId,
            status: declared.status ?? 'n/a'
          })
        }
        // The private-collection counterpart of the public `indexes` PUT: the
        // blinded-index schema lives in the collection's own encrypted
        // metadata, so it is written through the collection handle rather than
        // the description. Non-fatal: an unqueryable collection is still a
        // fully replicating one.
        const blinded = await remoteStore.declareBlindedIndexes(collectionId, {
          encryption
        })
        if (!blinded.ok) {
          log.warn('Blinded-index declaration failed.', {
            collectionId,
            error: blinded.error ?? 'unknown error',
            status: blinded.status ?? 'n/a'
          })
        }
        // The schema the declaration just settled is then installed on this
        // collection's local cipher, so the documents this replica writes from
        // now on carry blinded `indexed` entries. A descriptor with no `hmac`
        // carries no blinding key at all, so the install could only be a no-op:
        // the metadata read is skipped rather than spent.
        // A read that fails (rather than answering "no metadata") skips the
        // install for this session with a warning: the answer is unknown, and
        // an install skipped over a guess is the same outcome either way, but
        // the warning says why.
        if (hasKeyEpochs(encryption) && encryption.hmac) {
          try {
            const meta = await remoteStore.readCollectionMeta(collectionId)
            if (meta) {
              await localStore.applyCollectionMeta({
                collectionId,
                custom: meta.custom
              })
            }
          } catch (err) {
            log.warn('Blinded-index schema install failed.', {
              collectionId,
              err
            })
          }
        }
      }
      const indexes = await remoteStore.declareCollectionIndexes(collectionId)
      if (!indexes.ok) {
        log.warn('Indexes declaration PUT not authorized.', {
          collectionId,
          status: indexes.status ?? 'n/a'
        })
      }
    }
  })
  // A read that failed degrades that one collection: it keeps the cipher it
  // opened with (the cached descriptor, or fail-closed) and receives no
  // description PUT this session. It is not "no descriptor".
  for (const { collection, err } of failures) {
    log.warn(
      'Skipping the sync bootstrap of a collection: its encryption ' +
        'descriptor could not be read.',
      { collectionId: collection.id, err }
    )
  }
  // Install the encryption-descriptor source so a decrypt that meets an unseen
  // epoch (a rotation on another device) re-reads the descriptor and rebuilds
  // the cipher -- once per collection per session.
  localStore.setDescriptorSource(remoteDescriptorSource({ remoteStore }))
  if (onDescriptorsFetched) {
    await onDescriptorsFetched(descriptors)
  }

  // Shared collections stay entirely out of replication: one read-only reader
  // each, opened over the delegated read zcap and the collection's epoch
  // roster. Every failure mode here is a warn-and-skip -- an uncovered grant,
  // a collection with no roster, an app that is not (or is no longer) a
  // recipient -- so a removed share degrades one reader, never the session.
  // Opened concurrently: each `open` costs a description read plus an ECDH
  // unwrap, and no reader depends on another.
  const sharedReaders: Record<string, SharedCollectionReader> = {}
  await Promise.all(
    sharedCollections.map(async ({ key, id }) => {
      if (!parsed.byCollectionId[id]) {
        log.warn(
          'Skipping a shared collection: no delegated capability covers it.',
          { collectionId: id }
        )
        return
      }
      if (!identityKeys) {
        log.warn(
          'Skipping a shared collection: no identity key-agreement key was ' +
            'supplied to decrypt it with.',
          { collectionId: id }
        )
        return
      }
      try {
        sharedReaders[key] = await SharedCollectionReader.open({
          remoteStore,
          keyAgreementKey: identityKeys.keyAgreementKey,
          keyResolver: identityKeys.keyResolver,
          collectionId: id
        })
      } catch (err) {
        log.warn('Skipping a shared collection.', { collectionId: id, err })
      }
    })
  )

  await syncController.start({
    remoteStore,
    localStore,
    onRemoteChange,
    ...(onAuthError && { onAuthError })
  })
  return { remoteStore, sharedCollections: sharedReaders }
}
