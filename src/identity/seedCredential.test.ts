/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * App-key credential tests: issue/parse round trip, the six App Connect parse
 * checks (marker type, appUrl match, self-issue, origin bind, 32-byte seed,
 * seed-to-DID binding), the locate-by-appUrl rule, and cryptographic
 * verifiability of the issued credential.
 */
import { describe, expect, it } from 'vitest'
import { verifyCredential } from '@interop/verifier-core'
import type { IVerifiableCredential } from '@interop/data-integrity-core'
import {
  APP_KEY_CREDENTIAL_TYPE,
  base64urlToBytes,
  bytesToBase64url,
  findSeedCredential,
  issueSeedCredential,
  parseSeedCredential
} from './seedCredential.js'
import { createDocumentLoader } from './documentLoader.js'
import { deriveIdentity } from './agents.js'

const ORIGIN = 'http://localhost:5173'
const APP_NAME = 'Test App'
const APP_URL = 'http://localhost:5173/notes'
const APP_CONNECT_CONTEXT_URL = 'https://w3id.org/byoe/app-connect/v1'
const documentLoader = createDocumentLoader()

function randomSeed(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32))
}

describe('base64url helpers', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = randomSeed()
    expect(base64urlToBytes(bytesToBase64url(bytes))).toEqual(bytes)
  })

  it('produces no padding or unsafe characters', () => {
    const encoded = bytesToBase64url(randomSeed())
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('encodes a known vector padding-free with url-safe characters', () => {
    // Bytes [0xfb, 0xff, 0xbf] encode as base64url "-_-_" (uses - and _).
    const bytes = new Uint8Array([0xfb, 0xff, 0xbf])
    expect(bytesToBase64url(bytes)).toBe('-_-_')
    expect(Array.from(base64urlToBytes('-_-_'))).toEqual([0xfb, 0xff, 0xbf])
  })
})

describe('issueSeedCredential', () => {
  it('issues a self-issued app key bound to the seed-derived DID', async () => {
    const seed = randomSeed()
    const { controllerDid } = await deriveIdentity({ seed })
    const credential = await issueSeedCredential({
      seed,
      origin: ORIGIN,
      appUrl: APP_URL,
      appName: APP_NAME,
      documentLoader
    })

    expect(credential.type).toEqual([
      'VerifiableCredential',
      APP_KEY_CREDENTIAL_TYPE
    ])
    // The signature suite appends its own context entry after these two.
    expect((credential['@context'] as unknown[]).slice(0, 2)).toEqual([
      'https://www.w3.org/2018/credentials/v1',
      APP_CONNECT_CONTEXT_URL
    ])
    expect(credential.issuer).toBe(controllerDid)
    const subject = credential.credentialSubject as {
      id: string
      seed: string
      origin: string
      appUrl: string
    }
    expect(subject.id).toBe(controllerDid)
    expect(subject.origin).toBe(ORIGIN)
    expect(subject.appUrl).toBe(APP_URL)
    expect(base64urlToBytes(subject.seed)).toEqual(seed)
    expect(credential.proof).toBeDefined()
  })

  it('carries a wallet-facing name and description', async () => {
    const credential = await issueSeedCredential({
      seed: randomSeed(),
      origin: ORIGIN,
      appUrl: APP_URL,
      appName: APP_NAME,
      documentLoader
    })
    const withCopy = credential as unknown as {
      name: string
      description: string
    }
    expect(withCopy.name).toBe(`${APP_NAME} app key`)
    expect(withCopy.description).toContain(APP_NAME)
    expect(withCopy.description.length).toBeGreaterThan(0)
  })

  it('carries the hosted App Connect context, not an inline term object', async () => {
    const credential = await issueSeedCredential({
      seed: randomSeed(),
      origin: ORIGIN,
      appUrl: APP_URL,
      appName: APP_NAME,
      documentLoader
    })
    // The vocabulary is identical for every app: one hosted context URL, no
    // per-app terms and nothing interpolated from a vocabulary base.
    const contexts = credential['@context'] as unknown[]
    expect(contexts[0]).toBe('https://www.w3.org/2018/credentials/v1')
    expect(contexts[1]).toBe(APP_CONNECT_CONTEXT_URL)
    // Nothing app-scoped anywhere: no inline term object at all.
    expect(contexts.every(entry => typeof entry === 'string')).toBe(true)
  })

  it('issues a cryptographically verifiable credential', async () => {
    const credential = await issueSeedCredential({
      seed: randomSeed(),
      origin: ORIGIN,
      appUrl: APP_URL,
      appName: APP_NAME,
      documentLoader
    })
    const result = await verifyCredential({
      credential,
      registries: [],
      documentLoader
    })
    expect(result.verified).toBe(true)
  })

  it('rejects a seed that is not 32 bytes', async () => {
    await expect(
      issueSeedCredential({
        seed: new Uint8Array(16),
        origin: ORIGIN,
        appUrl: APP_URL,
        appName: APP_NAME,
        documentLoader
      })
    ).rejects.toThrow(/32 bytes/)
  })
})

describe('parseSeedCredential', () => {
  it('round-trips the seed and controller DID', async () => {
    const seed = randomSeed()
    const { controllerDid } = await deriveIdentity({ seed })
    const credential = await issueSeedCredential({
      seed,
      origin: ORIGIN,
      appUrl: APP_URL,
      appName: APP_NAME,
      documentLoader
    })
    const parsed = await parseSeedCredential({
      credential,
      origin: ORIGIN,
      appUrl: APP_URL
    })
    expect(parsed.seed).toEqual(seed)
    expect(parsed.controllerDid).toBe(controllerDid)
  })

  it('rejects an origin mismatch', async () => {
    const credential = await issueSeedCredential({
      seed: randomSeed(),
      origin: 'https://evil.example',
      appUrl: APP_URL,
      appName: APP_NAME,
      documentLoader
    })
    await expect(
      parseSeedCredential({ credential, origin: ORIGIN, appUrl: APP_URL })
    ).rejects.toThrow(/origin/)
  })

  it('rejects a non-self-issued credential', async () => {
    const credential = await issueSeedCredential({
      seed: randomSeed(),
      origin: ORIGIN,
      appUrl: APP_URL,
      appName: APP_NAME,
      documentLoader
    })
    const tampered = {
      ...credential,
      issuer: 'did:key:z6MkfDbczcXk3XiivKp9kJvBGnBcyhrbsmLAjLgyDJnYCyj4'
    } as IVerifiableCredential
    await expect(
      parseSeedCredential({
        credential: tampered,
        origin: ORIGIN,
        appUrl: APP_URL
      })
    ).rejects.toThrow(/self-issued/)
  })

  it('rejects a credential whose seed does not derive its subject DID', async () => {
    const credential = await issueSeedCredential({
      seed: randomSeed(),
      origin: ORIGIN,
      appUrl: APP_URL,
      appName: APP_NAME,
      documentLoader
    })
    const subject = credential.credentialSubject as Record<string, unknown>
    const tampered = {
      ...credential,
      credentialSubject: {
        ...subject,
        seed: bytesToBase64url(randomSeed())
      }
    } as IVerifiableCredential
    await expect(
      parseSeedCredential({
        credential: tampered,
        origin: ORIGIN,
        appUrl: APP_URL
      })
    ).rejects.toThrow(/does not derive/)
  })

  it('rejects a credential for another appUrl on the same origin', async () => {
    const credential = await issueSeedCredential({
      seed: randomSeed(),
      origin: ORIGIN,
      appUrl: 'http://localhost:5173/other-app',
      appName: APP_NAME,
      documentLoader
    })
    await expect(
      parseSeedCredential({ credential, origin: ORIGIN, appUrl: APP_URL })
    ).rejects.toThrow(/appUrl/)
  })

  it('rejects a credential without the AppKeyCredential marker', async () => {
    const credential = await issueSeedCredential({
      seed: randomSeed(),
      origin: ORIGIN,
      appUrl: APP_URL,
      appName: APP_NAME,
      documentLoader
    })
    // Otherwise a perfect app key: strip only the marker.
    const tampered = {
      ...credential,
      type: (credential.type as string[]).filter(
        term => term !== APP_KEY_CREDENTIAL_TYPE
      )
    } as IVerifiableCredential
    await expect(
      parseSeedCredential({
        credential: tampered,
        origin: ORIGIN,
        appUrl: APP_URL
      })
    ).rejects.toThrow(/AppKeyCredential/)
  })

  it('rejects a seed that is not base64url without padding', async () => {
    const credential = await issueSeedCredential({
      seed: randomSeed(),
      origin: ORIGIN,
      appUrl: APP_URL,
      appName: APP_NAME,
      documentLoader
    })
    const subject = credential.credentialSubject as Record<string, unknown>
    const tampered = {
      ...credential,
      credentialSubject: { ...subject, seed: 'not base64url!!' }
    } as IVerifiableCredential
    await expect(
      parseSeedCredential({
        credential: tampered,
        origin: ORIGIN,
        appUrl: APP_URL
      })
    ).rejects.toThrow(/base64url/)
  })

  it('rejects a malformed seed', async () => {
    const credential = await issueSeedCredential({
      seed: randomSeed(),
      origin: ORIGIN,
      appUrl: APP_URL,
      appName: APP_NAME,
      documentLoader
    })
    const subject = credential.credentialSubject as Record<string, unknown>
    const tampered = {
      ...credential,
      credentialSubject: {
        ...subject,
        seed: bytesToBase64url(new Uint8Array(8))
      }
    } as IVerifiableCredential
    await expect(
      parseSeedCredential({
        credential: tampered,
        origin: ORIGIN,
        appUrl: APP_URL
      })
    ).rejects.toThrow(/32 bytes/)
  })
})

describe('findSeedCredential', () => {
  it('finds the app key by its appUrl claim and ignores other credentials', async () => {
    const credential = await issueSeedCredential({
      seed: randomSeed(),
      origin: ORIGIN,
      appUrl: APP_URL,
      appName: APP_NAME,
      documentLoader
    })
    const other = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential'],
      issuer: 'did:example:x',
      credentialSubject: {}
    }
    const vp = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiablePresentation'],
      verifiableCredential: [other, credential]
    } as never
    expect(
      findSeedCredential({
        presentation: vp,
        appUrl: APP_URL
      })
    ).toBe(credential)
  })

  it('locates a credential missing the marker, so parsing refuses it', async () => {
    const credential = await issueSeedCredential({
      seed: randomSeed(),
      origin: ORIGIN,
      appUrl: APP_URL,
      appName: APP_NAME,
      documentLoader
    })
    const unmarked = {
      ...credential,
      type: (credential.type as string[]).filter(
        term => term !== APP_KEY_CREDENTIAL_TYPE
      )
    } as IVerifiableCredential
    const vp = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiablePresentation'],
      verifiableCredential: [unmarked]
    } as never
    // Not null: a null here would read as first run and mint a second key.
    expect(findSeedCredential({ presentation: vp, appUrl: APP_URL })).toBe(
      unmarked
    )
    // ...and the parse is where it fails, loudly.
    await expect(
      parseSeedCredential({
        credential: unmarked,
        origin: ORIGIN,
        appUrl: APP_URL
      })
    ).rejects.toThrow(/AppKeyCredential/)
  })

  it('returns null for a credential carrying another appUrl', async () => {
    const credential = await issueSeedCredential({
      seed: randomSeed(),
      origin: ORIGIN,
      appUrl: 'http://localhost:5173/other-app',
      appName: APP_NAME,
      documentLoader
    })
    const vp = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiablePresentation'],
      verifiableCredential: [credential]
    } as never
    expect(findSeedCredential({ presentation: vp, appUrl: APP_URL })).toBeNull()
  })

  it('returns null when the VP carries no app key (wallet-unsupported signal)', () => {
    const vp = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiablePresentation']
    } as never
    expect(
      findSeedCredential({
        presentation: vp,
        appUrl: APP_URL
      })
    ).toBeNull()
  })
})
