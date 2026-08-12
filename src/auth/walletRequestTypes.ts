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
import type {
  ICapabilityQueryDetail,
  IDIDAuthenticationQuery,
  IVPRDetails as IUpstreamVPRDetails
} from '@interop/data-integrity-core/vpr'
import type {
  IAppConnectCapabilityQuery,
  IAppConnectQuery as IUpstreamAppConnectQuery
} from '@interop/wallet-core/request'

/**
 * A request for a proof of DID Authentication (a signed VerifiablePresentation
 * over the request's `challenge` / `domain`), and a single requested capability
 * (which actions the RP wants on which storage target, with an optional
 * human-readable `reason` and RP-chosen `referenceId`). Both are owned by
 * `@interop/data-integrity-core`'s VPR vocabulary.
 *
 * @see https://w3c-ccg.github.io/vp-request-spec/#the-did-authentication-query-format
 */
export type { ICapabilityQueryDetail, IDIDAuthenticationQuery }

/**
 * A single App Connect capability request: the existing
 * {@link ICapabilityQueryDetail} shape MINUS `controller` (the wallet fills it
 * with the app-key subject DID it matched or minted) and MINUS `reason` (the
 * wallet's App Connect consent screen supersedes per-grant reason lines).
 */
export type { IAppConnectCapabilityQuery }

/**
 * The body of a Verifiable Presentation Request: one or more queries, plus the
 * `challenge` / `domain` used when a DID Authentication proof is requested.
 * The upstream shape, narrowed to the queries this library emits: `query` is
 * required (every request composed here carries one) and ranges over
 * {@link IVPRQuery}, which adds the App Connect query the upstream union does
 * not carry.
 */
export type IVPRDetails = Omit<IUpstreamVPRDetails, 'query'> & {
  query: IVPRQuery | IVPRQuery[]
}

/**
 * The queries this library composes into a request. The VPR vocabulary leaves
 * the union open for wallet-specific extensions, so App Connect is added here
 * rather than upstream.
 */
export type IVPRQuery = IDIDAuthenticationQuery | IAppConnectQuery

/**
 * The one-popup App Connect query: it names the requesting app -- `name` for
 * the consent screen, and `appUrl`, the application's canonical URL (absolute,
 * fragment-less, same-origin with the request `domain`, in serialized form),
 * which the wallet uses to MATCH an existing app key or MINT a fresh one --
 * alongside the collection grants to delegate to that app key's subject DID.
 * The app identity is scoped to the pair (origin, `appUrl`), so applications
 * sharing an origin keep distinct identities. A wallet that predates this type renders it
 * UNSATISFIABLE (the intended fail-closed behavior -- see `verifyResponse` /
 * `loginFlow`), so an older wallet cannot silently degrade the login.
 *
 * The upstream shape with `capabilityQuery` required: a wallet must tolerate a
 * query that grants nothing, but every request this library composes names the
 * collections it wants.
 *
 * @see https://w3c.github.io/vcalm/ -- AuthorizationCapabilityQuery
 */
export type IAppConnectQuery = IUpstreamAppConnectQuery & {
  capabilityQuery: IAppConnectCapabilityQuery | IAppConnectCapabilityQuery[]
}

export type { IVerifiableCredential, IVerifiablePresentation, IZcap }
