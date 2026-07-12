/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Grant parsing and per-collection capability routing for the delegated
 * (relying-party) sync model. The app never provisions the Space and never
 * derives the spaceId itself; instead it receives a set of wallet-delegated
 * zcaps -- minted by a provisioning script during development, or returned by
 * the wallet through CHAPI -- and reads the WAS topology (server URL, space id,
 * per-collection routing) straight out of their `invocationTarget` URLs.
 *
 * Every grant's `invocationTarget` is an absolute WAS URL of the form
 * `<serverUrl>/space/<spaceId>/<collectionId>` (a trailing slash is tolerated).
 * All grants MUST resolve to a single server origin and a single space; a
 * mismatch aborts (a grant set spanning two spaces is never expected and would
 * silently split writes).
 */
import { parseSpaceTarget } from '@interop/was-client'
import type { IZcap } from '@interop/data-integrity-core'

/**
 * The topology parsed out of a delegated grant set: the WAS server origin (the
 * exact string a `WasClient` / `SERVER_URL` must match), the single space id,
 * and the per-collection capability keyed by WAS collection id.
 */
export interface ParsedGrants {
  serverUrl: string
  spaceId: string
  /**
   * Keyed by WAS collection id (e.g. `action-items`).
   */
  byCollectionId: Record<string, IZcap>
}

/**
 * One grant's target, split into server origin + space + collection. A space- or
 * collection-scoped target may omit `collectionId`.
 */
interface ParsedTarget {
  serverUrl: string
  spaceId: string
  collectionId?: string
}

/**
 * Parses a single `invocationTarget` URL into its WAS components. `serverUrl` is
 * the bare origin (`protocol//host`) with no trailing slash, matching the shape
 * the reference server validates `SERVER_URL` into; the path grammar itself is
 * owned by `@interop/was-client`'s `parseSpaceTarget`. A resource-depth target
 * still contributes its collection; a reserved sub-endpoint target (e.g.
 * `/space/:id/policy`) contributes only its server and space.
 *
 * @param target {string}   an absolute WAS URL
 * @returns {ParsedTarget}
 */
export function parseInvocationTarget(target: string): ParsedTarget {
  let url: URL
  try {
    url = new URL(target)
  } catch {
    throw new Error(
      `Grant invocationTarget is not an absolute URL: "${target}".`
    )
  }
  const serverUrl = `${url.protocol}//${url.host}`
  const parsed = parseSpaceTarget({ serverUrl, target })
  if (parsed === null) {
    throw new Error(
      `Grant invocationTarget is not a WAS space URL: "${target}".`
    )
  }
  return {
    serverUrl,
    spaceId: parsed.spaceId,
    ...('collectionId' in parsed && { collectionId: parsed.collectionId })
  }
}

/**
 * Reads a grant's single `invocationTarget` string. `@interop` zcaps carry it as
 * a string; guard defensively (an array or missing target is a malformed grant).
 *
 * @param zcap {IZcap}
 * @returns {string}
 */
function invocationTargetOf(zcap: IZcap): string {
  const target = (zcap as { invocationTarget?: unknown }).invocationTarget
  if (typeof target !== 'string' || target.length === 0) {
    throw new Error('Grant is missing a string invocationTarget.')
  }
  return target
}

/**
 * Parses a delegated grant set into the sync topology. Asserts a single server
 * origin and a single space across every grant, and routes each collection-scoped
 * grant to its WAS collection id. A space-scoped grant (no collection segment)
 * still contributes its server/space but is not added to the routing table.
 *
 * @param zcaps {IZcap[]}   the delegated capabilities
 * @returns {ParsedGrants}
 */
export function parseGrants(zcaps: IZcap[]): ParsedGrants {
  if (zcaps.length === 0) {
    throw new Error('No grants to parse.')
  }
  let serverUrl: string | undefined
  let spaceId: string | undefined
  const byCollectionId: Record<string, IZcap> = {}

  for (const zcap of zcaps) {
    const parsed = parseInvocationTarget(invocationTargetOf(zcap))
    if (serverUrl === undefined) {
      serverUrl = parsed.serverUrl
    } else if (serverUrl !== parsed.serverUrl) {
      throw new Error(
        `Grants span two servers: "${serverUrl}" vs "${parsed.serverUrl}".`
      )
    }
    if (spaceId === undefined) {
      spaceId = parsed.spaceId
    } else if (spaceId !== parsed.spaceId) {
      throw new Error(
        `Grants span two spaces: "${spaceId}" vs "${parsed.spaceId}".`
      )
    }
    if (parsed.collectionId !== undefined) {
      byCollectionId[parsed.collectionId] = zcap
    }
  }

  return {
    serverUrl: serverUrl as string,
    spaceId: spaceId as string,
    byCollectionId
  }
}
