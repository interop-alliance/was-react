/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The last-write-wins tiebreak for a mutable head document. Pure -- no React, no
 * storage imports -- so both replicas run this identical rule against the same
 * two payloads and converge on the same winner with no coordination.
 *
 * `updatedAt` (an ISO-8601 string) decides, compared CHRONOLOGICALLY (parsed to
 * epoch ms, never lexically -- `updatedAt` is app-owned, so mixed precision like
 * `...05Z` vs `...05.400Z`, or a `+00:00` offset, must still order by instant);
 * `clientId` breaks an exact-instant tie deterministically. Both fields live in
 * the payload (never the envelope-level checkpoint `updatedAt`).
 */

/**
 * Parses an ISO-8601 `updatedAt` into epoch ms, or `null` when unparseable.
 */
function parseInstant(updatedAt: string): number | null {
  const ms = Date.parse(updatedAt)
  return Number.isNaN(ms) ? null : ms
}

/**
 * Whether the remote payload wins over the local one under last-write-wins.
 * The chronologically later `updatedAt` wins; on an exact-instant tie the
 * lexically greater `clientId` wins (an arbitrary but deterministic,
 * replica-independent choice).
 *
 * Unparseable `updatedAt` values are rejected as losers: a side whose stamp
 * does not parse loses to one whose stamp does (a replica-independent rule, so
 * every device converges on the same winner). When neither side parses, the
 * lexical compare of the raw strings is the deterministic fallback.
 *
 * @param remote {{ updatedAt: string; clientId: string }}
 * @param local {{ updatedAt: string; clientId: string }}
 * @returns {boolean}   true if the remote payload should replace the local one
 */
export function remotePayloadWins(
  remote: { updatedAt: string; clientId: string },
  local: { updatedAt: string; clientId: string }
): boolean {
  const remoteMs = parseInstant(remote.updatedAt)
  const localMs = parseInstant(local.updatedAt)
  if (remoteMs !== null && localMs !== null) {
    if (remoteMs !== localMs) {
      return remoteMs > localMs
    }
  } else if (remoteMs !== null || localMs !== null) {
    // Exactly one side parses: the parseable stamp wins.
    return remoteMs !== null
  } else if (remote.updatedAt !== local.updatedAt) {
    // Neither parses: fall back to the deterministic lexical compare.
    return remote.updatedAt > local.updatedAt
  }
  return remote.clientId > local.clientId
}

/**
 * Reads the LWW fields off a doc when it carries them. Storage payloads are
 * generic over `{ id: string }`, so docs without `updatedAt`/`clientId` are
 * legal; callers fall back to their own rule for those.
 *
 * @param doc {unknown}
 * @returns {{ updatedAt: string, clientId: string } | null}
 */
export function lwwFields(
  doc: unknown
): { updatedAt: string; clientId: string } | null {
  const { updatedAt, clientId } = doc as {
    updatedAt?: unknown
    clientId?: unknown
  }
  return typeof updatedAt === 'string' && typeof clientId === 'string'
    ? { updatedAt, clientId }
    : null
}
