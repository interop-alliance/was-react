/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The app-side seam between the replication driver and `@interop/was-client`.
 * Delegates to the client's own `createWasSyncPort` -- which owns the WAS URL
 * grammar, the verbatim (codec-bypassing) `was.request()` writes, the `changes`
 * feed pull, the key-epoch header, and the conditional-write ETag handling --
 * and pins the two options this library needs: the collection's delegated
 * capability, and `mapAuthErrors` so a `401` / `403` / the server's masked `404`
 * arrive as a `WasSyncAuthError` the sync controller matches by name.
 *
 * What stays here is the narrowing to a `WasSyncBasePort`: the 412 conflict
 * re-read (`get`) is supplied separately by `withFeedPrimaryRead`
 * (`@interop/was-sync/rxdb`), which resolves the primary state from the
 * changes-feed BODY -- origin-independent, unlike a cross-origin `GET` whose
 * ETag header CORS hides.
 *
 * The session binding no longer builds its port through here: the controller
 * core takes the same two options as port flags and calls the client directly.
 * This wrapper stays as the published seam for a consumer driving replication
 * itself.
 */
import type { WasClient } from '@interop/was-client'
import { createWasSyncPort as createClientSyncPort } from '@interop/was-client/sync'
import type { IZcap } from '@interop/data-integrity-core'
import type {
  SyncCheckpoint,
  WasSyncBasePort,
  WireDoc
} from '@interop/was-sync'

/**
 * Builds a `WasSyncBasePort` bound to a single Space + Collection on the remote
 * WAS server, backed by the session's signed `WasClient`.
 *
 * @param options {object}
 * @param options.was {WasClient}       the session client (holds the signer)
 * @param options.spaceId {string}
 * @param options.collectionId {string}   the WAS collection id (e.g. `public-credentials`)
 * @param [options.capability] {IZcap}   the delegated session capability for
 *   this collection (a restored `delegated` tier session); absent in the full
 *   tier, where requests invoke root capabilities
 * @returns {WasSyncBasePort}
 */
export function createWasSyncPort({
  was,
  spaceId,
  collectionId,
  capability
}: {
  was: WasClient
  spaceId: string
  collectionId: string
  capability?: IZcap
}): WasSyncBasePort {
  const port = createClientSyncPort({
    was,
    spaceId,
    collectionId,
    ...(capability !== undefined && { capability }),
    mapAuthErrors: true
  })
  // The client types `putMeta` as optional (a port may replicate content only);
  // its own implementation always supplies it, and this package's replication
  // always writes the `/meta` half, so require it at the boundary rather than
  // guarding at every call site.
  const { putMeta } = port
  if (putMeta === undefined) {
    throw new Error(
      'The WAS sync port does not implement `putMeta`, which this ' +
        "package's replication requires."
    )
  }

  return {
    async query(options) {
      // The feed page's bodies are `unknown` upstream (a stored body is any
      // JSON, and a future encryption scheme's envelope need not be an EDV
      // document); this layer moves them verbatim as `Json`.
      return (await port.query(options)) as {
        documents: WireDoc[]
        checkpoint: SyncCheckpoint | null
      }
    },

    putContent: options => port.putContent(options),

    deleteContent: options => port.deleteContent(options),

    putMeta: options => putMeta(options)
  }
}
