/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The local-to-connected adoption merge: copies the anonymous replica's
 * decrypted payloads into the freshly opened connected replica. A copy
 * (decrypt with the anonymous cipher, re-encrypt with the connected cipher) is
 * the only possible mechanism -- the two replicas derive their per-collection
 * keys from different seeds, so envelopes are not portable across them.
 *
 * Merge policy, per logical uuid (deterministic, replica-independent):
 * - no connected doc under that uuid: insert.
 * - a connected doc exists: the adopted payload replaces it only when it wins
 *   the same last-write-wins rule replication runs ({@link remotePayloadWins});
 *   a connected doc without LWW fields always loses to a stamped adopted one.
 *
 * Adopted payloads missing `updatedAt`/`deviceId` are stamped at adoption time
 * (the sync layer's conflict resolution requires them); payloads that already
 * carry them keep their original values, so a doc edited long ago does not
 * suddenly outrank fresher remote edits.
 */
import { uuidv7 } from 'uuidv7'
import { lwwFields, remotePayloadWins } from '../sync/lww.js'
import { getDeviceId } from './storageManager.js'
import type { LocalStore } from './localStore.js'

/**
 * The one-per-merge stamp applied to payloads missing their LWW fields.
 *
 * @returns {{ updatedAt: string, deviceId: string }}
 */
function adoptionStamp(): { updatedAt: string; deviceId: string } {
  let deviceId: string
  try {
    deviceId = getDeviceId()
  } catch {
    // No localStorage (non-browser environments): an unpersisted id still
    // gives the LWW tiebreak a deterministic value for this merge.
    deviceId = uuidv7()
  }
  return { updatedAt: new Date().toISOString(), deviceId }
}

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
 * @returns {Promise<void>}
 */
export async function mergeAdopted({
  store,
  entities
}: {
  store: LocalStore
  entities: Record<string, Array<{ id: string }>>
}): Promise<void> {
  let stamp: { updatedAt: string; deviceId: string } | null = null
  for (const [key, payloads] of Object.entries(entities)) {
    const existing = new Map(
      (await store.listEntities(key)).map(doc => [doc.id, doc])
    )
    for (const payload of payloads) {
      let adopted = payload
      let adoptedLww = lwwFields(payload)
      if (!adoptedLww) {
        stamp ??= adoptionStamp()
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
