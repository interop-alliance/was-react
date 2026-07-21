/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The RxDB conflict handler for a mutable-head (LWW) collection. RxDB's default
 * handler always drops the local fork and keeps the remote master, which is
 * correct for content-addressed (immutable-per-id) collections but wrong here:
 * every entity is a mutable head that two devices can edit concurrently, so a
 * genuine content conflict must be settled by last-write-wins on the payload's
 * own `updatedAt` (clientId tiebreak) -- exactly the rule two offline replicas
 * apply independently to converge.
 *
 * The wrinkle is that the conflicting bodies are EDV envelopes (ciphertext), so
 * `resolve` must decrypt both sides through this collection's cipher before it
 * can compare the plaintext `updatedAt` / `clientId`. `isEqual` stays cheap and
 * synchronous (a structural compare of the opaque bodies), as RxDB requires.
 *
 * Convergence: the server holds ONE winner of the push race as `realMasterState`;
 * every replica compares that same master against its own local edit, and the
 * `payloadWins` comparator is a total order over `(updatedAt, clientId)`, so the
 * globally-latest payload wins on every replica with no coordination.
 *
 * The resolution rules, in order:
 *
 * 1. Version-only conflict: when the real master's whole content (`data` +
 *    `custom` + `_deleted`) still equals the assumed master's, the server holds
 *    nothing newer than what this replica last synced -- the 412 came from a
 *    stale `If-Match` (typically our own earlier write racing its feed echo).
 *    The local state (edit or tombstone) is re-asserted and re-pushed against
 *    the corrected version. Without this rule a local delete would be dropped by
 *    rule 5 and the entity would silently resurrect. `custom` MUST be part of
 *    this comparison, or a concurrent metadata-only edit committed on the server
 *    would be misclassified here and clobbered (rule 2 is what settles it).
 * 2. Metadata conflict: `data` and `_deleted` are unchanged from the assumed
 *    master but `custom` differs -- a metadata-only edit committed on the server
 *    since this replica last synced (another device won the `/meta` race).
 *    Metadata carries no LWW timestamp of its own (the payload `updatedAt` lives
 *    in the encrypted `data`, which is equal on both sides here), so there is no
 *    payload to compare; the sound, replica-independent default is that the
 *    server-committed state wins -- the real master is adopted for `custom`.
 *    Without this rule the equal-`data` case would fall through to rule 3, where
 *    the two payloads compare equal and the tie keeps the local (stale) `custom`,
 *    silently clobbering the committed metadata.
 * 3. Both sides carry an LWW payload: pure payload LWW via `payloadWins`.
 * 4. A live local edit vs an incomparable remote (e.g. a remote tombstone):
 *    the edit wins and is re-pushed (resurrection).
 * 5. Everything else -- a local tombstone vs a REAL remote content change, or
 *    both sides incomparable: the master wins. Together with rule 4 this makes
 *    the delete-vs-concurrent-edit rule "the edit wins" on every replica: a
 *    tombstone carries no LWW payload of its own, so a genuine racing edit
 *    deterministically survives, whichever write reached the server first.
 */
import type { WithDeleted } from 'rxdb/plugins/core'
import type { Json, SyncedDoc } from './types.js'
import { remotePayloadWins } from './lww.js'

/**
 * The LWW fields read out of a decrypted entity payload.
 */
interface LwwPayload {
  updatedAt: string
  clientId: string
}

/**
 * Structural equality of two opaque bodies (used for the fast `isEqual`).
 */
function bodiesEqual(a: Json | undefined, b: Json | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

/**
 * Decrypts one side's envelope into its `{ updatedAt, clientId }`, or `null`
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
      typeof payload.clientId === 'string'
    ) {
      return { updatedAt: payload.updatedAt, clientId: payload.clientId }
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
 *   `clientId` breaks a tie)
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
    // Non-async and fast, as RxDB requires. The server revisions (`version` /
    // `metaVersion`) participate deliberately: our own write's feed echo comes
    // back byte-identical but one revision ahead, and it must NOT compare
    // equal, or the higher version is never adopted and every later
    // conditional write sends a stale `If-Match` (a guaranteed 412).
    isEqual(a: WithDeleted<SyncedDoc>, b: WithDeleted<SyncedDoc>): boolean {
      return (
        a._deleted === b._deleted &&
        a.version === b.version &&
        a.metaVersion === b.metaVersion &&
        bodiesEqual(a.data, b.data) &&
        bodiesEqual(a.custom, b.custom)
      )
    },

    async resolve({
      realMasterState,
      newDocumentState,
      assumedMasterState
    }: {
      realMasterState: WithDeleted<SyncedDoc>
      newDocumentState: WithDeleted<SyncedDoc>
      assumedMasterState?: WithDeleted<SyncedDoc>
    }): Promise<WithDeleted<SyncedDoc>> {
      // Rule 1 -- version-only conflict: the master's whole content (`data` +
      // `custom`) is exactly what this replica last synced (only the revision
      // moved, e.g. our own write racing its feed echo), so nothing remote is
      // actually newer. Re-assert the local state -- crucially including a local
      // TOMBSTONE, which rule 5 would otherwise drop (the silent-resurrection
      // bug). `custom` is part of this equality so a concurrent metadata-only
      // edit is NOT misclassified here (rule 2 handles it).
      if (
        assumedMasterState !== undefined &&
        realMasterState._deleted === assumedMasterState._deleted &&
        bodiesEqual(realMasterState.data, assumedMasterState.data) &&
        bodiesEqual(realMasterState.custom, assumedMasterState.custom)
      ) {
        return newDocumentState
      }
      // Rule 2 -- metadata conflict: `data` and `_deleted` are unchanged from
      // the assumed master, but `custom` moved on the server (a metadata-only
      // edit that won the `/meta` race on another device). Metadata has no LWW
      // timestamp of its own -- the payload `updatedAt` lives in `data`, equal
      // on both sides here -- so the sound, replica-independent default is that
      // the server-committed state wins: adopt the real master for `custom`.
      // Without this rule the equal-`data` case would reach rule 3 with two
      // equal payloads and the tie would keep the local (stale) metadata.
      if (
        assumedMasterState !== undefined &&
        realMasterState._deleted === assumedMasterState._deleted &&
        bodiesEqual(realMasterState.data, assumedMasterState.data) &&
        !bodiesEqual(realMasterState.custom, assumedMasterState.custom)
      ) {
        return realMasterState
      }
      const [remote, local] = await Promise.all([
        lwwFieldsOf(realMasterState, decrypt),
        lwwFieldsOf(newDocumentState, decrypt)
      ])
      // Rule 3 -- both sides comparable: pure payload LWW.
      if (remote && local) {
        return payloadWins(remote, local) ? realMasterState : newDocumentState
      }
      // Rule 4 -- a live local edit against a remote tombstone (or otherwise
      // incomparable remote): keep the edit (resurrect / re-assert the write).
      if (local && !remote) {
        return newDocumentState
      }
      // Rule 5 -- everything else (a local tombstone racing a REAL remote
      // content change, or both incomparable): the master wins, which is
      // deterministic and convergent across replicas (the edit survives the
      // delete on every device).
      return realMasterState
    }
  }
}
