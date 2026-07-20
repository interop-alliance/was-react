/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
import { describe, expect, it } from 'vitest'
import type { ZcapClient } from '@interop/ezcap'
import type { IZcap } from '@interop/data-integrity-core'
import { WasRemoteStore } from './wasRemoteStore.js'
import type { ParsedGrants } from '../grants.js'

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
function stubZcapClient(responses: Array<{ status: number; data?: unknown }>) {
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
      return response
    }
  }
  return { calls, zcapClient: client as unknown as ZcapClient }
}

describe('WasRemoteStore.markCollectionEncrypted', () => {
  it('skips the marker PUT for a public collection (ok + skipped)', async () => {
    const store = WasRemoteStore.fromGrants({
      parsed,
      zcapClient,
      collections: [
        { key: 'posts', id: 'microblog-posts', visibility: 'public' },
        { key: 'notes', id: 'notes' }
      ]
    })
    // Resolves without any network round trip: the PUT is never attempted.
    const result = await store.markCollectionEncrypted('microblog-posts')
    expect(result).toEqual({
      collectionId: 'microblog-posts',
      ok: true,
      skipped: true
    })
  })

  it('reports a missing capability for an ungranted private collection', async () => {
    const store = WasRemoteStore.fromGrants({ parsed, zcapClient })
    const result = await store.markCollectionEncrypted('unknown-collection')
    expect(result).toEqual({
      collectionId: 'unknown-collection',
      ok: false,
      error: 'no capability'
    })
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
        collectionId: 'notes',
        equals: { author: 'x' }
      })
    ).rejects.toThrow(/not registered as public/)
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
