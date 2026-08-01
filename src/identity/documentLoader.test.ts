/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * documentLoader did:webvh tests. Each fixture creates a real did:webvh (log
 * signed with an Ed25519 update key) and serves its `did.jsonl` from an
 * in-process `node:http` server on `localhost` -- which also exercises the
 * driver's plain-http loopback fetch, the same dev parity the did:web
 * resolver has. Covered: full-document resolution, `did#fragment`
 * dereferencing to a verification method, verified resolution failing closed
 * on a tampered log, and `verifyLoginPresentation` over a VP whose holder is
 * a did:webvh signed with a `<did:webvh>#<key>` verification method
 * (alongside the existing did:key-holder tests in verifyResponse.test.ts).
 */
import http from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as vc from '@interop/vc'
import { Ed25519Signature2020 } from '@interop/ed25519-signature'
import { CapabilityAgent } from '@interop/webkms-client'
import {
  createDID,
  logToJsonlString,
  multibaseDecode,
  multibaseEncode,
  MultibaseEncoding,
  signerFromExternalKey,
  type DIDLog
} from '@interop/did-method-webvh'
import type { IVerifiablePresentation } from '@interop/data-integrity-core'
import { verifyLoginPresentation } from '../auth/verifyResponse.js'
import { createDocumentLoader } from './documentLoader.js'

const ORIGIN = 'http://localhost:5173'
const documentLoader = createDocumentLoader()

/**
 * A served did:webvh fixture: the DID, its verification method id, the
 * signing agent behind that method, and the server teardown.
 */
interface WebvhFixture {
  did: string
  vmId: string
  agent: CapabilityAgent
  log: DIDLog
  setServedLog: (log: DIDLog) => void
  close: () => Promise<void>
}

/**
 * Creates a did:webvh on a fresh `localhost` http server and serves its
 * `did.jsonl`. The DID's one verification method (purpose `authentication`)
 * is the agent's Ed25519 key, with the self-describing `#<multibase>`
 * fragment id the wallet mints for client keys.
 */
async function serveWebvhDid(): Promise<WebvhFixture> {
  let servedLog: DIDLog | undefined
  const server = http.createServer((request, response) => {
    if (request.url?.endsWith('/did.jsonl') && servedLog) {
      response.writeHead(200, { 'Content-Type': 'text/jsonl' })
      response.end(logToJsonlString(servedLog))
      return
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise<void>(resolve => server.listen(0, resolve))
  const address = server.address()
  if (address === null || typeof address !== 'object') {
    throw new Error('The fixture server did not report a port.')
  }

  const agent = await CapabilityAgent.fromSeed({
    seed: crypto.getRandomValues(new Uint8Array(32)),
    handle: 'webvh-wallet',
    keyName: 'wallet-key'
  })
  // The agent's did:key suffix IS the key's Ed25519 multibase (z6Mk...).
  const publicKeyMultibase = agent.id.split(':').pop() as string
  const agentSigner = agent.getSigner()
  const { did, log } = await createDID({
    address: `localhost:${address.port}`,
    signer: signerFromExternalKey({
      publicKeyMultibase,
      sign: async ({ data }) => await agentSigner.sign({ data })
    }),
    updateKeys: [publicKeyMultibase],
    verificationMethods: [{ type: 'Multikey', publicKeyMultibase }],
    vmIdFragment: 'multibase'
  })
  servedLog = log

  return {
    did,
    vmId: `${did}#${publicKeyMultibase}`,
    agent,
    log,
    setServedLog: (next: DIDLog) => {
      servedLog = next
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close(err => (err ? reject(err) : resolve()))
      )
  }
}

describe('createDocumentLoader did:webvh resolution', () => {
  let fixture: WebvhFixture

  beforeAll(async () => {
    fixture = await serveWebvhDid()
  })

  afterAll(async () => {
    await fixture.close()
  })

  it('resolves a did:webvh to its DID document over loopback http', async () => {
    const { document } = await documentLoader(fixture.did)
    const doc = document as {
      id: string
      authentication?: string[]
      verificationMethod?: { id: string }[]
    }
    expect(doc.id).toBe(fixture.did)
    expect(doc.verificationMethod?.[0]?.id).toBe(fixture.vmId)
    expect(doc.authentication).toContain(fixture.vmId)
  })

  it('dereferences a <did:webvh>#<multibase> fragment to its verification method', async () => {
    const { document, documentUrl } = await documentLoader(fixture.vmId)
    const method = document as {
      id: string
      type: string
      publicKeyMultibase?: string
    }
    expect(documentUrl).toBe(fixture.vmId)
    expect(method.id).toBe(fixture.vmId)
    expect(method.type).toBe('Multikey')
    expect(method.publicKeyMultibase).toBe(fixture.vmId.split('#')[1])
  })

  it('fails closed on a tampered history log', async () => {
    // A separate fixture: the module-level resolver caches resolutions, so
    // tampering must happen on a DID it has never resolved.
    const tampered = await serveWebvhDid()
    try {
      const [entry] = structuredClone(tampered.log)
      ;(entry!.state as { alsoKnownAs?: string[] }).alsoKnownAs = [
        'did:example:mallory'
      ]
      tampered.setServedLog([entry!])
      // The verified-resolution failure (log hash chain), not a fetch error.
      await expect(documentLoader(tampered.did)).rejects.toThrow(
        /not derived from logEntryHash/
      )
    } finally {
      await tampered.close()
    }
  })

  it('fails closed on a forged log entry proof', async () => {
    // Hash chain left intact; only the entry proof's signature is corrupted
    // (one flipped byte), so this failure can only come from the driver's
    // default log verifier checking entry proofs through the loader path.
    const forged = await serveWebvhDid()
    try {
      const [entry] = structuredClone(forged.log)
      const proof = entry!.proof![0] as { proofValue: string }
      const { bytes } = multibaseDecode(proof.proofValue)
      bytes[0]! ^= 0xff
      proof.proofValue = multibaseEncode(bytes, MultibaseEncoding.BASE58_BTC)
      forged.setServedLog([entry!])
      await expect(documentLoader(forged.did)).rejects.toThrow(
        /failed verification/
      )
    } finally {
      await forged.close()
    }
  })
})

describe('verifyLoginPresentation with a did:webvh holder', () => {
  let fixture: WebvhFixture

  beforeAll(async () => {
    fixture = await serveWebvhDid()
  })

  afterAll(async () => {
    await fixture.close()
  })

  /**
   * Signs a wallet-style DIDAuth VP as the fixture's did:webvh holder, with
   * the proof's verificationMethod set to `<did:webvh>#<multibase>`.
   */
  async function webvhVp({
    challenge,
    domain = ORIGIN
  }: {
    challenge: string
    domain?: string
  }): Promise<IVerifiablePresentation> {
    const agentSigner = fixture.agent.getSigner()
    const suite = new Ed25519Signature2020({
      signer: {
        id: fixture.vmId,
        algorithm: agentSigner.algorithm,
        sign: async ({ data }) => await agentSigner.sign({ data })
      }
    })
    const presentation = vc.createPresentation({
      holder: fixture.did,
      verify: false,
      version: 1.0
    })
    return (await vc.signPresentation({
      presentation,
      challenge,
      domain,
      documentLoader,
      suite
    })) as IVerifiablePresentation
  }

  it('accepts a VP signed with a <did:webvh>#<key> verification method', async () => {
    const challenge = crypto.randomUUID()
    const presentation = await webvhVp({ challenge })
    await expect(
      verifyLoginPresentation({
        presentation,
        challenge,
        domain: ORIGIN,
        documentLoader
      })
    ).resolves.toBeUndefined()
  })

  it('still rejects a challenge mismatch from a did:webvh holder', async () => {
    const presentation = await webvhVp({ challenge: 'sent-nonce' })
    await expect(
      verifyLoginPresentation({
        presentation,
        challenge: 'other-nonce',
        domain: ORIGIN,
        documentLoader
      })
    ).rejects.toThrow()
  })
})
