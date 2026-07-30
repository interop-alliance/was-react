/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * SharedCollectionReader: a READ-ONLY view over one wallet-owned encrypted
 * collection the wallet has shared with this app (the
 * `urn:was:shared-collection` grant). It is the app-side other half of the
 * wallet's share flow, and it is read-only BY CONSTRUCTION -- there is no write
 * verb on this class, the collection is never replicated into RxDB, and the
 * sync bootstrap never PUTs a description onto it.
 *
 * A share fuses two axes, and both are needed here:
 *
 * - **pull** -- the delegated `GET`/`HEAD` zcap on the collection, which is what
 *   the server checks at request time;
 * - **read** -- an entry in the collection's key-epoch roster, wrapped to this
 *   app's IDENTITY key-agreement key (the X25519 twin of its did:key
 *   controller, `IdentityAgents.keyAgreementKey`). That is the same key the
 *   app's own collections are encrypted with: one rule for every roster entry,
 *   whoever owns the collection.
 *
 * The stored resource body IS the EDV envelope the wallet's replication moved
 * verbatim, so reads must be RAW: the handle is opened with the
 * `encryption: 'plaintext'` override (the `WasClient`'s own encryption provider
 * is a deliberate no-op keystore) and the envelope is decrypted locally with a
 * cipher built from the collection's `encryption` marker.
 *
 * The honest ceiling, the same one the wallet's consent screen states:
 *
 * - access can be removed later, which stops FUTURE reads but cannot take back
 *   what has already been read;
 * - resources written BEFORE the collection's first share are single-recipient
 *   envelopes sealed to the owner alone. They will not decrypt here. That is
 *   expected, not corruption -- they are skipped with a warning.
 */
import { NotImplementedError } from '@interop/was-client'
import type { Collection, CollectionEncryption } from '@interop/was-client'
import type {
  IKeyAgreementKey,
  IKeyResolver
} from '@interop/data-integrity-core'
import { UnknownEpochError } from '@interop/was-client/edv'
import {
  createDocCipher,
  errorMessage,
  isEncryptedEnvelope,
  type DocCipher,
  type Json
} from '../sync/index.js'
import type { WasRemoteStore } from './wasRemoteStore.js'

/**
 * Default page size for the `changes`-feed walk. The server clamps its own
 * maximum, and a page shorter than what was asked for is the feed's end-of-walk
 * signal. Lower it on a collection of large envelopes to bound per-response
 * size.
 */
export const SHARED_CHANGES_PAGE_SIZE = 100

/**
 * The `changes`-feed resume position, read off the handle's own signature so
 * this module needs no direct dependency on the storage-core types package.
 */
type ChangesCheckpoint = NonNullable<
  Awaited<ReturnType<Collection['changes']>>['checkpoint']
>

/**
 * One decrypted resource of a shared collection: the WAS resource id (the
 * envelope id, opaque) and its decrypted payload.
 */
export interface SharedResource {
  id: string
  data: Json
}

/**
 * Thrown when a shared collection cannot be opened for reading: it carries no
 * multi-recipient key-epoch roster, or this app is not a recipient of any epoch
 * on it (the wallet never shared it, or a later un-share rotated the epoch off
 * this app's key).
 */
export class SharedCollectionUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'SharedCollectionUnavailableError'
  }
}

export class SharedCollectionReader {
  readonly collectionId: string
  readonly #remoteStore: WasRemoteStore
  readonly #keyAgreementKey: IKeyAgreementKey
  readonly #keyResolver: IKeyResolver
  #cipher: DocCipher
  // Whether an unknown-epoch marker refresh has already run for this reader. An
  // epoch rotation emits no change-feed entry, so a stale marker is the
  // expected failure mode; one refresh per reader is enough to recover, and the
  // cap keeps a genuinely undecryptable envelope from looping.
  #refreshed = false
  // Whether the one-time "reading this collection the slow way" warning has
  // already been emitted for this reader.
  #warnedSlowPath = false
  readonly #pageSize: number

  private constructor({
    collectionId,
    remoteStore,
    keyAgreementKey,
    keyResolver,
    cipher,
    pageSize
  }: {
    collectionId: string
    remoteStore: WasRemoteStore
    keyAgreementKey: IKeyAgreementKey
    keyResolver: IKeyResolver
    cipher: DocCipher
    pageSize: number
  }) {
    this.collectionId = collectionId
    this.#remoteStore = remoteStore
    this.#keyAgreementKey = keyAgreementKey
    this.#keyResolver = keyResolver
    this.#cipher = cipher
    this.#pageSize = pageSize
  }

  /**
   * Opens a reader over one shared collection: reads its `encryption` marker
   * through the delegated zcap and builds the epoch-aware cipher from it.
   *
   * Throws {@link SharedCollectionUnavailableError} when the collection carries
   * no marker or a marker with no key epochs (it is not multi-recipient, so this
   * app cannot be a recipient of it), and likewise when the cipher cannot unwrap
   * any epoch (this app is not, or is no longer, in the roster).
   *
   * @param options {object}
   * @param options.remoteStore {WasRemoteStore}   the delegated remote store
   * @param options.keyAgreementKey {IKeyAgreementKey}   this app's IDENTITY KAK
   * @param options.keyResolver {IKeyResolver}   its one-key resolver
   * @param options.collectionId {string}   the WAS collection id
   * @param [options.pageSize] {number}   `changes`-feed page size (defaults to
   *   {@link SHARED_CHANGES_PAGE_SIZE})
   * @returns {Promise<SharedCollectionReader>}
   */
  static async open({
    remoteStore,
    keyAgreementKey,
    keyResolver,
    collectionId,
    pageSize = SHARED_CHANGES_PAGE_SIZE
  }: {
    remoteStore: WasRemoteStore
    keyAgreementKey: IKeyAgreementKey
    keyResolver: IKeyResolver
    collectionId: string
    pageSize?: number
  }): Promise<SharedCollectionReader> {
    const encryption = await remoteStore.readCollectionEncryption(collectionId)
    const cipher = await buildSharedCipher({
      collectionId,
      keyAgreementKey,
      keyResolver,
      encryption
    })
    return new SharedCollectionReader({
      collectionId,
      remoteStore,
      keyAgreementKey,
      keyResolver,
      cipher,
      pageSize
    })
  }

  /**
   * Lists the LIVE resources of the shared collection, decrypted. A body that is
   * not an EDV envelope, or one sealed before the collection's first share (a
   * single-recipient envelope this app is not a recipient of), is SKIPPED with a
   * warning rather than failing the whole listing.
   *
   * Two paths, same result. The fast path pages the `changes` feed
   * ({@link SharedCollectionReader.listViaChanges}), which returns whole pages of
   * documents WITH their bodies -- and on an encrypted collection those bodies
   * are exactly the opaque EDV envelopes wanted here, since the feed does not
   * decrypt. That is one round trip per PAGE rather than the one per RESOURCE a
   * listing plus a `get` each would cost, which on a wallet's
   * `private-credentials` or `contacts` is the difference between a handful of
   * requests and one per credential. It is also the same primitive replication
   * pulls with.
   *
   * The slow path ({@link SharedCollectionReader.listViaResources}) is the
   * fallback for a backend that does not advertise the `changes-query` feature
   * (it answers 501, surfaced as `NotImplementedError`): list the resource
   * summaries, then fetch each body. Taken only on that specific error, and
   * warned about once per reader.
   *
   * @returns {Promise<SharedResource[]>}
   */
  async list(): Promise<SharedResource[]> {
    const collection = this.#collectionHandle()
    try {
      return await this.#listViaChanges(collection)
    } catch (err) {
      if (!(err instanceof NotImplementedError)) {
        throw err
      }
      if (!this.#warnedSlowPath) {
        this.#warnedSlowPath = true
        console.warn(
          `Shared collection "${this.collectionId}" is being read the slow ` +
            `way (one request per resource): its backend does not support the ` +
            `"changes-query" feature the paged read path needs.`
        )
      }
      return await this.#listViaResources(collection)
    }
  }

  /**
   * The fast path: walk the `changes` feed page by page, resuming from each
   * page's returned checkpoint, until a page comes back shorter than the
   * requested limit (the feed's "you have caught up" signal). Tombstones
   * (`_deleted`) are skipped, so the result is the LIVE set -- the same
   * semantics the resource-listing path has. A resource that changes more than
   * once within the walk appears under one id, so the last body seen wins.
   */
  async #listViaChanges(collection: Collection): Promise<SharedResource[]> {
    const bodies = new Map<string, Json | undefined>()
    let checkpoint: ChangesCheckpoint | undefined
    for (;;) {
      const page = await collection.changes({
        ...(checkpoint && { checkpoint }),
        limit: this.#pageSize
      })
      for (const document of page.documents) {
        if (document._deleted) {
          bodies.delete(document.id)
          continue
        }
        bodies.set(document.id, document.data as Json | undefined)
      }
      if (page.documents.length < this.#pageSize || !page.checkpoint) {
        break
      }
      checkpoint = page.checkpoint
    }
    const resources: SharedResource[] = []
    for (const [id, body] of bodies) {
      const decrypted = await this.#decryptBody({ id, body: body ?? null })
      if (decrypted !== undefined) {
        resources.push({ id, data: decrypted })
      }
    }
    return resources
  }

  /**
   * The slow path: one listing request for the resource summaries, then one
   * request per resource for its body.
   */
  async #listViaResources(collection: Collection): Promise<SharedResource[]> {
    const listing = await collection.list()
    const items = listing?.items ?? []
    const resources: SharedResource[] = []
    for (const item of items) {
      const body = (await collection.get(item.id)) as Json | null
      const decrypted = await this.#decryptBody({ id: item.id, body })
      if (decrypted !== undefined) {
        resources.push({ id: item.id, data: decrypted })
      }
    }
    return resources
  }

  /**
   * Reads and decrypts one resource of the shared collection by its WAS
   * resource id. Returns `undefined` for a missing resource, a body that is not
   * an EDV envelope, or a pre-share envelope this app cannot decrypt (each
   * warned about, distinguishably).
   *
   * @param resourceId {string}   the WAS resource id
   * @returns {Promise<Json | undefined>}
   */
  async get(resourceId: string): Promise<Json | undefined> {
    const body = (await this.#collectionHandle().get(resourceId)) as Json | null
    return await this.#decryptBody({ id: resourceId, body })
  }

  /**
   * The RAW collection handle: the delegated zcap plus the
   * `encryption: 'plaintext'` override, so `get`/`list` return the stored EDV
   * envelope verbatim instead of routing it through the client's (no-op)
   * encryption provider.
   */
  #collectionHandle(): Collection {
    const capability = this.#remoteStore.collectionCapability(this.collectionId)
    if (!capability) {
      throw new SharedCollectionUnavailableError(
        `No delegated capability covers the shared collection ` +
          `"${this.collectionId}".`
      )
    }
    return this.#remoteStore.was
      .space(this.#remoteStore.spaceId)
      .collection(this.collectionId, { capability, encryption: 'plaintext' })
  }

  /**
   * Decrypts one fetched body, tolerating the two expected non-results: a body
   * that is not an EDV envelope at all, and a pre-share single-recipient
   * envelope. An {@link UnknownEpochError} drives one marker re-read + cipher
   * rebuild + retry (an epoch rotation emits no change-feed entry, so a stale
   * marker is the expected failure mode).
   */
  async #decryptBody({
    id,
    body
  }: {
    id: string
    body: Json | null
  }): Promise<Json | undefined> {
    if (body === null || body === undefined) {
      return undefined
    }
    if (!isEncryptedEnvelope(body)) {
      console.warn(
        `Skipping resource "${id}" of shared collection ` +
          `"${this.collectionId}": its body is not an EDV envelope.`
      )
      return undefined
    }
    try {
      return await this.#cipher.decrypt({ envelope: body })
    } catch (err) {
      if (err instanceof UnknownEpochError && !this.#refreshed) {
        this.#refreshed = true
        await this.#rebuildCipher()
        try {
          return await this.#cipher.decrypt({ envelope: body })
        } catch (retryErr) {
          return this.#skipUndecryptable({ id, err: retryErr })
        }
      }
      return this.#skipUndecryptable({ id, err })
    }
  }

  /**
   * Re-reads the collection's `encryption` marker and rebuilds the cipher from
   * it. Used once per reader on an unknown epoch.
   */
  async #rebuildCipher(): Promise<void> {
    const encryption = await this.#remoteStore.readCollectionEncryption(
      this.collectionId
    )
    this.#cipher = await buildSharedCipher({
      collectionId: this.collectionId,
      keyAgreementKey: this.#keyAgreementKey,
      keyResolver: this.#keyResolver,
      encryption
    })
  }

  /**
   * Warns about, and skips, one envelope this app cannot decrypt. The
   * overwhelmingly likely cause is a resource written BEFORE the collection's
   * first share -- sealed to the owner's key alone, never re-encrypted -- which
   * is expected rather than corruption, so it is called out by name.
   */
  #skipUndecryptable({ id, err }: { id: string; err: unknown }): undefined {
    console.warn(
      `Skipping resource "${id}" of shared collection ` +
        `"${this.collectionId}": this app is not a recipient of its envelope ` +
        `(expected for resources written before the collection was first ` +
        `shared -- those are sealed to the owner alone and are never ` +
        `re-encrypted). ${errorMessage(err)}`
    )
    return undefined
  }
}

/**
 * Builds the epoch-aware cipher for a shared collection, turning the two
 * "cannot read this collection" outcomes into one descriptive error: no
 * multi-recipient roster at all, and a roster this app is not in.
 *
 * Only the cipher's `decrypt` is ever exercised here -- the reader has no write
 * path -- so the seam's write-side id model is irrelevant.
 *
 * @param options {object}
 * @param options.collectionId {string}
 * @param options.keyAgreementKey {IKeyAgreementKey}
 * @param options.keyResolver {IKeyResolver}
 * @param [options.encryption] {CollectionEncryption}
 * @returns {Promise<DocCipher>}
 */
async function buildSharedCipher({
  collectionId,
  keyAgreementKey,
  keyResolver,
  encryption
}: {
  collectionId: string
  keyAgreementKey: IKeyAgreementKey
  keyResolver: IKeyResolver
  encryption?: CollectionEncryption
}): Promise<DocCipher> {
  if (!encryption?.epochs || encryption.epochs.length === 0) {
    throw new SharedCollectionUnavailableError(
      `Shared collection "${collectionId}" carries no key-epoch roster, so it ` +
        `is not multi-recipient and this app cannot be a recipient of it. The ` +
        `wallet has not shared it with this app.`
    )
  }
  try {
    return await createDocCipher({
      keyAgreementKey,
      keyResolver,
      collectionId,
      encryption
    })
  } catch (err) {
    throw new SharedCollectionUnavailableError(
      `Cannot read shared collection "${collectionId}": this app is not a ` +
        `recipient of any of its key epochs. The wallet has not shared it ` +
        `with this app, or access was removed (removing access rotates the ` +
        `epoch off this app's key).`,
      { cause: err }
    )
  }
}
