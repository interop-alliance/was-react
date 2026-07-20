/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Seed-credential tests: issue/parse round trip, the self-issue / origin /
 * seed-to-DID structural contract, and cryptographic verifiability of the
 * issued credential.
 */
import { describe, expect, it } from 'vitest'
import { verifyCredential } from '@interop/verifier-core'
import type { IVerifiableCredential } from '@interop/data-integrity-core'
import {
  base64urlToBytes,
  bytesToBase64url,
  findSeedCredential,
  issueSeedCredential,
  parseSeedCredential,
  wrapCredentialForStore,
  type SeedCredentialConfig
} from './seedCredential.js'
import { createDocumentLoader } from './documentLoader.js'
import { deriveIdentity } from './agents.js'

const ORIGIN = 'http://localhost:5173'
const APP_NAME = 'Test App'
const CONFIG: SeedCredentialConfig = {
  credentialType: 'TestAppKey',
  vocabBase: 'urn:test-app:vocab#'
}
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
      appName: APP_NAME,
      config: CONFIG,
      documentLoader
    })

    expect(credential.type).toContain(CONFIG.credentialType)
    expect(credential.issuer).toBe(controllerDid)
    const subject = credential.credentialSubject as {
      id: string
      seed: string
      origin: string
    }
    expect(subject.id).toBe(controllerDid)
    expect(subject.origin).toBe(ORIGIN)
    expect(base64urlToBytes(subject.seed)).toEqual(seed)
    expect(credential.proof).toBeDefined()
  })

  it('carries a wallet-facing name and description', async () => {
    const credential = await issueSeedCredential({
      seed: randomSeed(),
      origin: ORIGIN,
      appName: APP_NAME,
      config: CONFIG,
      documentLoader
    })
    const withCopy = credential as unknown as {
      name: string
      description: string
    }
    expect(withCopy.name).toBe(`${APP_NAME} app key`)
    expect(withCopy.description).toContain(APP_NAME)
    expect(withCopy.description.length).toBeGreaterThan(0)
    const context = (credential['@context'] as unknown[])[1] as Record<
      string,
      unknown
    >
    expect(context.name).toBe('https://schema.org/name')
    expect(context.description).toBe('https://schema.org/description')
  })

  it('issues a cryptographically verifiable credential', async () => {
    const credential = await issueSeedCredential({
      seed: randomSeed(),
      origin: ORIGIN,
      appName: APP_NAME,
      config: CONFIG,
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
        appName: APP_NAME,
        config: CONFIG,
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
      appName: APP_NAME,
      config: CONFIG,
      documentLoader
    })
    const parsed = await parseSeedCredential({
      credential,
      origin: ORIGIN,
      config: CONFIG
    })
    expect(parsed.seed).toEqual(seed)
    expect(parsed.controllerDid).toBe(controllerDid)
  })

  it('rejects an origin mismatch', async () => {
    const credential = await issueSeedCredential({
      seed: randomSeed(),
      origin: 'https://evil.example',
      appName: APP_NAME,
      config: CONFIG,
      documentLoader
    })
    await expect(
      parseSeedCredential({ credential, origin: ORIGIN, config: CONFIG })
    ).rejects.toThrow(/origin/)
  })

  it('rejects a non-self-issued credential', async () => {
    const credential = await issueSeedCredential({
      seed: randomSeed(),
      origin: ORIGIN,
      appName: APP_NAME,
      config: CONFIG,
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
        config: CONFIG
      })
    ).rejects.toThrow(/self-issued/)
  })

  it('rejects a credential whose seed does not derive its subject DID', async () => {
    const credential = await issueSeedCredential({
      seed: randomSeed(),
      origin: ORIGIN,
      appName: APP_NAME,
      config: CONFIG,
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
        config: CONFIG
      })
    ).rejects.toThrow(/does not derive/)
  })

  it('rejects the wrong credential type', async () => {
    const credential = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential'],
      issuer: 'did:example:x',
      credentialSubject: { id: 'did:example:x' }
    } as unknown as IVerifiableCredential
    await expect(
      parseSeedCredential({ credential, origin: ORIGIN, config: CONFIG })
    ).rejects.toThrow(/not a TestAppKey/)
  })

  it('rejects a malformed seed', async () => {
    const credential = await issueSeedCredential({
      seed: randomSeed(),
      origin: ORIGIN,
      appName: APP_NAME,
      config: CONFIG,
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
        config: CONFIG
      })
    ).rejects.toThrow(/32 bytes/)
  })
})

describe('findSeedCredential / wrapCredentialForStore', () => {
  it('finds the app key inside a VP and ignores other credentials', async () => {
    const credential = await issueSeedCredential({
      seed: randomSeed(),
      origin: ORIGIN,
      appName: APP_NAME,
      config: CONFIG,
      documentLoader
    })
    const other = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential'],
      issuer: 'did:example:x',
      credentialSubject: {}
    }
    const vp = wrapCredentialForStore(credential)
    ;(vp as { verifiableCredential: unknown[] }).verifiableCredential = [
      other,
      credential
    ]
    expect(
      findSeedCredential({
        presentation: vp,
        credentialType: CONFIG.credentialType
      })
    ).toBe(credential)
  })

  it('returns null when the VP carries no app key (first-run signal)', () => {
    const vp = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiablePresentation']
    } as never
    expect(
      findSeedCredential({
        presentation: vp,
        credentialType: CONFIG.credentialType
      })
    ).toBeNull()
  })
})
