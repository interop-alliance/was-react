/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
// @vitest-environment node
/**
 * Counterpart tests: both halves of the App Connect contract, run against
 * `@interop/wallet-core`'s REAL wallet-side implementation rather than against
 * a fixture of it. The request this library builds must be one wallet-core
 * accepts, and the app-key credential wallet-core mints (fresh, or re-issued
 * from a legacy pre-`appUrl` one) must be one this library locates and parses.
 *
 * The legacy case is the one worth stating plainly: a legacy credential's seed
 * -- and therefore the app's identity and its access to everything encrypted
 * under it -- must survive the re-issue unchanged. A fresh mint would roll the
 * seed and orphan the app, so the assertion here is that the controller DID
 * recovered after the re-issue is the SAME one the legacy credential carried.
 */
import { describe, expect, it } from 'vitest'
import {
  appConnectRequestOf,
  composeVp,
  findLegacyAppKeyCredential,
  mintAppKeyCredential,
  reissueAppKeyCredential,
  serializedAppUrl
} from '@interop/wallet-core/request'
import { agentsFromSeed } from '@interop/wallet-core/identity'
import type {
  IVerifiableCredential,
  IVerifiablePresentation,
  IZcap
} from '@interop/data-integrity-core'
import { deriveIdentity } from '../identity/agents.js'
import { createDocumentLoader } from '../identity/documentLoader.js'
import {
  bytesToBase64url,
  findSeedCredential,
  parseSeedCredential
} from '../identity/seedCredential.js'
import { buildAppConnectVpr } from './loginRequest.js'
import { grantsOf, verifyLoginPresentation } from './verifyResponse.js'
import type { IAppConnectQuery } from './walletRequestTypes.js'

const ORIGIN = 'https://app.example'
const APP_URL = `${ORIGIN}/notes-app`
const APP_NAME = 'Example Notes'

/**
 * Wraps credentials in a minimal (unsigned) response presentation, which is
 * all the locate step reads.
 */
function presentationWith(
  credentials: IVerifiableCredential[]
): IVerifiablePresentation {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    type: ['VerifiablePresentation'],
    verifiableCredential: credentials
  } as unknown as IVerifiablePresentation
}

describe('the request half, against wallet-core', () => {
  it('builds a VPR wallet-core accepts, with the app block intact', () => {
    const vpr = buildAppConnectVpr({
      challenge: crypto.randomUUID(),
      domain: ORIGIN,
      appName: APP_NAME,
      appUrl: APP_URL,
      collections: [
        { id: 'notes' },
        { id: 'microblog-posts', visibility: 'public' }
      ],
      sharedCollections: ['private-credentials']
    })
    const queries = Array.isArray(vpr.query) ? vpr.query : [vpr.query]
    const parsed = appConnectRequestOf({
      queries: queries as never,
      origin: ORIGIN
    })

    expect(parsed).toBeDefined()
    expect(parsed?.app).toEqual({ name: APP_NAME, appUrl: APP_URL })
    // Every descriptor survives the wallet's normalization unchanged.
    expect(parsed?.capabilityQueries).toEqual([
      {
        referenceId: 'notes',
        allowedAction: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'],
        invocationTarget: {
          type: 'https://w3id.org/byoe#private-collection',
          name: 'notes'
        }
      },
      {
        referenceId: 'microblog-posts',
        allowedAction: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'],
        invocationTarget: {
          type: 'https://w3id.org/byoe#public-collection',
          name: 'microblog-posts'
        }
      },
      {
        referenceId: 'private-credentials',
        allowedAction: ['GET', 'HEAD'],
        invocationTarget: {
          type: 'https://w3id.org/byoe#shared-wallet-collection',
          name: 'private-credentials'
        }
      }
    ])
  })

  it('sends the appUrl in the serialization the wallet compares on', () => {
    const vpr = buildAppConnectVpr({
      challenge: crypto.randomUUID(),
      domain: ORIGIN,
      appName: APP_NAME,
      appUrl: `${ORIGIN}:443/a/../notes-app`,
      collections: []
    })
    const queries = Array.isArray(vpr.query) ? vpr.query : [vpr.query]
    const sent = (
      queries.find(entry => entry.type === 'AppConnectQuery') as
        IAppConnectQuery | undefined
    )?.app.appUrl
    const parsed = appConnectRequestOf({
      queries: queries as never,
      origin: ORIGIN
    })
    expect(sent).toBe(APP_URL)
    expect(parsed?.app.appUrl).toBe(sent)
  })
})

describe('the credential half, against wallet-core', () => {
  it('locates and parses a credential wallet-core minted', async () => {
    const { credential, subjectDid } = await mintAppKeyCredential({
      app: { name: APP_NAME, appUrl: APP_URL },
      origin: ORIGIN
    })
    const located = findSeedCredential({
      presentation: presentationWith([credential]),
      appUrl: APP_URL
    })
    expect(located).toBe(credential)

    const parsed = await parseSeedCredential({
      credential: located as IVerifiableCredential,
      origin: ORIGIN,
      appUrl: APP_URL
    })
    expect(parsed.controllerDid).toBe(subjectDid)
    expect(parsed.seed).toHaveLength(32)
  })

  it('is located inside a wallet-core-composed, signed response VP', async () => {
    const { credential, subjectDid } = await mintAppKeyCredential({
      app: { name: APP_NAME, appUrl: APP_URL },
      origin: ORIGIN
    })
    // The wallet's holder identity, derived the way the wallet derives it (the
    // response VP's holder is the wallet, never the app).
    const walletSeed = crypto.getRandomValues(new Uint8Array(32))
    const wallet = await agentsFromSeed({ seed: walletSeed })
    const challenge = crypto.randomUUID()
    // A structural grant, the shape a wallet delegates to the app's controller
    // DID; the VP proof covers it, and the RP checks grant structure rather
    // than the delegation proof, so no proof of its own is needed here.
    const grant = {
      '@context': 'https://w3id.org/zcap/v1',
      id: `urn:zcap:${crypto.randomUUID()}`,
      controller: subjectDid,
      parentCapability: 'urn:zcap:root:https%3A%2F%2Fwas.example%2Fspace%2Fs1',
      invocationTarget: 'https://was.example/space/s1/notes',
      allowedAction: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'],
      expires: new Date(Date.now() + 86_400_000).toISOString()
    } as unknown as IZcap

    // The REAL response composition: DIDAuth-signed, grants and the App
    // Connect marker embedded before signing.
    const presentation = await composeVp({
      presentationSigner: {
        signer: wallet.keyAgent.getSigner(),
        holder: wallet.controllerDid
      },
      selectedVcs: [credential],
      challenge,
      domain: ORIGIN,
      didAuthRequested: true,
      zcaps: [grant],
      appConnect: { firstRun: true }
    })

    // This library's own verification accepts wallet-core's signature ...
    await verifyLoginPresentation({
      presentation,
      challenge,
      domain: ORIGIN,
      documentLoader: createDocumentLoader()
    })

    // ... the members the login flow reads survive composition and signing ...
    expect((presentation as { appConnect?: unknown }).appConnect).toEqual({
      firstRun: true
    })
    expect(grantsOf(presentation)).toEqual([grant])

    // ... and its locate + parse recover the identity from inside the VP.
    const located = findSeedCredential({
      presentation,
      appUrl: APP_URL
    })
    expect(located).not.toBeNull()
    const parsed = await parseSeedCredential({
      credential: located!,
      origin: ORIGIN,
      appUrl: APP_URL
    })
    expect(parsed.controllerDid).toBe(subjectDid)
  })

  it('preserves the identity across wallet-core legacy re-issuance', async () => {
    // A legacy (pre-appUrl) app key: the marker plus a per-app third type
    // entry, an inline context, no `appUrl` claim. Self-issued and seed-bound,
    // which is all the re-issue path checks -- it verifies no proof, so an
    // unsigned fixture is enough.
    const seed = crypto.getRandomValues(new Uint8Array(32))
    const { controllerDid: legacyDid } = await deriveIdentity({ seed })
    const legacy = {
      '@context': [
        'https://www.w3.org/2018/credentials/v1',
        {
          '@protected': true,
          AppKeyCredential: 'https://w3id.org/byoe#AppKeyCredential',
          ExampleNotesAppKey: 'urn:example-notes:vocab#ExampleNotesAppKey',
          seed: 'https://w3id.org/byoe#seed',
          origin: 'https://w3id.org/byoe#origin'
        }
      ],
      id: `urn:uuid:${crypto.randomUUID()}`,
      type: ['VerifiableCredential', 'AppKeyCredential', 'ExampleNotesAppKey'],
      issuanceDate: '2026-01-01T00:00:00Z',
      issuer: legacyDid,
      credentialSubject: {
        id: legacyDid,
        seed: bytesToBase64url(seed),
        origin: ORIGIN
      }
    } as unknown as IVerifiableCredential

    const found = await findLegacyAppKeyCredential({
      credentials: [legacy],
      origin: ORIGIN
    })
    expect(found).toBe(legacy)

    const { credential: reissued, subjectDid } = await reissueAppKeyCredential({
      credential: found as IVerifiableCredential,
      app: {
        name: APP_NAME,
        appUrl: serializedAppUrl({ appUrl: APP_URL, origin: ORIGIN })
      },
      origin: ORIGIN
    })

    // The re-issued credential is an ordinary current-shape app key ...
    const located = findSeedCredential({
      presentation: presentationWith([reissued]),
      appUrl: APP_URL
    })
    expect(located).toBe(reissued)
    const parsed = await parseSeedCredential({
      credential: located as IVerifiableCredential,
      origin: ORIGIN,
      appUrl: APP_URL
    })
    // ... carrying the SAME identity, end to end. A rolled seed here would
    // orphan everything the app encrypted under the legacy DID.
    expect(subjectDid).toBe(legacyDid)
    expect(parsed.controllerDid).toBe(legacyDid)
    expect(parsed.seed).toEqual(seed)
  })

  it('does not locate a legacy credential (it carries no appUrl)', () => {
    const legacy = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential', 'AppKeyCredential', 'ExampleNotesAppKey'],
      issuer: 'did:example:legacy',
      credentialSubject: { id: 'did:example:legacy', origin: ORIGIN }
    } as unknown as IVerifiableCredential
    expect(
      findSeedCredential({
        presentation: presentationWith([legacy]),
        appUrl: APP_URL
      })
    ).toBeNull()
  })
})
