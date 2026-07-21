/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
import { describe, it, expect, afterEach } from 'vitest'
import type { LocalStore } from './localStore.js'
import type { WasRemoteStore } from './wasRemoteStore.js'
import {
  setLocalStore,
  clearLocalStore,
  setRemoteStore,
  clearRemoteStore
} from './storageManager.js'
import { createEntityStore } from './entityStore.js'

interface Note {
  id: string
  text: string
}

/**
 * Yields one microtask turn so the store's coalesced flush runs.
 */
function flushMicrotasks(): Promise<void> {
  return Promise.resolve()
}

afterEach(() => {
  clearLocalStore()
  clearRemoteStore()
})

describe('createEntityStore', () => {
  it('coalesces a pull burst of patches into a single store update', async () => {
    const store = createEntityStore<Note>('notes')
    let notifications = 0
    const seenMaps = new Set<Map<string, Note>>()
    const unsubscribe = store.subscribe(state => {
      notifications += 1
      seenMaps.add(state.byId)
    })

    for (let index = 0; index < 5; index++) {
      store.getState().patch({ id: `note-${index}`, text: `t${index}` })
    }
    // Nothing is applied synchronously; the burst is still buffered.
    expect(store.getState().byId.size).toBe(0)
    expect(notifications).toBe(0)

    await flushMicrotasks()

    expect(notifications).toBe(1)
    expect(seenMaps.size).toBe(1)
    expect(store.getState().byId.size).toBe(5)
    expect(store.getState().byId.get('note-3')).toEqual({
      id: 'note-3',
      text: 't3'
    })
    unsubscribe()
  })

  it('preserves insert/drop ordering within a burst', async () => {
    const store = createEntityStore<Note>('notes')
    // upsert A, upsert B, drop A, upsert C -- the net result keeps B and C and
    // drops A, and a later drop then re-upsert of B keeps B present.
    store.getState().patch({ id: 'a', text: 'a1' })
    store.getState().patch({ id: 'b', text: 'b1' })
    store.getState().drop('a')
    store.getState().patch({ id: 'c', text: 'c1' })
    store.getState().drop('b')
    store.getState().patch({ id: 'b', text: 'b2' })

    await flushMicrotasks()

    const { byId } = store.getState()
    expect(byId.has('a')).toBe(false)
    expect(byId.get('b')).toEqual({ id: 'b', text: 'b2' })
    expect(byId.get('c')).toEqual({ id: 'c', text: 'c1' })
    expect(byId.size).toBe(2)
  })

  it('does not re-render when a burst only drops absent ids', async () => {
    const store = createEntityStore<Note>('notes')
    const before = store.getState().byId
    let notifications = 0
    const unsubscribe = store.subscribe(() => {
      notifications += 1
    })

    store.getState().drop('missing-1')
    store.getState().drop('missing-2')
    await flushMicrotasks()

    expect(notifications).toBe(0)
    expect(store.getState().byId).toBe(before)
    unsubscribe()
  })

  it('discards a stale patch that loses LWW to the held doc', async () => {
    interface LwwNote extends Note {
      updatedAt: string
      clientId: string
    }
    const store = createEntityStore<LwwNote>('notes')
    const newer = {
      id: 'a',
      text: 'newer',
      updatedAt: '2026-07-12T10:00:05Z',
      clientId: 'device-1'
    }
    const older = {
      id: 'a',
      text: 'older',
      updatedAt: '2026-07-12T10:00:00Z',
      clientId: 'device-2'
    }

    // Out-of-order decrypts within one burst: the older payload arrives last.
    store.getState().patch(newer)
    store.getState().patch(older)
    await flushMicrotasks()
    expect(store.getState().byId.get('a')).toEqual(newer)

    // A stale pull echo across bursts must not clobber the held doc either.
    store.getState().patch(older)
    await flushMicrotasks()
    expect(store.getState().byId.get('a')).toEqual(newer)

    // A genuinely newer payload still replaces it.
    const newest = {
      ...newer,
      text: 'newest',
      updatedAt: '2026-07-12T10:00:10Z'
    }
    store.getState().patch(newest)
    await flushMicrotasks()
    expect(store.getState().byId.get('a')).toEqual(newest)
  })

  it('patches docs without LWW fields blindly (last patch wins)', async () => {
    const store = createEntityStore<Note>('notes')
    store.getState().patch({ id: 'a', text: 'first' })
    await flushMicrotasks()
    store.getState().patch({ id: 'a', text: 'second' })
    await flushMicrotasks()
    expect(store.getState().byId.get('a')).toEqual({ id: 'a', text: 'second' })
  })

  it('replaceAll resets the Map and discards a buffered pull burst', async () => {
    const store = createEntityStore<Note>('notes')
    store.getState().patch({ id: 'stale-1', text: 'stale' })
    store.getState().patch({ id: 'stale-2', text: 'stale' })

    // Clear-on-logout while the burst is still buffered: the reset wins and
    // the pending flush must not resurrect the stale docs.
    store.getState().replaceAll([])
    await flushMicrotasks()

    expect(store.getState().byId.size).toBe(0)

    store.getState().replaceAll([{ id: 'fresh', text: 'fresh' }])
    expect(store.getState().byId.get('fresh')).toEqual({
      id: 'fresh',
      text: 'fresh'
    })
  })

  it('applies interactive local writes immediately (unbatched)', async () => {
    const inserted: Array<[string, Note]> = []
    const store = createEntityStore<Note>('notes')
    setLocalStore({
      insertEntity: async (key: string, doc: Note) => {
        inserted.push([key, doc])
      }
    } as unknown as LocalStore)

    await store.getState().insert({ id: 'local-1', text: 'hi' })

    // The insert's `set` fired as soon as the persist resolved -- no microtask
    // flush needed.
    expect(store.getState().byId.get('local-1')).toEqual({
      id: 'local-1',
      text: 'hi'
    })
    expect(inserted).toEqual([['notes', { id: 'local-1', text: 'hi' }]])
  })

  it('upsert persists through upsertEntity and sets the doc immediately', async () => {
    const upserted: Array<[string, Note]> = []
    const store = createEntityStore<Note>('notes')
    setLocalStore({
      upsertEntity: async (key: string, doc: Note) => {
        upserted.push([key, doc])
      }
    } as unknown as LocalStore)

    await store.getState().upsert({ id: 'solo', text: 'v1' })
    await store.getState().upsert({ id: 'solo', text: 'v2' })

    expect(store.getState().byId.get('solo')).toEqual({
      id: 'solo',
      text: 'v2'
    })
    expect(store.getState().byId.size).toBe(1)
    expect(upserted).toEqual([
      ['notes', { id: 'solo', text: 'v1' }],
      ['notes', { id: 'solo', text: 'v2' }]
    ])
  })

  it('query routes key to WAS id and maps the page to payloads', async () => {
    const store = createEntityStore<Note>('notes')
    setLocalStore({
      collectionConfig: (key: string) => ({
        key,
        id: 'shared-notes',
        visibility: 'public',
        indexes: ['text']
      })
    } as unknown as LocalStore)
    const queries: unknown[] = []
    setRemoteStore({
      queryCollectionByEquality: async (query: unknown) => {
        queries.push(query)
        return {
          documents: [
            { id: 'a', data: { id: 'a', text: 'hi' } },
            // A blob resource carries no JSON content; it is omitted from docs.
            { id: 'blob', custom: { name: 'pic' } }
          ],
          hasMore: true,
          cursor: 'more'
        }
      }
    } as unknown as WasRemoteStore)

    const page = await store
      .getState()
      .query({ equals: { text: 'hi' }, limit: 10 })

    expect(queries).toEqual([
      { collectionId: 'shared-notes', equals: { text: 'hi' }, limit: 10 }
    ])
    expect(page).toEqual({
      docs: [{ id: 'a', text: 'hi' }],
      hasMore: true,
      cursor: 'more'
    })
    // A read verb: the Map is untouched.
    expect(store.getState().byId.size).toBe(0)
  })

  it('query throws while no wallet-connected session holds a remote store', async () => {
    const store = createEntityStore<Note>('notes')
    setLocalStore({
      collectionConfig: () => ({ id: 'shared-notes' })
    } as unknown as LocalStore)

    await expect(
      store.getState().query({ equals: { text: 'hi' } })
    ).rejects.toThrow(/connect a wallet session/)
  })
})
