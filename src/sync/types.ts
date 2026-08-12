/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Shared types for the collection-agnostic WAS replication adapter.
 *
 * The adapter drives an RxDB `replicateRxCollection` state machine against a
 * remote WAS Collection's replication endpoints. It is deliberately free of any
 * React or app imports so it can stand alone; all WAS access is injected through
 * the {@link WasSyncPort} seam rather than importing `@interop/was-client`
 * directly.
 *
 * The wire contract follows the WAS `changes` feed and its V2 encrypted-metadata
 * profile: a synced document carries both a content revision (`version` /
 * `data`) and an independently-versioned metadata sub-resource (`metaVersion` /
 * `custom`). A metadata-only edit re-surfaces the resource with a bumped
 * `updatedAt` / `metaVersion` but unchanged `version` / `data`. The sync layer
 * moves both bodies opaquely: `data` is the stored content body (plaintext JSON,
 * or the EDV envelope on an encrypted collection) and `custom` is the stored
 * metadata body (an opaque envelope on an encrypted collection); encrypt/decrypt
 * stays a read/write-time concern above this layer.
 *
 * The two small helpers that travel with these shapes live here as well: the
 * opaque-body equality every routing decision is made on, and the optional-field
 * copy every wire-to-local mapping runs.
 */
import type { Json } from '@interop/was-client'
import type {
  MasterState as ClientMasterState,
  SyncCheckpoint as ClientSyncCheckpoint
} from '@interop/was-client/sync'

/**
 * The typed port signals, owned by `@interop/was-client` (its sync port raises
 * them) and re-exported here so the names this package's consumers already
 * import stay put -- and so an `instanceof` check anywhere in this package
 * matches the very class the port throws.
 *
 * `WasSyncConflictError` marks a conditional write rejected with `412
 * precondition-failed` (a lost-update conflict, or a create-if-absent whose
 * target already exists); the push handler catches exactly it to trigger the
 * re-read-and-report-conflict path. `WasSyncAuthError` marks a request refused
 * on authorization grounds -- `401`, `403`, or the `404` a WAS server masks a
 * failed capability invocation as, which on the sync paths (where the invoked
 * collection is known to exist) means the invocation was rejected. It keeps the
 * offending HTTP status on `status`, which the `/meta` push path reads to tell
 * a masked denial from an ordinary delete race.
 */
export {
  WasSyncAuthError,
  WasSyncConflictError
} from '@interop/was-client/sync'

/**
 * A JSON value -- the opaque stored resource body the sync layer moves verbatim.
 * For a plaintext collection this is the user document; for an encrypted one it
 * is the EDV envelope. The adapter never inspects or transforms it. Re-exported
 * from `@interop/was-client`, which owns the wire model, so a body crosses the
 * port boundary without a cast.
 */
export type { Json }

/**
 * The optional half of a synced document, shared verbatim by every shape it
 * travels in ({@link WireDoc} on the feed, {@link SyncedDoc} locally,
 * {@link MasterState} on the conflict re-read): the independently-versioned
 * metadata revision and body, the content body, and the content body's
 * key-epoch stamp. Each is genuinely absent rather than `undefined` when the
 * server has nothing for it, so every mapping between the shapes copies them
 * conditionally -- see {@link copyOptionalBodyFields}.
 */
export interface OptionalBodyFields {
  metaVersion?: number
  data?: Json
  custom?: Json
  epoch?: string
}

/**
 * Structural equality over two opaque bodies, by canonical-free JSON string.
 * Decides whether the content or the metadata half changed -- which endpoint(s)
 * a push writes, and whether two states compare equal for conflict resolution.
 * Content-addressed collections never mutate `data` for a given id, and a real
 * metadata edit re-encrypts to fresh bytes, so this coarse comparison suffices.
 *
 * @param left {Json | undefined}
 * @param right {Json | undefined}
 * @returns {boolean}
 */
export function bodiesEqual(
  left: Json | undefined,
  right: Json | undefined
): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
}

/**
 * Copies the {@link OptionalBodyFields} that are present on `source` onto
 * `target`, leaving an absent field absent (never writing an explicit
 * `undefined`, which would surface the key in a serialized body). The single
 * place every wire-to-local, feed-to-master, and master-to-conflict mapping
 * shares, so a new optional wire field is added once.
 *
 * @param options {object}
 * @param options.source {OptionalBodyFields}
 * @param options.target {OptionalBodyFields}   mutated in place
 * @returns {void}
 */
export function copyOptionalBodyFields({
  source,
  target
}: {
  source: OptionalBodyFields
  target: OptionalBodyFields
}): void {
  if (source.data !== undefined) {
    target.data = source.data
  }
  if (source.metaVersion !== undefined) {
    target.metaVersion = source.metaVersion
  }
  if (source.custom !== undefined) {
    target.custom = source.custom
  }
  if (source.epoch !== undefined) {
    target.epoch = source.epoch
  }
}

/**
 * The keyset position in the change feed: the `{ id, updatedAt }` of the last
 * document a pull returned. Passed back verbatim to resume, and used as the
 * RxDB replication checkpoint. `id` is the total-order tiebreaker within a
 * single `updatedAt`. The client's own checkpoint type, aliased here so the
 * replication layer and the port agree by construction.
 */
export type SyncCheckpoint = ClientSyncCheckpoint

/**
 * One document as it travels on the `changes` feed wire
 * (`POST /space/:s/:c/query`, profile `changes`). `id` is the WAS resourceId,
 * `version` is the content master revision (feeds the content push `If-Match`
 * ETag) and the user content body is nested under `data`; `metaVersion` is the
 * independent metadata revision (feeds the `/meta` push `If-Match` ETag) and the
 * user-writable metadata body is under `custom`. A tombstone carries
 * `_deleted: true` with no `data`. `metaVersion` / `custom` are present only
 * once metadata has been written for the resource.
 */
export interface WireDoc {
  id: string
  _deleted: boolean
  updatedAt: string
  version: number
  metaVersion?: number
  data?: Json
  custom?: Json
  /**
   * The opaque key-epoch id the content body was encrypted under (the
   * `key-epochs` feature), present when the server holds a stamp for the
   * resource. Moved verbatim; the sync layer never interprets it.
   */
  epoch?: string
}

/**
 * The local RxDB document shape, shared across every synced collection. The
 * envelope fields are top-level (`id` primary key, `updatedAt` the checkpoint
 * sort field, `version` / `metaVersion` the server master revisions); the user
 * bodies stay nested (`data` for content, `custom` for metadata) to avoid field
 * collisions. `_deleted` is managed by RxDB via `deletedField` and so is not
 * part of this "clean" shape (handlers work with RxDB's `WithDeleted<SyncedDoc>`).
 */
export interface SyncedDoc {
  id: string
  updatedAt: string
  version: number
  metaVersion?: number
  data?: Json
  custom?: Json
  /**
   * The opaque key-epoch id `data` was encrypted under, when known (stamped by
   * the encrypting cipher on a local write, or pulled off the feed). Sent as
   * the `Key-Epoch` header on the content push so the server's stamp stays
   * in step with the envelope.
   */
  epoch?: string
}

/**
 * The current master state of a single resource, as read back for the 412
 * conflict path: the client's own `MasterState` (content `version` /
 * `updatedAt`, plus the optional `metaVersion` / `data` / `custom` /
 * `createdBy` / `epoch`) plus the `deleted` flag that distinguishes a tombstone
 * from a live resource. The flag is required here because this package resolves
 * the master from the changes feed, where a tombstone travels as a document
 * rather than as an absent read.
 */
export interface MasterState extends ClientMasterState {
  deleted: boolean
}

/**
 * The short-lived master-read memo the rows of ONE push batch share. A
 * resolving `get` implementation may answer from `byId` and MUST record every
 * master it resolved on the way there; a feed-walking implementation pages past
 * all of them anyway, so a batch of k conflicts costs one walk instead of k.
 *
 * `inFlight` is what makes that hold under concurrency: the batch's rows push in
 * parallel, so without it every row would start its own walk before the first
 * one finished and the memo would never be read. A `get` that must walk
 * publishes its walk here; a `get` that finds a walk already running awaits it
 * and re-checks `byId` first. It settles (never rejects) so one row's failed
 * read is not another row's, and is `null` whenever no walk is running.
 *
 * The whole object is created per batch invocation and dropped with it: a memo
 * held across batches would go stale.
 */
export interface MasterReadCache {
  byId: Map<string, MasterState | null>
  inFlight: Promise<void> | null
}

/**
 * The write/query half of the injected WAS-access seam. An adapter (the app-side
 * `createWasSyncPort`) implements this over `@interop/was-client`; the core
 * module depends only on this interface, never on `was-client` itself. Every
 * method moves the stored body verbatim -- no codec, no key handling -- so the
 * same port works for plaintext and encrypted collections alike.
 *
 * `putContent` / `deleteContent` / `putMeta` MUST throw
 * {@link WasSyncConflictError} when the server rejects a conditional write with
 * `412 precondition-failed`, and let every other error propagate so RxDB's
 * retry/backoff handles it.
 *
 * The 412 conflict re-read (`get`) is deliberately NOT part of this base:
 * `createWasSyncPort` returns a `WasSyncBasePort`, and `withFeedMasterRead`
 * supplies a `get` that resolves the master state from the changes-feed body
 * (origin-independent) to produce a full {@link WasSyncPort}.
 */
export interface WasSyncBasePort {
  /**
   * Pulls one page of the `changes` feed. Omit `checkpoint` for the first page.
   * Returns the page's `documents` and its resume `checkpoint`, or
   * `checkpoint: null` for an empty (no-change) page.
   *
   * @param options {object}
   * @param [options.checkpoint] {SyncCheckpoint}   resume position
   * @param options.limit {number}                  requested batch size
   * @returns {Promise<{ documents: WireDoc[], checkpoint: SyncCheckpoint | null }>}
   */
  query(options: { checkpoint?: SyncCheckpoint; limit: number }): Promise<{
    documents: WireDoc[]
    checkpoint: SyncCheckpoint | null
  }>

  /**
   * Conditionally writes the content body verbatim (`PUT /:id`). Pass
   * `ifNoneMatch: true` for a create-if-absent, or `ifMatch` (a quoted ETag over
   * the content `version`) for an update-if-unchanged. `epoch` is the opaque
   * key-epoch id the body was encrypted under, sent as the `Key-Epoch`
   * header (an absent epoch clears any prior stamp on the server, per the
   * `key-epochs` feature). Returns the new content `version` parsed from the
   * response ETag (the acked master revision), or `undefined` when the server
   * does not supply one.
   *
   * @param options {object}
   * @param options.id {string}
   * @param options.data {Json}
   * @param [options.ifMatch] {string}
   * @param [options.ifNoneMatch] {boolean}
   * @param [options.epoch] {string}
   * @returns {Promise<number | undefined>}
   */
  putContent(options: {
    id: string
    data: Json
    ifMatch?: string
    ifNoneMatch?: boolean
    epoch?: string
  }): Promise<number | undefined>

  /**
   * Conditionally deletes a resource (writes a tombstone; `DELETE /:id`). Pass
   * `ifMatch` (a quoted ETag over the content `version`) to delete only if
   * unchanged. Returns the tombstone `version` parsed from the response ETag
   * when the server supplies one (the reference server does not). MUST treat a
   * `404` as success (resolve `undefined`): the resource is already absent --
   * a row deleted locally before its first push, or deleted remotely first --
   * so the tombstone's goal state holds; rejecting would wedge the push batch
   * in RxDB's retry loop.
   *
   * @param options {object}
   * @param options.id {string}
   * @param [options.ifMatch] {string}
   * @returns {Promise<number | undefined>}
   */
  deleteContent(options: {
    id: string
    ifMatch?: string
  }): Promise<number | undefined>

  /**
   * Conditionally writes the metadata body verbatim (`PUT /:id/meta`, body
   * `{ custom }`). An ABSENT `custom` writes the CLEARED state (a body with no
   * `custom` member -- the server's metadata replace clears every property the
   * body omits), so removing a resource's metadata replicates rather than being
   * skipped. Pass `ifNoneMatch: true` when the resource has no metadata yet, or
   * `ifMatch` (a quoted ETag over `metaVersion`) for an update-if-unchanged.
   * The resource must already exist (the server does not create a resource from
   * a `/meta` write). Returns the new `metaVersion` parsed from the response
   * ETag, or `undefined` when the server does not supply one.
   *
   * @param options {object}
   * @param [options.custom] {Json}   absent = write the cleared state
   * @param options.id {string}
   * @param [options.ifMatch] {string}
   * @param [options.ifNoneMatch] {boolean}
   * @returns {Promise<number | undefined>}
   */
  putMeta(options: {
    id: string
    custom?: Json
    ifMatch?: string
    ifNoneMatch?: boolean
  }): Promise<number | undefined>
}

/**
 * The full sync port the core consumes: a {@link WasSyncBasePort}'s write/query
 * methods plus the `get` used by the 412 conflict assembler. The push handler
 * and `createWasReplication` require this full port; build one by wrapping a
 * base port with `withFeedMasterRead`, which supplies `get`.
 */
export interface WasSyncPort extends WasSyncBasePort {
  /**
   * Re-reads a single resource's current master state (content + metadata) for
   * the 412 conflict assembler. Returns `null` when the resource is genuinely
   * absent (a delete/delete race); throws a retryable error when the master
   * cannot be resolved (e.g. a feed re-read that exhausts its scan budget), so
   * the replication cycle retries rather than fabricating a false tombstone.
   *
   * `cache` is an OPTIONAL {@link MasterReadCache}, shared by the rows of one
   * push batch (see its own docs for the contract). A hit is no staler than a
   * read issued at the same moment, since the memo lives only for that batch. An
   * implementation that ignores it is fully conformant, and a caller that omits
   * it gets an uncached read.
   *
   * @param options {object}
   * @param options.id {string}
   * @param [options.cache] {MasterReadCache}
   * @returns {Promise<MasterState | null>}
   */
  get(options: {
    id: string
    cache?: MasterReadCache
  }): Promise<MasterState | null>
}
