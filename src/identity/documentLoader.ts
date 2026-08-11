/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The app's one JSON-LD document loader: static security contexts plus did:key
 * / did:web / did:webvh resolution. The resolver starts from
 * `@interop/security-document-loader`'s default did:key + did:web driver set
 * and adds the `@interop/did-method-webvh` driver, so a wallet may present its
 * VP holder as a did:webvh (signed with a `<did:webvh>#<key>` verification
 * method) and verification still resolves it. webvh resolution stays VERIFIED
 * resolution: the driver's default history-log verifier (hash chain + entry
 * proofs) is active, so a tampered `did.jsonl` fails closed. DIDs on loopback
 * hosts (a local dev server) resolve over plain http; both the did:web
 * resolver and the webvh driver's `did.jsonl` fetch handle that natively, so
 * no dev shim is needed here.
 */
import { createDidWebvhDriver } from '@interop/did-method-webvh/driver'
import {
  createDefaultDidResolver,
  securityLoader
} from '@interop/security-document-loader'
import { contexts as byoeContexts } from 'byoe-context'

/**
 * The envelope shape returned for every resolved URL.
 */
export type DocumentLoader = (url: string) => Promise<{
  contextUrl: string | null
  document: unknown
  documentUrl: string
}>

const didResolver = createDefaultDidResolver()
// The webvh driver is resolution-only (`{ method, get, resolveDID }`) by
// design; did-io's DidMethodDriver type also demands the key-generation
// surface (generate, fromKeyPair, ...), which resolution never calls.
didResolver.use(
  createDidWebvhDriver() as unknown as Parameters<typeof didResolver.use>[0]
)

const loader = securityLoader({
  fetchRemoteContexts: true,
  didResolver
})
// The BYOE App Connect context is registered here, not bundled in the security
// loader, so vocabulary additions ship with a `byoe-context` bump alone.
for (const [url, context] of byoeContexts) {
  loader.addStatic(url, context)
}
const baseLoader = loader.build()

/**
 * Builds the JSON-LD document loader handed to `@interop/vc` issuance and
 * verifier-core verification.
 *
 * @returns {DocumentLoader}
 */
export function createDocumentLoader(): DocumentLoader {
  return baseLoader as DocumentLoader
}
