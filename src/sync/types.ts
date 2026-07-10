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
 */

/**
 * A JSON value -- the opaque stored resource body the sync layer moves verbatim.
 * For a plaintext collection this is the user document; for an encrypted one it
 * is the EDV envelope. The adapter never inspects or transforms it.
 */
export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json }

/**
 * The keyset position in the change feed: the `{ id, updatedAt }` of the last
 * document a pull returned. Passed back verbatim to resume, and used as the
 * RxDB replication checkpoint. `id` is the total-order tiebreaker within a
 * single `updatedAt`.
 */
export interface SyncCheckpoint {
  id: string
  updatedAt: string
}

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
}

/**
 * The current master state of a single resource, as read back for the 412
 * conflict path. `deleted` distinguishes a tombstone from a live resource;
 * `metaVersion` / `custom` are present only once metadata has been written.
 */
export interface MasterState {
  version: number
  updatedAt: string
  deleted: boolean
  metaVersion?: number
  data?: Json
  custom?: Json
}

/**
 * The injected WAS-access seam. An adapter (the app-side `wasSyncPort.ts`)
 * implements this over `@interop/was-client`; the core module depends only on
 * this interface, never on `was-client` itself. Every method moves the stored
 * body verbatim -- no codec, no key handling -- so the same port works for
 * plaintext and encrypted collections alike.
 *
 * `putContent` / `deleteContent` / `putMeta` MUST throw
 * {@link WasSyncConflictError} when the server rejects a conditional write with
 * `412 precondition-failed`, and let every other error propagate so RxDB's
 * retry/backoff handles it.
 */
export interface WasSyncPort {
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
   * the content `version`) for an update-if-unchanged.
   *
   * @param options {object}
   * @param options.id {string}
   * @param options.data {Json}
   * @param [options.ifMatch] {string}
   * @param [options.ifNoneMatch] {boolean}
   * @returns {Promise<void>}
   */
  putContent(options: {
    id: string
    data: Json
    ifMatch?: string
    ifNoneMatch?: boolean
  }): Promise<void>

  /**
   * Conditionally deletes a resource (writes a tombstone; `DELETE /:id`). Pass
   * `ifMatch` (a quoted ETag over the content `version`) to delete only if
   * unchanged.
   *
   * @param options {object}
   * @param options.id {string}
   * @param [options.ifMatch] {string}
   * @returns {Promise<void>}
   */
  deleteContent(options: { id: string; ifMatch?: string }): Promise<void>

  /**
   * Conditionally writes the metadata body verbatim (`PUT /:id/meta`, body
   * `{ custom }`). Pass `ifNoneMatch: true` when the resource has no metadata
   * yet, or `ifMatch` (a quoted ETag over `metaVersion`) for an
   * update-if-unchanged. The resource must already exist (the server does not
   * create a resource from a `/meta` write).
   *
   * @param options {object}
   * @param options.id {string}
   * @param options.custom {Json}
   * @param [options.ifMatch] {string}
   * @param [options.ifNoneMatch] {boolean}
   * @returns {Promise<void>}
   */
  putMeta(options: {
    id: string
    custom: Json
    ifMatch?: string
    ifNoneMatch?: boolean
  }): Promise<void>

  /**
   * Re-reads a single resource's current master state (content + metadata) for
   * the 412 conflict assembler. Returns `null` when the resource is genuinely
   * absent (a delete/delete race).
   *
   * @param options {object}
   * @param options.id {string}
   * @returns {Promise<MasterState | null>}
   */
  get(options: { id: string }): Promise<MasterState | null>
}

/**
 * Thrown by a {@link WasSyncPort} implementation when a conditional write is
 * rejected with `412 precondition-failed` (a lost-update conflict, or a
 * create-if-absent whose target already exists). The core push handler catches
 * exactly this type to trigger the re-read-and-report-conflict path; any other
 * error propagates to RxDB for retry.
 */
export class WasSyncConflictError extends Error {
  constructor(message = 'WAS conditional write precondition failed.') {
    super(message)
    this.name = 'WasSyncConflictError'
  }
}
