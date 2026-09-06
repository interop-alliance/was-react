/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
import { describe, expect, it } from 'vitest'
import type { ZcapClient } from '@interop/ezcap'
import type {
  IKeyAgreementKey,
  IKeyResolver,
  IZcap
} from '@interop/data-integrity-core'
import { NotImplementedError, WasServerError } from '@interop/was-client'
import { WasRemoteStore, remoteDescriptorSource } from './wasRemoteStore.js'
import type { ParsedGrants } from '../grants.js'
import { captureLogger } from '@interop/logger'
import { setLogger } from '../log.js'

const parsed: ParsedGrants = {
  serverUrl: 'https://was.example',
  spaceId: 'space-1',
  byCollectionId: {
    'microblog-posts': { id: 'urn:zcap:pub' } as unknown as IZcap,
    notes: { id: 'urn:zcap:priv' } as unknown as IZcap
  }
}

const zcapClient = {} as unknown as ZcapClient

/**
 * A stub ZcapClient capturing every signed request and answering each with the
 * queued responses (the last one repeating).
 */
function stubZcapClient(
  responses: Array<{ status: number; data?: unknown; error?: unknown }>
) {
  const calls: Array<{
    url: string
    method?: string
    action?: string
    capability?: unknown
    json?: unknown
  }> = []
  let callIndex = 0
  const client = {
    invocationSigner: { id: 'did:key:zStubController#zStubController' },
    request: async (options: (typeof calls)[number]) => {
      calls.push(options)
      const response = responses[Math.min(callIndex, responses.length - 1)]
      callIndex += 1
      if (response?.error !== undefined) {
        throw response.error
      }
      return response
    }
  }
  return { calls, zcapClient: client as unknown as ZcapClient }
}

/**
 * Fake identity keys: `fromGrants` only records whether they were supplied (the
 * real ones are only ever consumed by the EDV codec, which these tests fake
 * out below).
 */
const identityKeys = {
  keyAgreementKey: { id: 'did:key:zKak#zKak' },
  keyResolver: async () => ({})
} as unknown as {
  keyAgreementKey: IKeyAgreementKey
  keyResolver: IKeyResolver
}

/**
 * Replaces the store's `WasClient` with a stand-in whose
 * `space().collection()` chain answers from `handlers`, capturing the handle
 * arguments and every `find` / `declareIndex` call. The codec is what would
 * blind the terms and decrypt the results; faking at the handle boundary keeps
 * the assertions on this library's own routing.
 */
function fakeCollectionHandle(
  store: WasRemoteStore,
  handlers: {
    find?: (options: Record<string, unknown>) => Promise<unknown>
    indexes?: () => Promise<Array<{ attribute: string | string[] }>>
    declareIndex?: (options: { attribute: string }) => Promise<unknown>
  }
) {
  const calls: {
    spaceId?: string
    collectionId?: string
    capability?: unknown
    find: Array<Record<string, unknown>>
    declared: string[]
  } = { find: [], declared: [] }
  const collection = {
    find: async (options: Record<string, unknown>) => {
      calls.find.push(options)
      return await (handlers.find?.(options) ?? Promise.resolve({}))
    },
    indexes: async () => await (handlers.indexes?.() ?? Promise.resolve([])),
    declareIndex: async ({ attribute }: { attribute: string }) => {
      calls.declared.push(attribute)
      return await (handlers.declareIndex?.({ attribute }) ??
        Promise.resolve({ revision: 1, indexes: [] }))
    }
  }
  const was = {
    space: (spaceId: string) => {
      calls.spaceId = spaceId
      return {
        collection: (
          collectionId: string,
          options?: { capability?: unknown }
        ) => {
          calls.collectionId = collectionId
          calls.capability = options?.capability
          return collection
        }
      }
    }
  }
  ;(store as unknown as { was: unknown }).was = was
  return calls
}

describe('WasRemoteStore.markCollectionEncrypted', () => {
  it('skips the descriptor PUT for a public collection (ok + skipped)', async () => {
    const store = WasRemoteStore.fromGrants({
      parsed,
      zcapClient,
      collections: [
        { key: 'posts', id: 'microblog-posts', visibility: 'public' },
        { key: 'notes', id: 'notes' }
      ]
    })
    // Resolves without any network round trip: the PUT is never attempted.
    const result = await store.markCollectionEncrypted('microblog-posts', {
      encryption: undefined
    })
    expect(result).toEqual({
      collectionId: 'microblog-posts',
      ok: true,
      skipped: true
    })
  })

  it('reports a missing capability for an ungranted private collection', async () => {
    const store = WasRemoteStore.fromGrants({ parsed, zcapClient })
    const result = await store.markCollectionEncrypted('unknown-collection', {
      encryption: undefined
    })
    expect(result).toEqual({
      collectionId: 'unknown-collection',
      ok: false,
      error: 'no capability'
    })
  })

  it('skips the PUT when the collection already carries an epoch roster', async () => {
    // The caller's read returned a descriptor with epochs; the bare-descriptor
    // PUT that would clobber it must never be attempted.
    const { calls, zcapClient: stub } = stubZcapClient([{ status: 200 }])
    const store = WasRemoteStore.fromGrants({ parsed, zcapClient: stub })
    const result = await store.markCollectionEncrypted('notes', {
      encryption: {
        scheme: 'edv',
        currentEpoch: 'did:key:zEpoch1',
        epochs: [{ id: 'did:key:zEpoch1', recipients: [] }]
      }
    })
    expect(result).toEqual({ collectionId: 'notes', ok: true, skipped: true })
    // No round trips at all: the guard turns on the descriptor handed in.
    expect(calls).toHaveLength(0)
  })

  it('PUTs the bare descriptor when no encryption block is present', async () => {
    const { calls, zcapClient: stub } = stubZcapClient([
      { status: 200 } // PUT
    ])
    const store = WasRemoteStore.fromGrants({ parsed, zcapClient: stub })
    const result = await store.markCollectionEncrypted('notes', {
      encryption: undefined
    })
    expect(result).toEqual({ collectionId: 'notes', ok: true, status: 200 })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      method: 'PUT',
      json: { id: 'notes', encryption: { scheme: 'edv' } }
    })
  })
})

describe('WasRemoteStore.readCollectionEncryption', () => {
  it('returns the encryption descriptor from the collection description', async () => {
    const descriptor = {
      scheme: 'edv',
      currentEpoch: 'did:key:zEpoch1',
      epochs: [{ id: 'did:key:zEpoch1', recipients: [] }]
    }
    const { zcapClient: stub } = stubZcapClient([
      { status: 200, data: { id: 'notes', encryption: descriptor } }
    ])
    const store = WasRemoteStore.fromGrants({ parsed, zcapClient: stub })
    expect(await store.readCollectionEncryption('notes')).toEqual(descriptor)
  })

  it('returns undefined for an unmarked collection and a missing capability', async () => {
    const { zcapClient: stub } = stubZcapClient([
      { status: 200, data: { id: 'notes' } }
    ])
    const store = WasRemoteStore.fromGrants({ parsed, zcapClient: stub })
    expect(await store.readCollectionEncryption('notes')).toBeUndefined()
    // No delegated capability covers this id: no request, undefined.
    const bare = WasRemoteStore.fromGrants({ parsed, zcapClient })
    expect(await bare.readCollectionEncryption('ungranted')).toBeUndefined()
  })

  it('returns undefined for a not-found response', async () => {
    const notFound = Object.assign(new Error('Not Found'), { status: 404 })
    const { calls, zcapClient: stub } = stubZcapClient([
      { status: 404, error: notFound }
    ])
    const store = WasRemoteStore.fromGrants({ parsed, zcapClient: stub })
    expect(await store.readCollectionEncryption('notes')).toBeUndefined()
    expect(calls).toHaveLength(1)
  })

  it('rethrows a transient failure, wrapped with the collection id', async () => {
    const badGateway = Object.assign(new Error('Bad Gateway'), { status: 502 })
    const { calls, zcapClient: stub } = stubZcapClient([
      { status: 502, error: badGateway }
    ])
    const store = WasRemoteStore.fromGrants({ parsed, zcapClient: stub })
    const err = (await store.readCollectionEncryption('notes').then(
      () => undefined,
      (err: unknown) => err
    )) as Error
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain('"notes"')
    expect(err.cause).toBeInstanceOf(WasServerError)
    expect((err.cause as WasServerError).status).toBe(502)
    // Retrying is the HTTP client's job, not this layer's.
    expect(calls).toHaveLength(1)
  })
})

describe('remoteDescriptorSource', () => {
  it('warns and answers undefined when the read fails', async () => {
    const capture = captureLogger('wr')
    const previous = setLogger(capture.logger)
    try {
      const { zcapClient: stub } = stubZcapClient([
        {
          status: 502,
          error: Object.assign(new Error('boom'), { status: 502 })
        }
      ])
      const remoteStore = WasRemoteStore.fromGrants({
        parsed,
        zcapClient: stub
      })
      expect(
        await remoteDescriptorSource({ remoteStore }).collectionEncryption({
          collectionId: 'notes'
        })
      ).toBeUndefined()
      expect(
        capture.events.filter(event => event.level === 'warn')
      ).toHaveLength(1)
    } finally {
      setLogger(previous)
    }
  })
})

describe('WasRemoteStore.readCollectionMeta', () => {
  it('returns the raw stored custom value from the collection meta path', async () => {
    // The stored (opaque) envelope, NOT the decoded plaintext: it is what the
    // local store's cipher decodes itself to recover the index schema.
    const stored = { jwe: { protected: 'opaque' } }
    const { calls, zcapClient: stub } = stubZcapClient([
      { status: 200, data: { custom: stored } }
    ])
    const store = WasRemoteStore.fromGrants({ parsed, zcapClient: stub })
    expect(await store.readCollectionMeta('notes')).toEqual({ custom: stored })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      url: 'https://was.example/space/space-1/notes/meta',
      method: 'GET',
      capability: { id: 'urn:zcap:priv' }
    })
  })

  it('returns undefined when no capability covers the collection', async () => {
    const { calls, zcapClient: stub } = stubZcapClient([{ status: 200 }])
    const store = WasRemoteStore.fromGrants({ parsed, zcapClient: stub })
    expect(await store.readCollectionMeta('ungranted')).toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  it('returns undefined for a not-found response', async () => {
    const notFound = Object.assign(new Error('Not Found'), { status: 404 })
    const { calls, zcapClient: stub } = stubZcapClient([
      { status: 404, error: notFound }
    ])
    const store = WasRemoteStore.fromGrants({ parsed, zcapClient: stub })
    expect(await store.readCollectionMeta('notes')).toBeUndefined()
    expect(calls).toHaveLength(1)
  })

  it('returns undefined for a backend without metadata support', async () => {
    const { calls, zcapClient: stub } = stubZcapClient([
      { status: 501, error: new NotImplementedError('no meta') }
    ])
    const store = WasRemoteStore.fromGrants({ parsed, zcapClient: stub })
    expect(await store.readCollectionMeta('notes')).toBeUndefined()
    expect(calls).toHaveLength(1)
  })

  it('rethrows a transient failure, wrapped with the collection id', async () => {
    const badGateway = Object.assign(new Error('Bad Gateway'), { status: 502 })
    const { calls, zcapClient: stub } = stubZcapClient([
      { status: 502, error: badGateway }
    ])
    const store = WasRemoteStore.fromGrants({ parsed, zcapClient: stub })
    const err = (await store.readCollectionMeta('notes').then(
      () => undefined,
      (err: unknown) => err
    )) as Error
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain('"notes"')
    expect(err.cause).toBeInstanceOf(WasServerError)
    expect((err.cause as WasServerError).status).toBe(502)
    expect(calls).toHaveLength(1)
  })
})

describe('WasRemoteStore.declareCollectionIndexes', () => {
  it('skips a private collection and a public one without indexes', async () => {
    const store = WasRemoteStore.fromGrants({
      parsed,
      zcapClient,
      collections: [
        { key: 'posts', id: 'microblog-posts', visibility: 'public' },
        { key: 'notes', id: 'notes' }
      ]
    })
    expect(await store.declareCollectionIndexes('notes')).toEqual({
      collectionId: 'notes',
      ok: true,
      skipped: true
    })
    expect(await store.declareCollectionIndexes('microblog-posts')).toEqual({
      collectionId: 'microblog-posts',
      ok: true,
      skipped: true
    })
  })

  it('PUTs the declared indexes on a public collection', async () => {
    const { calls, zcapClient: stub } = stubZcapClient([{ status: 200 }])
    const store = WasRemoteStore.fromGrants({
      parsed,
      zcapClient: stub,
      collections: [
        {
          key: 'posts',
          id: 'microblog-posts',
          visibility: 'public',
          indexes: ['author', 'inReplyTo']
        }
      ]
    })
    const result = await store.declareCollectionIndexes('microblog-posts')
    expect(result).toEqual({
      collectionId: 'microblog-posts',
      ok: true,
      status: 200
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      url: 'https://was.example/space/space-1/microblog-posts',
      method: 'PUT',
      json: { id: 'microblog-posts', indexes: ['author', 'inReplyTo'] }
    })
  })
})

describe('WasRemoteStore.queryCollectionByEquality', () => {
  const collections = [
    {
      key: 'posts',
      id: 'microblog-posts',
      visibility: 'public' as const,
      indexes: ['author', 'inReplyTo']
    },
    { key: 'notes', id: 'notes' }
  ]

  it('issues the canonical sorted filter GET and parses the page', async () => {
    const { calls, zcapClient: stub } = stubZcapClient([
      {
        status: 200,
        data: {
          documents: [
            { id: 'post-1', data: { id: 'post-1', title: 'One' } },
            { id: 'post-2', data: { id: 'post-2', title: 'Two' } }
          ],
          hasMore: true,
          cursor: 'next-page'
        }
      }
    ])
    const store = WasRemoteStore.fromGrants({
      parsed,
      zcapClient: stub,
      collections
    })
    const page = await store.queryCollectionByEquality({
      collectionId: 'microblog-posts',
      // Deliberately unsorted terms + a value that needs percent-encoding.
      equals: { inReplyTo: 'urn:uuid:1', author: 'did:key:z6Mk' },
      limit: 2
    })
    expect(page).toEqual({
      documents: [
        { id: 'post-1', data: { id: 'post-1', title: 'One' } },
        { id: 'post-2', data: { id: 'post-2', title: 'Two' } }
      ],
      hasMore: true,
      cursor: 'next-page'
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      url:
        'https://was.example/space/space-1/microblog-posts/' +
        '?filter[author]=did%3Akey%3Az6Mk' +
        '&filter[inReplyTo]=urn%3Auuid%3A1&limit=2',
      method: 'GET'
    })
  })

  it('passes the continuation cursor through', async () => {
    const { calls, zcapClient: stub } = stubZcapClient([
      { status: 200, data: { documents: [], hasMore: false } }
    ])
    const store = WasRemoteStore.fromGrants({
      parsed,
      zcapClient: stub,
      collections
    })
    const page = await store.queryCollectionByEquality({
      collectionId: 'microblog-posts',
      equals: { author: 'did:key:z6Mk' },
      cursor: 'next-page'
    })
    expect(page).toEqual({ documents: [], hasMore: false })
    expect(calls[0]?.url).toContain('&cursor=next-page')
  })

  it('fails closed before any request on invalid queries', async () => {
    const { calls, zcapClient: stub } = stubZcapClient([{ status: 200 }])
    const store = WasRemoteStore.fromGrants({
      parsed,
      zcapClient: stub,
      collections
    })
    await expect(
      store.queryCollectionByEquality({
        collectionId: 'unregistered',
        equals: { author: 'x' }
      })
    ).rejects.toThrow(/not in the collection registry/)
    await expect(
      store.queryCollectionByEquality({
        collectionId: 'microblog-posts',
        equals: {}
      })
    ).rejects.toThrow(/at least one term/)
    await expect(
      store.queryCollectionByEquality({
        collectionId: 'microblog-posts',
        equals: { undeclared: 'x' }
      })
    ).rejects.toThrow(/not declared/)
    expect(calls).toHaveLength(0)
  })

  it('rejects a malformed response page', async () => {
    const { zcapClient: stub } = stubZcapClient([
      { status: 200, data: { items: [] } }
    ])
    const store = WasRemoteStore.fromGrants({
      parsed,
      zcapClient: stub,
      collections
    })
    await expect(
      store.queryCollectionByEquality({
        collectionId: 'microblog-posts',
        equals: { author: 'x' }
      })
    ).rejects.toThrow(/Malformed equality query response/)
  })
})

describe('WasRemoteStore.queryCollectionByEquality (blinded)', () => {
  const collections = [
    { key: 'notes', id: 'notes', indexes: ['author', 'inReplyTo'] }
  ]

  it('runs the blinded find and maps the page', async () => {
    const store = WasRemoteStore.fromGrants({
      parsed,
      zcapClient,
      collections,
      keys: identityKeys
    })
    const blob = new Blob(['attachment'])
    const calls = fakeCollectionHandle(store, {
      find: async () => ({
        items: [
          { id: 'env-1', data: { id: 'note-1', author: 'did:key:z6Mk' } },
          { id: 'env-2', data: blob }
        ],
        hasMore: true,
        cursor: 'next-page'
      })
    })
    const page = await store.queryCollectionByEquality({
      collectionId: 'notes',
      equals: { author: 'did:key:z6Mk', inReplyTo: 'urn:uuid:1' },
      limit: 2,
      cursor: 'prior-page'
    })
    expect(page).toEqual({
      documents: [
        { id: 'env-1', data: { id: 'note-1', author: 'did:key:z6Mk' } },
        // A blob decrypts to a `Blob`, so only the id is reported.
        { id: 'env-2' }
      ],
      hasMore: true,
      cursor: 'next-page'
    })
    expect(calls.spaceId).toBe('space-1')
    expect(calls.collectionId).toBe('notes')
    expect(calls.capability).toEqual({ id: 'urn:zcap:priv' })
    // Attribute names are rooted at the EDV document's `content`.
    expect(calls.find).toEqual([
      {
        equals: {
          'content.author': 'did:key:z6Mk',
          'content.inReplyTo': 'urn:uuid:1'
        },
        limit: 2,
        cursor: 'prior-page'
      }
    ])
  })

  it('omits limit and cursor when they were not given', async () => {
    const store = WasRemoteStore.fromGrants({
      parsed,
      zcapClient,
      collections,
      keys: identityKeys
    })
    const calls = fakeCollectionHandle(store, {
      find: async () => ({ items: [], hasMore: false })
    })
    const page = await store.queryCollectionByEquality({
      collectionId: 'notes',
      equals: { author: 'x' }
    })
    expect(page).toEqual({ documents: [], hasMore: false })
    expect(calls.find[0]).toEqual({ equals: { 'content.author': 'x' } })
  })

  it('fails closed on an empty term set and an undeclared attribute', async () => {
    const store = WasRemoteStore.fromGrants({
      parsed,
      zcapClient,
      collections,
      keys: identityKeys
    })
    const calls = fakeCollectionHandle(store, {})
    await expect(
      store.queryCollectionByEquality({ collectionId: 'notes', equals: {} })
    ).rejects.toThrow(/at least one term/)
    await expect(
      store.queryCollectionByEquality({
        collectionId: 'notes',
        equals: { undeclared: 'x' }
      })
    ).rejects.toThrow(/not declared/)
    expect(calls.find).toHaveLength(0)
  })

  it('fails closed when no identity keys were supplied', async () => {
    // No `keys`: the client's keystore cannot build a codec, so nothing could
    // blind the terms or decrypt the results.
    const store = WasRemoteStore.fromGrants({
      parsed,
      zcapClient,
      collections
    })
    const calls = fakeCollectionHandle(store, {})
    await expect(
      store.queryCollectionByEquality({
        collectionId: 'notes',
        equals: { author: 'x' }
      })
    ).rejects.toThrow(/identity keys/)
    expect(calls.find).toHaveLength(0)
  })

  it('fails closed when no grant covers the collection', async () => {
    const store = WasRemoteStore.fromGrants({
      parsed,
      zcapClient,
      collections: [{ key: 'other', id: 'ungranted', indexes: ['author'] }],
      keys: identityKeys
    })
    await expect(
      store.queryCollectionByEquality({
        collectionId: 'ungranted',
        equals: { author: 'x' }
      })
    ).rejects.toThrow(/No delegated capability covers/)
  })
})

describe('WasRemoteStore.declareBlindedIndexes', () => {
  const epochs = [{ id: 'did:key:zEpoch1', recipients: [] }]
  const withHmac = {
    scheme: 'edv' as const,
    currentEpoch: 'did:key:zEpoch1',
    epochs,
    hmac: { id: 'urn:hmac:1', type: 'Sha256HmacKey2019', recipients: [] }
  }

  it('skips a public collection and a private one without indexes', async () => {
    const store = WasRemoteStore.fromGrants({
      parsed,
      zcapClient,
      collections: [
        {
          key: 'posts',
          id: 'microblog-posts',
          visibility: 'public',
          indexes: ['author']
        },
        { key: 'notes', id: 'notes' }
      ],
      keys: identityKeys
    })
    expect(
      await store.declareBlindedIndexes('microblog-posts', {
        encryption: undefined
      })
    ).toEqual({ collectionId: 'microblog-posts', ok: true, skipped: true })
    expect(
      await store.declareBlindedIndexes('notes', { encryption: withHmac })
    ).toEqual({ collectionId: 'notes', ok: true, skipped: true })
  })

  it('reports a descriptor with no blinded-index key as not ok', async () => {
    const store = WasRemoteStore.fromGrants({
      parsed,
      zcapClient,
      collections: [{ key: 'notes', id: 'notes', indexes: ['author'] }],
      keys: identityKeys
    })
    const calls = fakeCollectionHandle(store, {})
    const result = await store.declareBlindedIndexes('notes', {
      encryption: { scheme: 'edv', currentEpoch: 'did:key:zEpoch1', epochs }
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/without a blinded-index key/)
    expect(calls.declared).toHaveLength(0)
  })

  it('declares only the attributes not already persisted', async () => {
    const store = WasRemoteStore.fromGrants({
      parsed,
      zcapClient,
      collections: [
        { key: 'notes', id: 'notes', indexes: ['author', 'inReplyTo'] }
      ],
      keys: identityKeys
    })
    const calls = fakeCollectionHandle(store, {
      indexes: async () => [{ attribute: 'content.author' }]
    })
    expect(
      await store.declareBlindedIndexes('notes', { encryption: withHmac })
    ).toEqual({ collectionId: 'notes', ok: true })
    expect(calls.declared).toEqual(['content.inReplyTo'])
    expect(calls.capability).toEqual({ id: 'urn:zcap:priv' })
  })

  it('reports a failed declaration rather than throwing', async () => {
    const store = WasRemoteStore.fromGrants({
      parsed,
      zcapClient,
      collections: [{ key: 'notes', id: 'notes', indexes: ['author'] }],
      keys: identityKeys
    })
    fakeCollectionHandle(store, {
      indexes: async () => {
        throw new Error('meta read refused')
      }
    })
    const result = await store.declareBlindedIndexes('notes', {
      encryption: withHmac
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/meta read refused/)
  })

  it('reports a missing capability and missing identity keys', async () => {
    const ungranted = WasRemoteStore.fromGrants({
      parsed,
      zcapClient,
      collections: [{ key: 'other', id: 'ungranted', indexes: ['author'] }],
      keys: identityKeys
    })
    expect(
      await ungranted.declareBlindedIndexes('ungranted', {
        encryption: withHmac
      })
    ).toEqual({
      collectionId: 'ungranted',
      ok: false,
      error: 'no capability'
    })
    const keyless = WasRemoteStore.fromGrants({
      parsed,
      zcapClient,
      collections: [{ key: 'notes', id: 'notes', indexes: ['author'] }]
    })
    expect(
      await keyless.declareBlindedIndexes('notes', { encryption: withHmac })
    ).toEqual({ collectionId: 'notes', ok: false, error: 'no identity keys' })
  })
})

describe('WasRemoteStore.publicUrlFor', () => {
  const collections = [
    { key: 'posts', id: 'microblog-posts', visibility: 'public' as const },
    { key: 'notes', id: 'notes' }
  ]

  it('composes the stable resource URL for a public collection', () => {
    const store = WasRemoteStore.fromGrants({ parsed, zcapClient, collections })
    expect(
      store.publicUrlFor({ collectionId: 'microblog-posts', id: 'post-1' })
    ).toBe('https://was.example/space/space-1/microblog-posts/post-1')
  })

  it('percent-encodes the resource id', () => {
    const store = WasRemoteStore.fromGrants({ parsed, zcapClient, collections })
    expect(
      store.publicUrlFor({
        collectionId: 'microblog-posts',
        id: 'urn:uuid:a/b'
      })
    ).toBe(
      'https://was.example/space/space-1/microblog-posts/urn%3Auuid%3Aa%2Fb'
    )
  })

  it('throws on a private / unregistered collection', () => {
    const store = WasRemoteStore.fromGrants({ parsed, zcapClient, collections })
    expect(() =>
      store.publicUrlFor({ collectionId: 'notes', id: 'post-1' })
    ).toThrow(/not registered as public/)
    expect(() =>
      store.publicUrlFor({ collectionId: 'unknown', id: 'post-1' })
    ).toThrow(/not registered as public/)
  })

  it('throws on an empty id', () => {
    const store = WasRemoteStore.fromGrants({ parsed, zcapClient, collections })
    expect(() =>
      store.publicUrlFor({ collectionId: 'microblog-posts', id: '' })
    ).toThrow(/non-empty document id/)
  })

  it('throws when no grant covers the collection', () => {
    // Registered public in the config, but no delegated capability covers it.
    const store = WasRemoteStore.fromGrants({
      parsed,
      zcapClient,
      collections: [
        { key: 'shared', id: 'shared-notes', visibility: 'public' as const }
      ]
    })
    expect(() =>
      store.publicUrlFor({ collectionId: 'shared-notes', id: 'post-1' })
    ).toThrow(/No delegated capability covers/)
  })
})
