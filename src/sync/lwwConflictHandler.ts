/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The RxDB conflict handler for a mutable-head (LWW) collection. RxDB's default
 * handler always drops the local fork and keeps the remote master, which is
 * correct for content-addressed (immutable-per-id) collections but wrong here:
 * every entity is a mutable head that two devices can edit concurrently, so a
 * genuine content conflict must be settled by last-write-wins on the payload's
 * own `updatedAt` (deviceId tiebreak) -- exactly the rule two offline replicas
 * apply independently to converge.
 *
 * The wrinkle is that the conflicting bodies are EDV envelopes (ciphertext), so
 * `resolve` must decrypt both sides through this collection's cipher before it
 * can compare the plaintext `updatedAt` / `deviceId`. `isEqual` stays cheap and
 * synchronous (a structural compare of the opaque bodies), as RxDB requires.
 *
 * Convergence: the server holds ONE winner of the push race as `realMasterState`;
 * every replica compares that same master against its own local edit, and the
 * `payloadWins` comparator is a total order over `(updatedAt, deviceId)`, so the
 * globally-latest payload wins on every replica with no coordination.
 */
import type { WithDeleted } from 'rxdb/plugins/core'
import type { Json, SyncedDoc } from './types.js'
import { remotePayloadWins } from './lww.js'

/** The LWW fields read out of a decrypted entity payload. */
interface LwwPayload {
  updatedAt: string
  deviceId: string
}

/** Structural equality of two opaque bodies (used for the fast `isEqual`). */
function bodiesEqual(a: Json | undefined, b: Json | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

/**
 * Decrypts one side's envelope into its `{ updatedAt, deviceId }`, or `null`
 * when the side has no decryptable payload (a tombstone, or an absent/corrupt
 * body). `null` means "no comparable timestamp", handled by the caller.
 */
async function lwwFieldsOf(
  doc: WithDeleted<SyncedDoc>,
  decrypt: (envelope: Json) => Promise<Json>
): Promise<LwwPayload | null> {
  if (doc._deleted || doc.data === undefined) {
    return null
  }
  try {
    const payload = (await decrypt(doc.data)) as Partial<LwwPayload>
    if (
      typeof payload.updatedAt === 'string' &&
      typeof payload.deviceId === 'string'
    ) {
      return { updatedAt: payload.updatedAt, deviceId: payload.deviceId }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Builds an RxDB conflict handler that settles content conflicts by payload LWW,
 * decrypting through the supplied per-collection `decrypt`.
 *
 * @param decrypt {(envelope: Json) => Promise<Json>}   this collection's decrypt
 * @param [payloadWins] {(remote: LwwPayload, local: LwwPayload) => boolean}
 *   the total-order comparator deciding whether the remote payload replaces the
 *   local one; defaults to {@link remotePayloadWins} (later `updatedAt` wins,
 *   `deviceId` breaks a tie)
 * @returns {import('rxdb/plugins/core').RxConflictHandler<SyncedDoc>}
 */
export function makeLwwConflictHandler(
  decrypt: (envelope: Json) => Promise<Json>,
  payloadWins: (
    remote: LwwPayload,
    local: LwwPayload
  ) => boolean = remotePayloadWins
) {
  return {
    // Non-async and fast, as RxDB requires: no real conflict when the opaque
    // content + deletion flag already agree (e.g. our own write echoing back).
    isEqual(a: WithDeleted<SyncedDoc>, b: WithDeleted<SyncedDoc>): boolean {
      return a._deleted === b._deleted && bodiesEqual(a.data, b.data)
    },

    async resolve({
      realMasterState,
      newDocumentState
    }: {
      realMasterState: WithDeleted<SyncedDoc>
      newDocumentState: WithDeleted<SyncedDoc>
    }): Promise<WithDeleted<SyncedDoc>> {
      const [remote, local] = await Promise.all([
        lwwFieldsOf(realMasterState, decrypt),
        lwwFieldsOf(newDocumentState, decrypt)
      ])
      // Both sides comparable: pure payload LWW.
      if (remote && local) {
        return payloadWins(remote, local) ? realMasterState : newDocumentState
      }
      // A live local edit against a remote tombstone (or otherwise
      // incomparable remote): keep the edit (resurrect / re-assert the write).
      if (local && !remote) {
        return newDocumentState
      }
      // Everything else (local tombstone, both incomparable): the master wins,
      // which is deterministic and convergent across replicas.
      return realMasterState
    }
  }
}
