/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Unit tests for the push side of the sync adapter (conditional-write routing
 * and the 412 conflict assembler), driven by a fake WAS port -- no server, no
 * RxDB engine.
 */
import { describe, it, expect } from 'vitest'
import type { WithDeleted } from 'rxdb/plugins/core'
import { createPushHandler, formatEtag } from './pushWrites.js'
import {
  WasSyncConflictError,
  type MasterState,
  type SyncedDoc,
  type WasSyncPort
} from './types.js'

type WriteCall =
  | {
      kind: 'putContent'
      id: string
      data: unknown
      ifMatch?: string
      ifNoneMatch?: boolean
    }
  | { kind: 'deleteContent'; id: string; ifMatch?: string }
  | {
      kind: 'putMeta'
      id: string
      custom: unknown
      ifMatch?: string
      ifNoneMatch?: boolean
    }

/**
 * A fake port that records every write, optionally throws a conflict for a
 * chosen (kind,id), and serves a scripted `get` master state for the re-read.
 */
function fakePushPort(
  options: {
    conflictOn?: { kind: WriteCall['kind']; id: string }
    master?: MasterState | null
  } = {}
): WasSyncPort & { writes: WriteCall[]; getCalls: string[] } {
  const writes: WriteCall[] = []
  const getCalls: string[] = []
  const maybeConflict = (kind: WriteCall['kind'], id: string) => {
    if (options.conflictOn?.kind === kind && options.conflictOn.id === id) {
      throw new WasSyncConflictError()
    }
  }
  return {
    writes,
    getCalls,
    async query() {
      return { documents: [], checkpoint: null }
    },
    async putContent({ id, data, ifMatch, ifNoneMatch }) {
      writes.push({ kind: 'putContent', id, data, ifMatch, ifNoneMatch })
      maybeConflict('putContent', id)
    },
    async deleteContent({ id, ifMatch }) {
      writes.push({ kind: 'deleteContent', id, ifMatch })
      maybeConflict('deleteContent', id)
    },
    async putMeta({ id, custom, ifMatch, ifNoneMatch }) {
      writes.push({ kind: 'putMeta', id, custom, ifMatch, ifNoneMatch })
      maybeConflict('putMeta', id)
    },
    async get({ id }) {
      getCalls.push(id)
      return options.master ?? null
    }
  }
}

function newDoc(over: Partial<WithDeleted<SyncedDoc>>): WithDeleted<SyncedDoc> {
  return {
    id: 'r1',
    updatedAt: '2026-01-01T00:00:00Z',
    version: 0,
    _deleted: false,
    ...over
  }
}

describe('createPushHandler routing', () => {
  it('creates content with If-None-Match when there is no assumed master', async () => {
    const port = fakePushPort()
    const push = createPushHandler(port)

    const conflicts = await push([
      { newDocumentState: newDoc({ id: 'r1', data: { a: 1 } }) }
    ])

    expect(conflicts).toEqual([])
    expect(port.writes).toEqual([
      { kind: 'putContent', id: 'r1', data: { a: 1 }, ifNoneMatch: true }
    ])
  })

  it('creates content then metadata (content first) on a create with custom', async () => {
    const port = fakePushPort()
    const push = createPushHandler(port)

    await push([
      {
        newDocumentState: newDoc({
          id: 'r1',
          data: { a: 1 },
          custom: { jwe: 'x' }
        })
      }
    ])

    expect(port.writes.map(w => w.kind)).toEqual(['putContent', 'putMeta'])
    expect(port.writes[1]).toEqual({
      kind: 'putMeta',
      id: 'r1',
      custom: { jwe: 'x' },
      ifNoneMatch: true
    })
  })

  it('updates content with If-Match "<version>" when the body changed', async () => {
    const port = fakePushPort()
    const push = createPushHandler(port)

    await push([
      {
        assumedMasterState: newDoc({ version: 5, data: { a: 1 } }),
        newDocumentState: newDoc({ version: 5, data: { a: 2 } })
      }
    ])

    expect(port.writes).toEqual([
      { kind: 'putContent', id: 'r1', data: { a: 2 }, ifMatch: formatEtag(5) }
    ])
  })

  it('routes a metadata-only change to /meta with If-Match "<metaVersion>", no content write', async () => {
    const port = fakePushPort()
    const push = createPushHandler(port)

    await push([
      {
        assumedMasterState: newDoc({
          version: 5,
          metaVersion: 2,
          data: { a: 1 },
          custom: { jwe: 'old' }
        }),
        newDocumentState: newDoc({
          version: 5,
          metaVersion: 2,
          data: { a: 1 },
          custom: { jwe: 'new' }
        })
      }
    ])

    expect(port.writes).toEqual([
      {
        kind: 'putMeta',
        id: 'r1',
        custom: { jwe: 'new' },
        ifMatch: formatEtag(2)
      }
    ])
  })

  it('creates metadata with If-None-Match when the master has no metaVersion yet', async () => {
    const port = fakePushPort()
    const push = createPushHandler(port)

    await push([
      {
        assumedMasterState: newDoc({ version: 5, data: { a: 1 } }),
        newDocumentState: newDoc({
          version: 5,
          data: { a: 1 },
          custom: { jwe: 'x' }
        })
      }
    ])

    expect(port.writes).toEqual([
      { kind: 'putMeta', id: 'r1', custom: { jwe: 'x' }, ifNoneMatch: true }
    ])
  })

  it('deletes with If-Match "<version>" and skips any metadata write', async () => {
    const port = fakePushPort()
    const push = createPushHandler(port)

    await push([
      {
        assumedMasterState: newDoc({ version: 7, data: { a: 1 } }),
        newDocumentState: newDoc({
          version: 7,
          _deleted: true,
          custom: { jwe: 'x' }
        })
      }
    ])

    expect(port.writes).toEqual([
      { kind: 'deleteContent', id: 'r1', ifMatch: formatEtag(7) }
    ])
  })
})

describe('createPushHandler conflicts', () => {
  it('re-reads and returns the master state on a 412', async () => {
    const master: MasterState = {
      version: 9,
      updatedAt: '2026-02-02T00:00:00Z',
      deleted: false,
      data: { a: 99 }
    }
    const port = fakePushPort({
      conflictOn: { kind: 'putContent', id: 'r1' },
      master
    })
    const push = createPushHandler(port)

    const conflicts = await push([
      { newDocumentState: newDoc({ id: 'r1', data: { a: 1 } }) }
    ])

    expect(port.getCalls).toEqual(['r1'])
    expect(conflicts).toEqual([
      {
        id: 'r1',
        updatedAt: '2026-02-02T00:00:00Z',
        version: 9,
        data: { a: 99 },
        _deleted: false
      }
    ])
  })

  it('synthesizes a tombstone conflict when the resource is now absent', async () => {
    const port = fakePushPort({
      conflictOn: { kind: 'deleteContent', id: 'r1' },
      master: null
    })
    const push = createPushHandler(port)

    const conflicts = await push([
      {
        assumedMasterState: newDoc({ version: 4, data: { a: 1 } }),
        newDocumentState: newDoc({ version: 4, _deleted: true })
      }
    ])

    expect(conflicts).toEqual([
      {
        id: 'r1',
        updatedAt: '2026-01-01T00:00:00Z',
        version: 4,
        _deleted: true
      }
    ])
  })

  it('carries metaVersion/custom into the assembled conflict', async () => {
    const master: MasterState = {
      version: 3,
      metaVersion: 6,
      updatedAt: '2026-03-03T00:00:00Z',
      deleted: false,
      data: { a: 1 },
      custom: { jwe: 'srv' }
    }
    const port = fakePushPort({
      conflictOn: { kind: 'putMeta', id: 'r1' },
      master
    })
    const push = createPushHandler(port)

    const conflicts = await push([
      {
        assumedMasterState: newDoc({
          version: 3,
          metaVersion: 5,
          data: { a: 1 },
          custom: { jwe: 'old' }
        }),
        newDocumentState: newDoc({
          version: 3,
          metaVersion: 5,
          data: { a: 1 },
          custom: { jwe: 'mine' }
        })
      }
    ])

    expect(conflicts[0]).toMatchObject({
      id: 'r1',
      version: 3,
      metaVersion: 6,
      custom: { jwe: 'srv' },
      _deleted: false
    })
  })

  it('propagates a non-conflict error so RxDB retries the batch', async () => {
    const port: WasSyncPort = {
      async query() {
        return { documents: [], checkpoint: null }
      },
      async putContent() {
        throw new Error('network down')
      },
      async deleteContent() {},
      async putMeta() {},
      async get() {
        return null
      }
    }
    const push = createPushHandler(port)

    await expect(
      push([{ newDocumentState: newDoc({ data: { a: 1 } }) }])
    ).rejects.toThrow('network down')
  })

  it('processes multiple rows and returns only the conflicting ones', async () => {
    const port = fakePushPort({
      conflictOn: { kind: 'putContent', id: 'bad' },
      master: {
        version: 1,
        updatedAt: '2026-01-05T00:00:00Z',
        deleted: false,
        data: { server: true }
      }
    })
    const push = createPushHandler(port)

    const conflicts = await push([
      { newDocumentState: newDoc({ id: 'ok', data: { a: 1 } }) },
      { newDocumentState: newDoc({ id: 'bad', data: { a: 2 } }) }
    ])

    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]!.id).toBe('bad')
  })
})
