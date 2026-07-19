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
