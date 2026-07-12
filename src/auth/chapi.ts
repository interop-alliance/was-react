/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/// <reference types="vite/client" />
/**
 * The CHAPI transport: credential-handler-polyfill loading (authn.io mediator)
 * plus thin `get()` / `store()` wrappers around `navigator.credentials`.
 *
 * E2E seam (non-production builds only): the real CHAPI channel needs the
 * mediator's cross-origin handshake, which a test harness cannot perform.
 * When a Playwright spec sets `window.__WAS_REACT_E2E_CHAPI__ = true` (via
 * addInitScript), requests are queued on `window.__WAS_REACT_E2E_CHAPI_REQUESTS__`
 * instead; the spec observes them, drives the wallet page directly (using
 * freewallet's own `__E2E_CHAPI_GET_EVENT__` injection), and posts the wallet
 * response into `window.__WAS_REACT_E2E_CHAPI_RESPONSES__[id]`. Responses use
 * the CHAPI WebCredential wire shape `{ dataType, data } | null`.
 */
import { loadOnce, WebCredential } from 'credential-handler-polyfill'
import type { IVerifiablePresentation } from '@interop/data-integrity-core'
import type { IVPRDetails } from './walletRequestTypes.js'

/**
 * The default CHAPI mediator base; the requesting origin is appended at load.
 */
export const DEFAULT_MEDIATOR_BASE = 'https://authn.io/mediator?origin='

/**
 * The wire shape a CHAPI response resolves to.
 */
interface ChapiWireResponse {
  dataType?: string
  data?: unknown
}

interface E2eBridgeWindow extends Window {
  __WAS_REACT_E2E_CHAPI__?: boolean
  __WAS_REACT_E2E_CHAPI_REQUESTS__?: Array<{
    id: number
    type: 'get' | 'store'
    body: unknown
  }>
  __WAS_REACT_E2E_CHAPI_RESPONSES__?: Record<number, ChapiWireResponse | null>
}

function e2eBridgeActive(): boolean {
  return (
    import.meta.env.MODE !== 'production' &&
    (window as E2eBridgeWindow).__WAS_REACT_E2E_CHAPI__ === true
  )
}

let e2eRequestId = 0

/**
 * Queues a request for the e2e harness and polls for its response.
 */
async function e2eRoundTrip(
  type: 'get' | 'store',
  body: unknown
): Promise<ChapiWireResponse | null> {
  const win = window as E2eBridgeWindow
  win.__WAS_REACT_E2E_CHAPI_REQUESTS__ ??= []
  win.__WAS_REACT_E2E_CHAPI_RESPONSES__ ??= {}
  const id = ++e2eRequestId
  win.__WAS_REACT_E2E_CHAPI_REQUESTS__.push({ id, type, body })
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (id in win.__WAS_REACT_E2E_CHAPI_RESPONSES__) {
      const value = win.__WAS_REACT_E2E_CHAPI_RESPONSES__[id]
      delete win.__WAS_REACT_E2E_CHAPI_RESPONSES__[id]
      return value ?? null
    }
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  throw new Error('E2E CHAPI bridge timed out waiting for a response.')
}

let polyfillLoaded = false

/**
 * Loads the CHAPI polyfill once (no-op under the e2e bridge).
 *
 * @param [options] {object}
 * @param [options.mediatorBase] {string}   the mediator base URL (defaults to
 *   `DEFAULT_MEDIATOR_BASE`)
 * @returns {Promise<void>}
 */
export async function loadChapi({
  mediatorBase = DEFAULT_MEDIATOR_BASE
}: {
  mediatorBase?: string
} = {}): Promise<void> {
  if (polyfillLoaded || e2eBridgeActive()) {
    return
  }
  await loadOnce(mediatorBase + encodeURIComponent(window.location.origin))
  polyfillLoaded = true
}

/**
 * Sends a VPR to the user's wallet via CHAPI `credentials.get()`. Returns the
 * wallet's response VP, or `null` when the user cancelled/dismissed.
 *
 * @param options {object}
 * @param options.vpr {IVPRDetails}
 * @param [options.mediatorBase] {string}
 * @returns {Promise<IVerifiablePresentation | null>}
 */
export async function chapiGet({
  vpr,
  mediatorBase
}: {
  vpr: IVPRDetails
  mediatorBase?: string
}): Promise<IVerifiablePresentation | null> {
  let wire: ChapiWireResponse | null
  if (e2eBridgeActive()) {
    wire = await e2eRoundTrip('get', vpr)
  } else {
    await loadChapi(mediatorBase !== undefined ? { mediatorBase } : {})
    const result = (await navigator.credentials.get({
      // The polyfill extends CredentialRequestOptions with the `web` member.
      web: { VerifiablePresentation: vpr }
    } as CredentialRequestOptions)) as unknown as ChapiWireResponse | null
    wire = result
  }
  if (!wire || wire.data === undefined || wire.data === null) {
    return null
  }
  return wire.data as IVerifiablePresentation
}

/**
 * Offers a VP (wrapping a credential) to the wallet via CHAPI
 * `credentials.store()`. Returns true when the wallet confirmed the store,
 * false when the user cancelled/dismissed.
 *
 * @param options {object}
 * @param options.presentation {IVerifiablePresentation}
 * @param [options.mediatorBase] {string}
 * @returns {Promise<boolean>}
 */
export async function chapiStore({
  presentation,
  mediatorBase
}: {
  presentation: IVerifiablePresentation
  mediatorBase?: string
}): Promise<boolean> {
  if (e2eBridgeActive()) {
    const wire = await e2eRoundTrip('store', presentation)
    return wire !== null && wire.data !== undefined && wire.data !== null
  }
  await loadChapi(mediatorBase !== undefined ? { mediatorBase } : {})
  const credential = new WebCredential(
    'VerifiablePresentation',
    presentation as unknown as object
  )
  const result = (await navigator.credentials.store(
    credential as unknown as Credential
  )) as unknown as ChapiWireResponse | null
  return result !== null && result !== undefined
}
