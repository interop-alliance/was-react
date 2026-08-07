/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Unit tests for `createWasSyncPort`'s HTTP-status-to-typed-error mapping,
 * driven by a fake `WasClient` whose `request` rejects with a scripted status.
 * The port maps `412` to {@link WasSyncConflictError} and `401` / `403` / `404`
 * (a WAS server masks a failed capability invocation as `404`) to
 * {@link WasSyncAuthError} on both the query (pull) and the conditional-write
 * (push) paths; every other status propagates unchanged, and a `404` on delete
 * stays the already-absent success.
 */
import { describe, it, expect } from 'vitest'
import type { WasClient } from '@interop/was-client'
import { errorStatus } from '@interop/was-client/sync'
import { createWasSyncPort } from './wasSyncPort.js'
import { WasSyncAuthError, WasSyncConflictError } from './types.js'

/**
 * A fake `WasClient` whose `request` always rejects with an error carrying the
 * given HTTP status, so a test can assert how the port maps that status.
 */
function rejectingClient(status: number): WasClient {
  return {
    request: async () => {
      throw Object.assign(new Error(`HTTP ${status}`), { status })
    }
  } as unknown as WasClient
}

function makePort(status: number) {
  return createWasSyncPort({
    was: rejectingClient(status),
    spaceId: 'space-1',
    collectionId: 'notes'
  })
}

/**
 * One recorded `was.request()` call: what the port put on the wire.
 */
interface RequestCall {
  path: string
  method: string
  json?: unknown
  headers?: Record<string, string>
}

/**
 * A fake `WasClient` whose `request` records the call and answers like a
 * versioning server (an `ETag` the port parses into the acked revision), so a
 * test can assert the request the port BUILT rather than only its error
 * mapping.
 */
function recordingPort(etag = '"3"') {
  const calls: RequestCall[] = []
  const was = {
    request: async (options: RequestCall) => {
      calls.push(options)
      return { data: {}, headers: new Headers({ etag }) }
    }
  } as unknown as WasClient
  const port = createWasSyncPort({
    was,
    spaceId: 'space-1',
    collectionId: 'notes'
  })
  return { calls, port }
}

describe('createWasSyncPort error mapping', () => {
  it('maps a 401 on the query (pull) path to WasSyncAuthError', async () => {
    const port = makePort(401)
    await expect(port.query({ limit: 10 })).rejects.toBeInstanceOf(
      WasSyncAuthError
    )
  })

  it('maps a 403 on a conditional write to WasSyncAuthError', async () => {
    const port = makePort(403)
    await expect(
      port.putContent({ id: 'a', data: { x: 1 } })
    ).rejects.toBeInstanceOf(WasSyncAuthError)
  })

  it('carries the offending status on the WasSyncAuthError', async () => {
    const port = makePort(401)
    await expect(port.putMeta({ id: 'a', custom: {} })).rejects.toMatchObject({
      name: 'WasSyncAuthError',
      status: 401
    })
  })

  it('maps a 412 conditional write to WasSyncConflictError', async () => {
    const port = makePort(412)
    await expect(port.deleteContent({ id: 'a' })).rejects.toBeInstanceOf(
      WasSyncConflictError
    )
  })

  it('treats a 404 on delete as success (resource already gone)', async () => {
    const port = makePort(404)
    await expect(port.deleteContent({ id: 'a' })).resolves.toBeUndefined()
  })

  it('maps a 404 on a content write to WasSyncAuthError (masked denial)', async () => {
    const port = makePort(404)
    await expect(
      port.putContent({ id: 'a', data: { x: 1 } })
    ).rejects.toMatchObject({ name: 'WasSyncAuthError', status: 404 })
  })

  it('maps a 404 on the query (pull) path to WasSyncAuthError', async () => {
    const port = makePort(404)
    await expect(port.query({ limit: 10 })).rejects.toBeInstanceOf(
      WasSyncAuthError
    )
  })

  it('passes a non-mapped status (500) through unchanged', async () => {
    const port = makePort(500)
    await expect(port.query({ limit: 10 })).rejects.not.toBeInstanceOf(
      WasSyncAuthError
    )
    await expect(port.query({ limit: 10 })).rejects.toMatchObject({
      status: 500
    })
  })
})

describe('createWasSyncPort request building', () => {
  it('sends the key epoch as the was-key-epoch header on a content write', async () => {
    const { calls, port } = recordingPort()

    const version = await port.putContent({
      id: 'a b',
      data: { x: 1 },
      ifMatch: '"2"',
      epoch: 'e2'
    })

    expect(version).toBe(3)
    expect(calls[0]).toMatchObject({
      path: '/space/space-1/notes/a%20b',
      method: 'PUT',
      json: { x: 1 }
    })
    expect(calls[0]!.headers).toEqual({
      'if-match': '"2"',
      'was-key-epoch': 'e2'
    })
  })

  it('sends no was-key-epoch header when the write carries no epoch', async () => {
    const { calls, port } = recordingPort()

    await port.putContent({ id: 'a', data: { x: 1 }, ifNoneMatch: true })

    expect(calls[0]!.headers).toEqual({ 'if-none-match': '*' })
  })

  it('sends { custom } on a metadata write that carries metadata', async () => {
    const { calls, port } = recordingPort()

    const metaVersion = await port.putMeta({
      id: 'a',
      custom: { jwe: 'x' },
      ifMatch: '"1"'
    })

    expect(metaVersion).toBe(3)
    expect(calls[0]).toMatchObject({
      path: '/space/space-1/notes/a/meta',
      method: 'PUT',
      json: { custom: { jwe: 'x' } }
    })
  })

  it('sends an empty body (the cleared state) when custom is absent', async () => {
    // The /meta PUT is a full replace: a body with no `custom` member clears
    // the resource's metadata, which is how a metadata clear replicates.
    const { calls, port } = recordingPort()

    await port.putMeta({ id: 'a', ifMatch: '"1"' })

    expect(calls[0]!.json).toEqual({})
    expect('custom' in (calls[0]!.json as object)).toBe(false)
  })
})

describe('errorStatus', () => {
  it('reads a top-level status', () => {
    expect(errorStatus({ status: 403 })).toBe(403)
  })

  it('falls back to response.status', () => {
    expect(errorStatus({ response: { status: 401 } })).toBe(401)
  })

  it('returns undefined when no status is present', () => {
    expect(errorStatus(new Error('boom'))).toBeUndefined()
  })
})
