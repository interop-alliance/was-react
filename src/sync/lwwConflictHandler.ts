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
 * 3. An UNDECRYPTABLE side (the decrypt threw -- e.g. an envelope written under
 *    a key epoch this device has not seen) is never scored as the loser: it is
 *    presumed newer, not absent. An undecryptable master is adopted (never
 *    re-pushed over with the possibly-older local payload); an undecryptable
 *    local row is re-asserted (the user's edit is not silently dropped); both
 *    undecryptable adopts the master (deterministic and convergent). Each case
 *    is logged -- distinguishable from the intended tombstone/absent-body
 *    `null` the remaining rules were written for.
 * 4. Both sides carry an LWW payload: pure payload LWW via `payloadWins`.
 * 5. A live local edit vs an incomparable remote (e.g. a remote tombstone):
 *    the edit wins and is re-pushed (resurrection).
 * 6. Everything else -- a local tombstone vs a REAL remote content change, or
 *    both sides incomparable: the master wins. Together with rule 5 this makes
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
 * One side's comparability for the LWW rules: `payload` (a decrypted LWW
 * stamp), `none` (a tombstone, an absent body, or a payload carrying no LWW
 * stamp), or `undecryptable` (the decrypt THREW -- e.g. an envelope written
 * under an unseen key epoch). `none` and `undecryptable` are deliberately
 * distinct: the former means "nothing there to compare", the latter means
 * "something is there that this device cannot read", and scoring the two the
 * same silently loses writes.
 */
type LwwSide =
  | { kind: 'payload'; payload: LwwPayload }
  | { kind: 'none' }
  | { kind: 'undecryptable'; err: unknown }

/**
 * Decrypts one side's envelope into its LWW comparability (see {@link LwwSide}).
 */
async function lwwFieldsOf(
  doc: WithDeleted<SyncedDoc>,
  decrypt: (envelope: Json) => Promise<Json>
): Promise<LwwSide> {
  if (doc._deleted || doc.data === undefined) {
    return { kind: 'none' }
  }
  try {
    const payload = (await decrypt(doc.data)) as Partial<LwwPayload>
    if (
      typeof payload.updatedAt === 'string' &&
      typeof payload.clientId === 'string'
    ) {
      return {
        kind: 'payload',
        payload: { updatedAt: payload.updatedAt, clientId: payload.clientId }
      }
    }
    return { kind: 'none' }
  } catch (err) {
    return { kind: 'undecryptable', err }
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
      // Rule 3 -- an undecryptable side is never scored as the loser: it is
      // presumed newer (typically an envelope under an unseen key epoch), not
      // absent. Logged so it is distinguishable from a genuine tombstone.
      if (remote.kind === 'undecryptable' || local.kind === 'undecryptable') {
        if (remote.kind === 'undecryptable' && local.kind !== 'undecryptable') {
          console.warn(
            'LWW conflict: the remote master did not decrypt; adopting it ' +
              'rather than re-pushing the local payload over it.',
            remote.err
          )
          return realMasterState
        }
        if (local.kind === 'undecryptable' && remote.kind !== 'undecryptable') {
          console.warn(
            'LWW conflict: the local row did not decrypt; re-asserting it ' +
              'rather than dropping the local edit for the master.',
            local.err
          )
          return newDocumentState
        }
        console.warn(
          'LWW conflict: neither side decrypted; adopting the master ' +
            '(deterministic and convergent).',
          remote.kind === 'undecryptable' ? remote.err : undefined
        )
        return realMasterState
      }
      // Rule 4 -- both sides comparable: pure payload LWW.
      if (remote.kind === 'payload' && local.kind === 'payload') {
        return payloadWins(remote.payload, local.payload)
          ? realMasterState
          : newDocumentState
      }
      // Rule 5 -- a live local edit against a remote tombstone (or otherwise
      // incomparable remote): keep the edit (resurrect / re-assert the write).
      if (local.kind === 'payload' && remote.kind === 'none') {
        return newDocumentState
      }
      // Rule 6 -- everything else (a local tombstone racing a REAL remote
      // content change, or both incomparable): the master wins, which is
      // deterministic and convergent across replicas (the edit survives the
      // delete on every device).
      return realMasterState
    }
  }
}
