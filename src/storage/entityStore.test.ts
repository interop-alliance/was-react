/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
import { describe, it, expect, afterEach } from 'vitest'
import type { LocalStore } from './localStore.js'
import { setLocalStore, clearLocalStore } from './storageManager.js'
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

  it('replaceAll resets the Map and discards a buffered pull burst', async () => {
    const store = createEntityStore<Note>('notes')
    store.getState().patch({ id: 'stale-1', text: 'stale' })
    store.getState().patch({ id: 'stale-2', text: 'stale' })

    // Clear-on-logout while the burst is still buffered: the reset wins and
    // the pending flush must not resurrect the stale docs.
    store.getState().replaceAll([])
    await flushMicrotasks()

    expect(store.getState().byId.size).toBe(0)
    expect(store.getState().hydrated).toBe(true)

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
})
