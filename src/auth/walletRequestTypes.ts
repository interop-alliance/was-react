/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * VC API message types for external messages to the wallet -- either offers of
 * credentials (`IVpOffer`) or requests for credentials / DID Authentication
 * (`IVpRequest`).
 *
 * These messages arrive today via CHAPI popups, but the shapes are transport
 * agnostic so the same classification/compose logic can later back other entry
 * points (QR scan, paste-into-Add-Credential) without dragging React or CHAPI
 * along.
 *
 * @see https://w3c-ccg.github.io/vp-request-spec/
 */
import type {
  IVerifiableCredential,
  IVerifiablePresentation,
  IZcap
} from '@interop/data-integrity-core'

/**
 * The union of VC API message types the wallet can classify. Zcap and exchange
 * invitation / issue request messages are deferred to later work.
 */
export type WalletAPIMessage = IVPRequest | IVPOffer

/**
 * "I'm offering the following credentials" -- a Verifiable Presentation offered
 * to the wallet for storage.
 *
 * @see https://vcplayground.org/docs/n/chapi/wallets/native/#vc-api
 */
export type IVPOffer = {
  credentialRequestOrigin?: string
  verifiablePresentation: IVerifiablePresentation
  redirectUrl?: string
}

/**
 * "The following things are requested" -- a Verifiable Presentation Request
 * asking the wallet to share credentials and/or prove DID Authentication.
 *
 * @see https://w3c-ccg.github.io/vp-request-spec/
 */
export type IVPRequest = {
  credentialRequestOrigin?: string
  verifiablePresentationRequest: IVPRDetails
  redirectUrl?: string
}

/**
 * The body of a Verifiable Presentation Request: one or more queries, plus the
 * `challenge` / `domain` used when a DID Authentication proof is requested.
 */
export type IVPRDetails = {
  query: IVPRQuery | IVPRQuery[]
  challenge?: string
  domain?: string
}

export type IVPRQuery = IQueryByExample | IDIDAuthenticationQuery | IZcapQuery

/**
 * A request for one or more VCs matching an example credential shape.
 *
 * @see https://w3c-ccg.github.io/vp-request-spec/#query-by-example
 */
export type IQueryByExample = {
  type: 'QueryByExample'
  acceptedCryptosuites?: Array<{ cryptosuite: string }>
  credentialQuery: {
    reason?: string
    example: {
      '@context'?: string | object | Array<string | object>
      type?: string | string[]
      issuer?: string | object | Array<string | object>
      [x: string]: unknown
    }
  }
}

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
 * A request for one or more delegated capabilities (zcaps) on the user's WAS
 * storage. `AuthorizationCapabilityQuery` is the canonical type string (VCALM
 * §3.4.4); `ZcapQuery` is a legacy alias sent by DCW / the
 * `wallet-to-webapp-demo`. `capabilityQuery` may be a single detail object or
 * an array of them.
 *
 * @see https://w3c.github.io/vcalm/ -- AuthorizationCapabilityQuery
 */
export type IZcapQuery = {
  type: 'AuthorizationCapabilityQuery' | 'ZcapQuery'
  capabilityQuery: ICapabilityQueryDetail | ICapabilityQueryDetail[]
  challenge?: string
}

/**
 * A single requested capability: which actions (`allowedAction`) the RP
 * (`controller`) wants on which storage target (`invocationTarget`), with an
 * optional human-readable `reason` and RP-chosen `referenceId`. The
 * `invocationTarget` is either a plain URL (satisfied only under the user's own
 * Space) or a wallet-defined descriptor object (`urn:was:collection`), resolved
 * by `resolveInvocationTarget`. Login requests only ever ask for
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
 * The wallet's response to a request, delivered by whichever transport received
 * it (CHAPI `respondWith`, a future exchange-URL POST, etc). Delegated zcaps
 * ride *inside* the response VP (as a `zcap` array, embedded before signing),
 * so this shape stays credential-presentation only.
 */
export type WalletResponse = {
  verifiablePresentation?: IVerifiablePresentation
}

/**
 * A VP Request classified on two independent axes: whether DID Authentication
 * is requested, and separately what content is asked for (credentials and/or
 * capability delegations). Any combination is valid, including zcap-only. The
 * consent screen renders one section per non-empty axis; the two axes replace
 * the former `'vc' | 'didauth' | 'vc+didauth'` cross-product enum.
 */
export type WalletRequestProfile = {
  didAuth: boolean
  vcQueries: IQueryByExample[]
  zcapRequests: ICapabilityQueryDetail[]
}

export type { IVerifiableCredential, IVerifiablePresentation, IZcap }
