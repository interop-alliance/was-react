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
export {
  createPushHandler,
  formatEtag,
  type PushWriteAck
} from './pushWrites.js'
export {
  WasSyncConflictError,
  WasSyncAuthError,
  type Json,
  type SyncCheckpoint,
  type WireDoc,
  type SyncedDoc,
  type MasterState,
  type WasSyncBasePort,
  type WasSyncPort
} from './types.js'
export { createWasSyncPort, errorStatus, errorMessage } from './wasSyncPort.js'
export { withFeedMasterRead } from './feedMasterPort.js'
export {
  createDocCipher,
  isEncryptedEnvelope,
  type DocCipher
} from './docCipher.js'
export { makeLwwConflictHandler } from './lwwConflictHandler.js'
export { lwwFields, remotePayloadWins } from './lww.js'
