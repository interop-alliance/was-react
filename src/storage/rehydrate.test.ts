/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Json } from '../sync/index.js'
import type { StoreRegistry } from '../config.js'
import type { LocalStore } from './localStore.js'
import { setLocalStore, clearLocalStore } from './storageManager.js'
import {
  patchFromChange,
  hydrateAll,
  clearAllEntityStores,
  scheduleRehydrate
} from './rehydrate.js'

// A fake LocalStore: `decryptEnvelope` unwraps `{ jwe: payload }` (mirroring the
// lww handler test's fake cipher); the envelope index calls just record.
function makeFakeStore({ failDecrypt = false } = {}): {
  store: LocalStore
  remembered: Array<[string, string, string]>
  forgotten: Array<[string, string]>
} {
  const remembered: Array<[string, string, string]> = []
  const forgotten: Array<[string, string]> = []
  const store = {
    decryptEnvelope: async (_key: string, envelope: Json) => {
      if (failDecrypt) {
        throw new Error('decrypt failed')
      }
      return (envelope as { jwe: Json }).jwe
    },
    rememberEnvelope: (key: string, uuid: string, envelopeId: string) => {
      remembered.push([key, uuid, envelopeId])
    },
    forgetEnvelope: (key: string, uuid: string) => {
      forgotten.push([key, uuid])
    }
  } as unknown as LocalStore
  return { store, remembered, forgotten }
}

// A fake registry entry that records what the mechanism drives.
function makeRegistry(): {
  registry: StoreRegistry
  calls: {
    hydrate: number
    upsert: Array<{ id: string }>
    drop: string[]
    clear: number
  }
} {
  const calls = {
    hydrate: 0,
    upsert: [] as Array<{ id: string }>,
    drop: [] as string[],
    clear: 0
  }
  const registry: StoreRegistry = {
    notes: {
      hydrate: async () => {
        calls.hydrate += 1
      },
      upsert: doc => {
        calls.upsert.push(doc)
      },
      drop: uuid => {
        calls.drop.push(uuid)
      },
      clear: () => {
        calls.clear += 1
      }
    }
  }
  return { registry, calls }
}

function envelope(payload: { id: string }): Json {
  return { jwe: payload } as unknown as Json
}

afterEach(() => {
  clearLocalStore()
})

describe('rehydrate mechanism', () => {
  it('hydrateAll drives every registry entry', async () => {
    const { registry, calls } = makeRegistry()
    await hydrateAll(registry)
    expect(calls.hydrate).toBe(1)
  })

  it('clearAllEntityStores drives every registry entry', () => {
    const { registry, calls } = makeRegistry()
    clearAllEntityStores(registry)
    expect(calls.clear).toBe(1)
  })

  describe('patchFromChange', () => {
    beforeEach(() => {
      const { store } = makeFakeStore()
      setLocalStore(store)
    })

    it('upserts an inserted payload and remembers its envelope', async () => {
      const { store, remembered } = makeFakeStore()
      setLocalStore(store)
      const { registry, calls } = makeRegistry()
      const payload = { id: 'note-1' }
      await patchFromChange(registry, 'notes', {
        operation: 'INSERT',
        documentData: { id: 'env-1', data: envelope(payload) }
      })
      expect(calls.upsert).toEqual([payload])
      expect(calls.drop).toEqual([])
      expect(remembered).toEqual([['notes', 'note-1', 'env-1']])
    })

    it('drops a deleted payload and forgets its envelope', async () => {
      const { store, forgotten } = makeFakeStore()
      setLocalStore(store)
      const { registry, calls } = makeRegistry()
      await patchFromChange(registry, 'notes', {
        operation: 'DELETE',
        documentData: { id: 'env-1', data: envelope({ id: 'note-1' }) }
      })
      expect(calls.drop).toEqual(['note-1'])
      expect(calls.upsert).toEqual([])
      expect(forgotten).toEqual([['notes', 'note-1']])
    })

    it('drops on a soft-delete (_deleted) row', async () => {
      const { store } = makeFakeStore()
      setLocalStore(store)
      const { registry, calls } = makeRegistry()
      await patchFromChange(registry, 'notes', {
        operation: 'UPDATE',
        documentData: {
          id: 'env-1',
          data: envelope({ id: 'note-1' }),
          _deleted: true
        }
      })
      expect(calls.drop).toEqual(['note-1'])
    })

    it('is a no-op for an unregistered collection', async () => {
      const { registry, calls } = makeRegistry()
      await patchFromChange(registry, 'unknown', {
        operation: 'INSERT',
        documentData: { id: 'env-1', data: envelope({ id: 'x' }) }
      })
      expect(calls.upsert).toEqual([])
      expect(calls.drop).toEqual([])
    })

    it('schedules a re-hydrate when the envelope is missing', async () => {
      vi.useFakeTimers()
      try {
        const { registry, calls } = makeRegistry()
        await patchFromChange(registry, 'notes', {
          operation: 'INSERT',
          documentData: { id: 'env-1' }
        })
        expect(calls.upsert).toEqual([])
        await vi.advanceTimersByTimeAsync(60)
        expect(calls.hydrate).toBe(1)
      } finally {
        vi.useRealTimers()
      }
    })

    it('schedules a re-hydrate when decryption fails', async () => {
      vi.useFakeTimers()
      try {
        const { store } = makeFakeStore({ failDecrypt: true })
        setLocalStore(store)
        const { registry, calls } = makeRegistry()
        await patchFromChange(registry, 'notes', {
          operation: 'INSERT',
          documentData: { id: 'env-1', data: envelope({ id: 'note-1' }) }
        })
        expect(calls.upsert).toEqual([])
        await vi.advanceTimersByTimeAsync(60)
        expect(calls.hydrate).toBe(1)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  it('scheduleRehydrate is a no-op for an unregistered collection', () => {
    vi.useFakeTimers()
    try {
      const { registry, calls } = makeRegistry()
      scheduleRehydrate(registry, 'unknown')
      vi.advanceTimersByTime(60)
      expect(calls.hydrate).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
