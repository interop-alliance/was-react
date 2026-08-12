/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The local-to-connected adoption merge: copies the anonymous replica's
 * decrypted payloads into the freshly opened connected replica. A copy
 * (decrypt with the anonymous cipher, re-encrypt with the connected cipher) is
 * the only possible mechanism -- the two replicas derive their keys from
 * different seeds, so envelopes are not portable across them.
 *
 * Merge policy, per logical uuid (deterministic, replica-independent):
 * - no connected doc under that uuid: insert.
 * - a connected doc exists: the adopted payload replaces it only when it wins
 *   the same last-write-wins rule replication runs ({@link remotePayloadWins});
 *   a connected doc without LWW fields always loses to a stamped adopted one.
 *
 * Adopted payloads missing `updatedAt`/`writerId` are stamped at adoption time
 * with the session's resolved writer id (the sync layer's conflict resolution
 * requires them); payloads that already carry them keep their original values,
 * so a doc edited long ago does not suddenly outrank fresher remote edits.
 */
import { lwwFields, remotePayloadWins } from '../sync/lww.js'
import type { LocalStore } from './localStore.js'

/**
 * Merges the collected anonymous-replica payloads into `store` (the already
 * open connected replica) under the per-uuid LWW policy above. Runs before the
 * first `hydrateAll`/sync start, so adopted rows enter the entity stores via
 * normal hydration and reach the server as ordinary creates on first push.
 *
 * @param options {object}
 * @param options.store {LocalStore}   the open connected replica
 * @param options.entities {Record<string, Array<{ id: string }>>}   decrypted
 *   payloads per collection key, as collected from the anonymous replica
 * @param options.writerId {string}   the session's resolved LWW writer id
 *   (stamped onto payloads missing their LWW fields, so the repair carries the
 *   same attribution identity as the app's own writes)
 * @returns {Promise<void>}
 */
export async function mergeAdopted({
  store,
  entities,
  writerId
}: {
  store: LocalStore
  entities: Record<string, Array<{ id: string }>>
  writerId: string
}): Promise<void> {
  let stamp: { updatedAt: string; writerId: string } | null = null
  for (const [key, payloads] of Object.entries(entities)) {
    const existing = new Map(
      (await store.listEntities(key)).map(doc => [doc.id, doc])
    )
    for (const payload of payloads) {
      let adopted = payload
      let adoptedLww = lwwFields(payload)
      if (!adoptedLww) {
        stamp ??= { updatedAt: new Date().toISOString(), writerId }
        adopted = { ...payload, ...stamp }
        adoptedLww = stamp
      }
      const current = existing.get(payload.id)
      if (!current) {
        await store.insertEntity(key, adopted)
        continue
      }
      const currentLww = lwwFields(current)
      if (!currentLww || remotePayloadWins(adoptedLww, currentLww)) {
        await store.updateEntity(key, adopted)
      }
    }
  }
}
