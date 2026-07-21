/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The last-write-wins tiebreak for a mutable head document. Pure -- no React, no
 * storage imports -- so both replicas run this identical rule against the same
 * two payloads and converge on the same winner with no coordination.
 *
 * `updatedAt` (an ISO-8601 string, so lexical compare == chronological compare)
 * decides; `clientId` breaks an exact tie deterministically. Both fields live in
 * the payload (never the envelope-level checkpoint `updatedAt`).
 */

/**
 * Whether the remote payload wins over the local one under last-write-wins.
 * Later `updatedAt` wins; on an exact `updatedAt` tie the lexically greater
 * `clientId` wins (an arbitrary but deterministic, replica-independent choice).
 *
 * @param remote {{ updatedAt: string; clientId: string }}
 * @param local {{ updatedAt: string; clientId: string }}
 * @returns {boolean}   true if the remote payload should replace the local one
 */
export function remotePayloadWins(
  remote: { updatedAt: string; clientId: string },
  local: { updatedAt: string; clientId: string }
): boolean {
  if (remote.updatedAt !== local.updatedAt) {
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
