/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * App-session identity bootstrap: everything derivable from the master seed in
 * one call. Thin composition over the pinned derivation in `agents.ts` (which
 * is the shared-key contract: `CapabilityAgent.fromSeed` on raw bytes for the
 * identity, HKDF `info = 'kak:v1:<collectionId>'` for each collection's KAK --
 * never change either without a migration plan).
 *
 * The per-collection KAKs themselves are derived where they are consumed (the
 * local store calls `deriveCollectionKeys` per collection); this module only
 * surfaces the identity/zcap side the auth flow needs.
 */
import { deriveIdentity, type IdentityAgents } from './agents.js'

/**
 * Derives the app's identity agents (stable did:key controller, signer,
 * ZcapClient) from the master seed.
 *
 * @param options {object}
 * @param options.seed {Uint8Array}   the 32-byte master seed
 * @returns {Promise<IdentityAgents>}
 */
export async function initAppSession({
  seed
}: {
  seed: Uint8Array
}): Promise<IdentityAgents> {
  if (seed.length !== 32) {
    throw new Error(`Master seed must be 32 bytes (got ${seed.length}).`)
  }
  return await deriveIdentity({ seed })
}
