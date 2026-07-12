/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Unit tests for the changes-feed master re-read (`withFeedMasterRead`), driven
 * by a fake base port whose `query` returns scripted feed pages -- no server, no
 * RxDB engine. Covers the found / genuinely-absent / exhausted-scan paths.
 */
import { describe, it, expect } from 'vitest'
import { withFeedMasterRead } from './feedMasterPort.js'
import type { SyncCheckpoint, WasSyncBasePort, WireDoc } from './types.js'

/**
 * A fake base port that serves `pages` of the changes feed, one page per
 * `query` call. When `endless` is set, every page is full and always carries a
 * non-null checkpoint, so a scan never reaches the feed's end (models a feed
 * larger than the page-scan budget). The write methods are unused here.
 */
function fakeBasePort(
  options: { pages?: WireDoc[][]; endless?: WireDoc[] } = {}
): WasSyncBasePort & { queryCalls: number } {
  const pages = options.pages ?? []
  const state = { queryCalls: 0 }
  return {
    get queryCalls() {
      return state.queryCalls
    },
    async query(): Promise<{
      documents: WireDoc[]
      checkpoint: SyncCheckpoint | null
    }> {
      const page = state.queryCalls
      state.queryCalls++
      if (options.endless !== undefined) {
        const last = options.endless[options.endless.length - 1]!
        return {
          documents: options.endless,
          checkpoint: { id: last.id, updatedAt: last.updatedAt }
        }
      }
      const documents = pages[page] ?? []
      const last = documents[documents.length - 1]
      // A final (or empty) page ends the feed with `checkpoint: null`.
      const isLast = page >= pages.length - 1 || documents.length === 0
      return {
        documents,
        checkpoint:
          isLast || last === undefined
            ? null
            : { id: last.id, updatedAt: last.updatedAt }
      }
    },
    async putContent() {
      return undefined
    },
    async deleteContent() {
      return undefined
    },
    async putMeta() {
      return undefined
    }
  }
}

function wire(over: Partial<WireDoc> & { id: string }): WireDoc {
  return {
    _deleted: false,
    updatedAt: '2026-01-01T00:00:00Z',
    version: 1,
    ...over
  }
}

describe('withFeedMasterRead get', () => {
  it('resolves the master state from the feed body when the resource is found', async () => {
    const base = fakeBasePort({
      pages: [
        [
          wire({ id: 'other', version: 4 }),
          wire({ id: 'r1', version: 7, data: { a: 1 }, metaVersion: 2 })
        ]
      ]
    })
    const port = withFeedMasterRead(base)

    const master = await port.get({ id: 'r1' })

    expect(master).toEqual({
      version: 7,
      updatedAt: '2026-01-01T00:00:00Z',
      deleted: false,
      data: { a: 1 },
      metaVersion: 2
    })
  })

  it('returns null when the scan reaches the feed end without the resource', async () => {
    // A completed scan (checkpoint: null) that never saw the id: genuinely
    // absent (a delete/delete race), so the conflict assembler tombstones it.
    const base = fakeBasePort({
      pages: [[wire({ id: 'a' }), wire({ id: 'b' })]]
    })
    const port = withFeedMasterRead(base)

    const master = await port.get({ id: 'missing' })

    expect(master).toBeNull()
  })

  it('returns null when the feed is empty', async () => {
    const base = fakeBasePort({ pages: [[]] })
    const port = withFeedMasterRead(base)

    expect(await port.get({ id: 'r1' })).toBeNull()
  })

  it('throws a retryable error when the page-scan budget is exhausted', async () => {
    // A feed that never ends and never contains the id: the scan runs out of
    // its page budget without reaching the end. Reporting null here would
    // fabricate a false tombstone, so `get` must throw so replication retries.
    const base = fakeBasePort({ endless: [wire({ id: 'other' })] })
    const port = withFeedMasterRead(base)

    await expect(port.get({ id: 'r1' })).rejects.toThrow(
      /exhausted its .* scan budget/
    )
    // It scanned the full budget (MAX_PAGES) before giving up.
    expect(base.queryCalls).toBe(50)
  })
})
