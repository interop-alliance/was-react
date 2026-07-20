/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The app's one JSON-LD document loader: static security contexts plus did:key
 * / did:web resolution (`@interop/security-document-loader`). did:web DIDs on
 * loopback hosts (a local dev WAS server on `localhost` or `127.0.0.1`)
 * resolve over plain http; the resolver handles that natively, so no dev shim
 * is needed here.
 */
import { securityLoader } from '@interop/security-document-loader'

/**
 * The envelope shape returned for every resolved URL.
 */
export type DocumentLoader = (url: string) => Promise<{
  contextUrl: string | null
  document: unknown
  documentUrl: string
}>

const baseLoader = securityLoader({ fetchRemoteContexts: true }).build()

/**
 * Builds the JSON-LD document loader handed to `@interop/vc` issuance and
 * verifier-core verification.
 *
 * @returns {DocumentLoader}
 */
export function createDocumentLoader(): DocumentLoader {
  return baseLoader as DocumentLoader
}
