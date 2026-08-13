/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Public surface of the collection-agnostic WAS replication layer. Framework-
 * agnostic: consumers supply an RxDB collection and a {@link WasSyncPort};
 * nothing in the core adapter imports React. The port adapter
 * (`createWasSyncPort`) and the document cipher (`createDocCipher`) bridge to
 * `@interop/was-client`.
 */
export { createWasReplication } from './wasReplication.js'
export { syncedDocSchema } from './syncedDocSchema.js'
export { createPullHandler, wireDocToRxDoc } from './changesQuery.js'
export { createPushHandler, type PushWriteAck } from './pushWrites.js'
export {
  WasSyncConflictError,
  WasSyncAuthError,
  type Json,
  type SyncCheckpoint,
  type WireDoc,
  type SyncedDoc,
  type MasterState,
  type MasterReadCache,
  type WasSyncBasePort,
  type WasSyncPort
} from './types.js'
export { createWasSyncPort } from './wasSyncPort.js'
export { withFeedMasterRead } from './feedMasterPort.js'
export {
  createDocCipher,
  createPlaintextDocCodec,
  createUnprovisionedDocCipher,
  isUnknownEpochError,
  type DocCipher
} from './docCipher.js'
export { makeLwwConflictHandler } from './lwwConflictHandler.js'
export { lwwFields, remotePayloadWins, type LwwFields } from './lww.js'
// Owned by the client's sync subpath and re-exported verbatim, so the names this
// package's consumers already import stay put.
export {
  errorStatus,
  errorMessage,
  formatEtag,
  isEncryptedEnvelope
} from '@interop/was-client/sync'
// The crypto-free predicates over a collection's encryption descriptor, owned by
// the client's EDV subpath and re-exported verbatim for the same reason.
export { hasKeyEpochs, epochRostersEqual } from '@interop/was-client/edv'
