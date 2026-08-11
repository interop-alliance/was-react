/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The relying-party side of the VC API request vocabulary: the Verifiable
 * Presentation Request this library composes for a wallet, and the queries it
 * carries.
 *
 * The request travels today via a CHAPI popup, but the shapes are transport
 * agnostic, so the same compose logic can later back other entry points (a QR
 * scan, an exchange-URL POST) without dragging React or CHAPI along. Only the
 * types this library actually emits or consumes live here; the wallet-side
 * message/response/classification shapes belong to the wallet.
 *
 * @see https://w3c-ccg.github.io/vp-request-spec/
 */
import type {
  IVerifiableCredential,
  IVerifiablePresentation,
  IZcap
} from '@interop/data-integrity-core'

/**
 * The body of a Verifiable Presentation Request: one or more queries, plus the
 * `challenge` / `domain` used when a DID Authentication proof is requested.
 */
export type IVPRDetails = {
  query: IVPRQuery | IVPRQuery[]
  challenge?: string
  domain?: string
}

export type IVPRQuery = IDIDAuthenticationQuery | IAppConnectQuery

/**
 * A request for a proof of DID Authentication (a signed VerifiablePresentation
 * over the request's `challenge` / `domain`).
 *
 * @see https://w3c-ccg.github.io/vp-request-spec/#the-did-authentication-query-format
 */
export type IDIDAuthenticationQuery = {
  type: 'DIDAuthentication'
  acceptedMethods?: Array<{ method: string }>
  acceptedCryptosuites?: Array<{ cryptosuite: string }>
}

/**
 * A single requested capability: which actions (`allowedAction`) the RP
 * (`controller`) wants on which storage target (`invocationTarget`), with an
 * optional human-readable `reason` and RP-chosen `referenceId`. The
 * `invocationTarget` is either a plain URL (satisfied only under the user's own
 * Space) or a wallet-defined descriptor object
 * (`https://w3id.org/byoe#private-collection`), resolved by
 * `resolveInvocationTarget`. Login requests only ever ask for
 * collection-scoped capabilities.
 */
export type ICapabilityQueryDetail = {
  referenceId?: string
  reason?: string
  allowedAction?: string | string[]
  controller: string
  invocationTarget: string | { type: string; name?: string }
}

/**
 * A single App Connect capability request: the existing
 * {@link ICapabilityQueryDetail} shape MINUS `controller` (the wallet fills it
 * with the app-key subject DID it matched or minted) and MINUS `reason` (the
 * wallet's App Connect consent screen supersedes per-grant reason lines).
 */
export type IAppConnectCapabilityQuery = Omit<
  ICapabilityQueryDetail,
  'controller' | 'reason'
>

/**
 * The one-popup App Connect query: it names the requesting app (for the consent
 * screen) and the seed-credential naming the wallet needs to MATCH an existing
 * app key or MINT a fresh one, alongside the collection grants to delegate to
 * that app key's subject DID. A wallet that predates this type renders it
 * UNSATISFIABLE (the intended fail-closed behavior -- see `verifyResponse` /
 * `loginFlow`), so an older wallet cannot silently degrade the login.
 *
 * @see https://w3c.github.io/vcalm/ -- AuthorizationCapabilityQuery
 */
export type IAppConnectQuery = {
  type: 'AppConnectQuery'
  app: {
    name: string
    credentialType: string
    vocabBase: string
  }
  capabilityQuery: IAppConnectCapabilityQuery | IAppConnectCapabilityQuery[]
}

export type { IVerifiableCredential, IVerifiablePresentation, IZcap }
