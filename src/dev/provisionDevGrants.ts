/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Dev grant provisioning (CHAPI bypassed). Against a running was-teaching-server
 * this:
 *
 *   1. derives a throwaway "provisioner" identity (stands in for the wallet that
 *      owns the Space) and the app's own controller DID from the supplied seed;
 *   2. creates a Space (owned by the provisioner) and the requested collections,
 *      PLAINTEXT -- deliberately WITHOUT an encryption marker, mirroring what a
 *      wallet does when it provisions RP-requested collections;
 *   3. delegates a per-collection read/write zcap to the app's controller DID;
 *   4. returns the signed grants and (optionally) writes them to a JSON file the
 *      app loads in dev-sync mode;
 *   5. optionally probes the open question: does the delegated, collection-scoped
 *      RW zcap authorize an RP-side PUT of the collection description carrying the
 *      { encryption: { scheme: 'edv' } } marker?
 *
 * Node only (uses `fs`); consumed through the package `./dev` subpath.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { WasClient, type ActionInput } from '@interop/was-client'
import type { IDelegatedZcap } from '@interop/data-integrity-core'
import { ZcapClient } from '@interop/ezcap'
import { Ed25519Signature2020 } from '@interop/ed25519-signature'
import { CapabilityAgent } from '@interop/webkms-client'
import { deriveIdentity } from '../identity/agents.js'
import { RW_ACTIONS } from '../auth/loginRequest.js'
import { errorStatus } from '../sync/index.js'

/**
 * A fixed, distinct default provisioner seed -- the "wallet" that owns the dev
 * Space. Kept separate from the app seed (the relying party) so the delegation
 * is a genuine cross-identity grant, exactly as in the real wallet-to-RP flow.
 */
export const DEFAULT_PROVISIONER_SEED: Uint8Array = new Uint8Array([
  0x70, 0x72, 0x6f, 0x76, 0x69, 0x73, 0x69, 0x6f, 0x6e, 0x65, 0x72, 0x2d, 0x64,
  0x65, 0x76, 0x2d, 0x73, 0x65, 0x65, 0x64, 0x2d, 0x30, 0x31, 0x32, 0x33, 0x34,
  0x35, 0x36, 0x37, 0x38, 0x39, 0x41
])

/**
 * The outcome of a provisioning run: the signed grants plus the topology and
 * identities they were minted against. The JSON written to `outFile` (when
 * given) is `{ grants }`.
 */
export interface ProvisionDevGrantsResult {
  /**
   * One delegated read/write zcap per requested collection.
   */
  grants: IDelegatedZcap[]
  /**
   * The created space id.
   */
  spaceId: string
  /**
   * The absolute space URL (`<serverUrl>/space/<spaceId>`).
   */
  spaceUrl: string
  /**
   * The app (relying party) controller DID the grants were delegated to.
   */
  appDid: string
  /**
   * The throwaway provisioner (space owner) DID.
   */
  provisionerDid: string
  /**
   * Present only when `probe` was requested: the result of PUTting the
   * encryption marker with the app's delegated RW zcap.
   */
  probe?: {
    authorized: boolean
    status?: number
    body?: unknown
  }
}

/**
 * Builds the provisioner's WAS client (owns / provisions the Space).
 *
 * @param options {object}
 * @param options.serverUrl {string}
 * @param options.seed {Uint8Array}   the provisioner (space-owner) seed
 * @returns {Promise<{ was: WasClient, did: string }>}
 */
async function provisionerClient({
  serverUrl,
  seed
}: {
  serverUrl: string
  seed: Uint8Array
}): Promise<{ was: WasClient; did: string }> {
  const agent = await CapabilityAgent.fromSeed({
    seed,
    handle: 'dev-provisioner',
    keyName: 'provisioner-key'
  })
  const signer = agent.getSigner()
  const zcapClient = new ZcapClient({
    SuiteClass: Ed25519Signature2020,
    invocationSigner: signer,
    delegationSigner: signer
  })
  return { was: new WasClient({ serverUrl, zcapClient }), did: agent.id }
}

/**
 * Provisions a dev Space, its collections, and per-collection RW zcaps delegated
 * to the app DID derived from `seed`.
 *
 * @param options {object}
 * @param options.serverUrl {string}   base URL of a running was-teaching-server
 * @param options.seed {Uint8Array}   the app (relying party) master seed; the
 *   app DID the grants are delegated to is derived from it
 * @param options.collections {string[]}   the WAS collection ids to create and
 *   grant (e.g. `['action-items', 'projects']`)
 * @param [options.spaceName] {string}   human-readable Space name (defaults to
 *   `'Dev Space'`)
 * @param [options.outFile] {string}   when given, the `{ grants }` JSON is
 *   written here (parent directories are created)
 * @param [options.provisionerSeed] {Uint8Array}   the space-owner seed (defaults
 *   to `DEFAULT_PROVISIONER_SEED`)
 * @param [options.identityHandle] {string}   cosmetic label for the app identity
 *   agent; does not affect the derived DID
 * @param [options.actions] {ActionInput[]}   the RW action set delegated per
 *   collection (defaults to the auth layer's `RW_ACTIONS`)
 * @param [options.probe] {boolean}   when true, probe whether the delegated RW
 *   zcap authorizes a PUT of the `{ encryption: { scheme: 'edv' } }` marker
 * @param [options.log] {(message: string) => void}   progress sink (defaults to
 *   a no-op; the CLI passes `console.log`)
 * @returns {Promise<ProvisionDevGrantsResult>}
 */
export async function provisionDevGrants({
  serverUrl,
  seed,
  collections,
  spaceName = 'Dev Space',
  outFile,
  provisionerSeed = DEFAULT_PROVISIONER_SEED,
  identityHandle,
  // The server accepts HEAD even though storage-core's ActionInput union omits
  // it, hence the assertion.
  actions = RW_ACTIONS as ActionInput[],
  probe = false,
  log = () => {}
}: {
  serverUrl: string
  seed: Uint8Array
  collections: string[]
  spaceName?: string
  outFile?: string
  provisionerSeed?: Uint8Array
  identityHandle?: string
  actions?: ActionInput[]
  probe?: boolean
  log?: (message: string) => void
}): Promise<ProvisionDevGrantsResult> {
  const { controllerDid: appDid, zcapClient: appZcapClient } =
    await deriveIdentity({ seed, identityHandle })
  const { was: provisioner, did: provisionerDid } = await provisionerClient({
    serverUrl,
    seed: provisionerSeed
  })

  log(`Provisioning against ${serverUrl}`)
  log(`  provisioner DID: ${provisionerDid}`)
  log(`  app (RP) DID:    ${appDid}`)

  const space = await provisioner.createSpace({
    name: spaceName,
    controller: provisionerDid
  })
  log(`  space id:        ${space.id}`)

  // Each collection grant is delegated from the SPACE ROOT (not the collection
  // root) attenuating down to the collection URL. This is what the reference
  // server authorizes for a collection's sub-resources: a chain rooted at the
  // space root, whose invocationTarget (the collection URL) is a RESTful prefix
  // of every `/<collection>/<resource>` and `/<collection>/query` request. A
  // grant rooted at the collection's own root authorizes only the exact
  // collection-description URL, not its resources or the changes feed.
  const spaceUrl = `${serverUrl}/space/${space.id}`
  const spaceRoot = {
    '@context': 'https://w3id.org/zcap/v1',
    id: `urn:zcap:root:${encodeURIComponent(spaceUrl)}`,
    controller: provisionerDid,
    invocationTarget: spaceUrl
  } as unknown as Parameters<typeof provisioner.grant>[0]['capability']

  const grants: IDelegatedZcap[] = []
  for (const id of collections) {
    // Plaintext collection (no encryption marker) -- mirrors wallet provisioning.
    await space.createCollection({ id, name: id })
    const zcap = await provisioner.grant({
      to: appDid,
      actions,
      target: `${spaceUrl}/${id}`,
      capability: spaceRoot
    })
    grants.push(zcap)
    log(`  collection "${id}": created + delegated RW to app`)
  }

  if (outFile !== undefined) {
    await mkdir(dirname(outFile), { recursive: true })
    await writeFile(outFile, JSON.stringify({ grants }, null, 2))
    log(`\nWrote ${grants.length} grants to ${outFile}`)
  }

  const result: ProvisionDevGrantsResult = {
    grants,
    spaceId: space.id,
    spaceUrl,
    appDid,
    provisionerDid
  }

  if (!probe) {
    return result
  }

  // --- Encryption-marker probe ---------------------------------------------
  // Using the app's OWN delegated RW zcap (not the provisioner root key),
  // attempt to PUT the collection description with the edv marker.
  const appWas = new WasClient({ serverUrl, zcapClient: appZcapClient })
  const probeCollectionId = collections[0]!
  const probeCapability = grants[0]!
  log(
    `\nEncryption-marker probe on "${probeCollectionId}" (delegated RW zcap):`
  )
  try {
    const response = await appWas.request({
      capability: probeCapability,
      path: `/space/${space.id}/${probeCollectionId}`,
      method: 'PUT',
      json: { id: probeCollectionId, encryption: { scheme: 'edv' } }
    })
    log(`  AUTHORIZED -- server responded ${response.status}`)
    result.probe = { authorized: true, status: response.status }
  } catch (err) {
    const status = errorStatus(err)
    const data = (err as { data?: unknown }).data
    log(`  NOT AUTHORIZED -- status ${status ?? 'n/a'}`)
    if (data !== undefined) {
      log(`  server body: ${JSON.stringify(data)}`)
    }
    result.probe = { authorized: false, status, body: data }
  }

  return result
}
