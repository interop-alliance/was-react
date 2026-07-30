/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * App-session identity bootstrap: everything derivable from the master seed in
 * one call. Thin composition over the pinned derivation in `agents.ts` (which
 * is the shared-key contract: `CapabilityAgent.fromSeed` on raw bytes, keyName
 * `app-key` -- never change it without a migration plan).
 *
 * The agents it returns carry the app's identity key-agreement key, which is
 * the ONE key every encrypted collection is read with: the local replica's
 * ciphers (`LocalStore.init`) and every key-epoch roster entry the wallet
 * writes for this app alike.
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
