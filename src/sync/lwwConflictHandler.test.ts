/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
import { describe, it, expect } from 'vitest'
import type { WithDeleted } from 'rxdb/plugins/core'
import type { Json, SyncedDoc } from './types.js'
import { makeLwwConflictHandler } from './lwwConflictHandler.js'

// A fake cipher whose "envelope" is just the plaintext payload wrapped in
// `{ jwe: payload }`; decrypt unwraps it. Lets us drive the handler's LWW
// decision without real crypto.
const decrypt = async (envelope: Json): Promise<Json> =>
  (envelope as { jwe: Json }).jwe

function row(
  payload: { updatedAt: string; deviceId: string } | null,
  { deleted = false, version = 0 }: { deleted?: boolean; version?: number } = {}
): WithDeleted<SyncedDoc> {
  const doc: WithDeleted<SyncedDoc> = {
    id: 'r1',
    updatedAt: '2026-01-01T00:00:00Z',
    version,
    _deleted: deleted
  }
  if (payload !== null) {
    doc.data = { jwe: payload } as unknown as Json
  }
  return doc
}

const handler = makeLwwConflictHandler(decrypt)

describe('makeLwwConflictHandler', () => {
  it('isEqual is true only when body + deletion agree', () => {
    const a = row({ updatedAt: 't1', deviceId: 'd1' })
    const b = row({ updatedAt: 't1', deviceId: 'd1' })
    const c = row({ updatedAt: 't2', deviceId: 'd1' })
    expect(handler.isEqual(a, b)).toBe(true)
    expect(handler.isEqual(a, c)).toBe(false)
    expect(handler.isEqual(a, { ...b, _deleted: true })).toBe(false)
  })

  it('resolves to the later payload (remote wins)', async () => {
    const remote = row({ updatedAt: '2026-02-02T00:00:00Z', deviceId: 'dB' })
    const local = row({ updatedAt: '2026-01-01T00:00:00Z', deviceId: 'dA' })
    const winner = await handler.resolve({
      realMasterState: remote,
      newDocumentState: local
    })
    expect(winner).toBe(remote)
  })

  it('resolves to the later payload (local wins)', async () => {
    const remote = row({ updatedAt: '2026-01-01T00:00:00Z', deviceId: 'dB' })
    const local = row({ updatedAt: '2026-02-02T00:00:00Z', deviceId: 'dA' })
    const winner = await handler.resolve({
      realMasterState: remote,
      newDocumentState: local
    })
    expect(winner).toBe(local)
  })

  it('breaks an exact updatedAt tie by greater deviceId', async () => {
    const remote = row({ updatedAt: 'T', deviceId: 'dZ' })
    const local = row({ updatedAt: 'T', deviceId: 'dA' })
    const winner = await handler.resolve({
      realMasterState: remote,
      newDocumentState: local
    })
    expect(winner).toBe(remote)
  })

  it('keeps a live local edit over a remote tombstone', async () => {
    const remote = row(null, { deleted: true, version: 3 })
    const local = row({ updatedAt: 'T', deviceId: 'dA' })
    const winner = await handler.resolve({
      realMasterState: remote,
      newDocumentState: local
    })
    expect(winner).toBe(local)
  })

  it('defaults to the master when incomparable (local tombstone)', async () => {
    const remote = row({ updatedAt: 'T', deviceId: 'dB' }, { version: 2 })
    const local = row(null, { deleted: true })
    const winner = await handler.resolve({
      realMasterState: remote,
      newDocumentState: local
    })
    expect(winner).toBe(remote)
  })
})
