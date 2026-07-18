/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * RP-side VPR construction for Login With Wallet. Two requests:
 *
 * 1. The seed probe: DIDAuthentication + QueryByExample for the app-key
 *    credential. An empty result is the first-run signal; a hit recovers the
 *    master seed on a new device.
 * 2. The grants request: DIDAuthentication + AuthorizationCapabilityQuery with
 *    one capabilityQuery per collection (descriptor-object targets, which the
 *    wallet resolves against the user's one Space and auto-provisions). Only
 *    collection-scoped capabilities are requested -- no whole-space grant.
 *
 * `domain` must host-match the CHAPI requesting origin or the wallet refuses
 * to sign; `challenge` must be fresh per request (echoed into the DIDAuth
 * proof and checked in verifyResponse).
 */
import type {
  ICapabilityQueryDetail,
  IVPRDetails
} from './walletRequestTypes.js'

/**
 * Default read/write actions requested on each app collection.
 */
export const RW_ACTIONS = ['GET', 'HEAD', 'PUT', 'POST', 'DELETE']

/**
 * A fresh nonce for a VPR challenge.
 */
export function newChallenge(): string {
  return crypto.randomUUID()
}

/**
 * VPR #1: DIDAuthentication + QueryByExample for the app-key credential.
 *
 * @param options {object}
 * @param options.challenge {string}
 * @param options.domain {string}
 * @param options.credentialType {string}   the app's seed-credential type name
 * @param options.appName {string}   human-readable app name for the reason line
 * @returns {IVPRDetails}
 */
export function buildSeedProbeVpr({
  challenge,
  domain,
  credentialType,
  appName
}: {
  challenge: string
  domain: string
  credentialType: string
  appName: string
}): IVPRDetails {
  return {
    query: [
      {
        type: 'DIDAuthentication',
        acceptedMethods: [{ method: 'key' }]
      },
      {
        type: 'QueryByExample',
        credentialQuery: {
          reason: `Recover the ${appName} app key stored in your wallet.`,
          example: { type: credentialType }
        }
      }
    ],
    challenge,
    domain
  }
}

/**
 * VPR #2: DIDAuthentication + AuthorizationCapabilityQuery -- one read/write
 * capabilityQuery per app collection (delegated to `controllerDid`). Only
 * collection-scoped capabilities are requested.
 *
 * @param options {object}
 * @param options.challenge {string}
 * @param options.domain {string}
 * @param options.controllerDid {string}
 * @param options.collections {string[]}   the WAS collection ids to request
 * @param options.appName {string}   human-readable app name for the reason line
 * @param [options.actions] {string[]}   the RW action set (defaults to
 *   `RW_ACTIONS`)
 * @returns {IVPRDetails}
 */
export function buildGrantsVpr({
  challenge,
  domain,
  controllerDid,
  collections,
  appName,
  actions = RW_ACTIONS
}: {
  challenge: string
  domain: string
  controllerDid: string
  collections: string[]
  appName: string
  actions?: string[]
}): IVPRDetails {
  const capabilityQuery: ICapabilityQueryDetail[] = collections.map(id => ({
    referenceId: id,
    reason: `Store your ${appName} data in the "${id}" collection.`,
    controller: controllerDid,
    allowedAction: actions,
    invocationTarget: { type: 'urn:was:collection', name: id }
  }))
  return {
    query: [
      {
        type: 'DIDAuthentication',
        acceptedMethods: [{ method: 'key' }]
      },
      {
        type: 'AuthorizationCapabilityQuery',
        capabilityQuery
      }
    ],
    challenge,
    domain
  }
}
