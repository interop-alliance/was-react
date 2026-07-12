/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Unit tests for `createWasSyncPort`'s HTTP-status-to-typed-error mapping,
 * driven by a fake `WasClient` whose `request` rejects with a scripted status.
 * The port maps `412` to {@link WasSyncConflictError} and `401` / `403` to
 * {@link WasSyncAuthError} on both the query (pull) and the conditional-write
 * (push) paths; every other status propagates unchanged.
 */
import { describe, it, expect } from 'vitest'
import type { WasClient } from '@interop/was-client'
import { createWasSyncPort, errorStatus } from './wasSyncPort.js'
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
