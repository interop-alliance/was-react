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

  it('isEqual is false when only the server revision differs (feed echo)', () => {
    // Our own write echoing back from the changes feed: byte-identical body,
    // but one revision ahead. It must NOT compare equal, so the local row
    // adopts the server version and later If-Match headers stay in step.
    const local = row({ updatedAt: 't1', deviceId: 'd1' }, { version: 0 })
    const echo = row({ updatedAt: 't1', deviceId: 'd1' }, { version: 1 })
    expect(handler.isEqual(local, echo)).toBe(false)
    expect(handler.isEqual(echo, { ...echo })).toBe(true)
    expect(handler.isEqual(echo, { ...echo, metaVersion: 1 })).toBe(false)
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

  it('re-asserts a local tombstone on a version-only conflict (delete after a synced create)', async () => {
    // The classic dropped-delete: the row's If-Match was one revision stale,
    // but the master's content is exactly what this replica last synced. The
    // tombstone must survive resolution and be re-pushed -- not resurrect.
    const payload = { updatedAt: 'T', deviceId: 'dA' }
    const assumed = row(payload, { version: 0 })
    const master = row(payload, { version: 1 })
    const tombstone = row(null, { deleted: true })
    const winner = await handler.resolve({
      realMasterState: master,
      newDocumentState: tombstone,
      assumedMasterState: assumed
    })
    expect(winner).toBe(tombstone)
  })

  it('re-asserts a local edit on a version-only conflict', async () => {
    const payload = { updatedAt: 'T1', deviceId: 'dA' }
    const assumed = row(payload, { version: 0 })
    const master = row(payload, { version: 1 })
    const edit = row({ updatedAt: 'T2', deviceId: 'dA' })
    const winner = await handler.resolve({
      realMasterState: master,
      newDocumentState: edit,
      assumedMasterState: assumed
    })
    expect(winner).toBe(edit)
  })

  it('lets a genuine remote edit beat a local tombstone (delete-vs-edit race)', async () => {
    // The master's content REALLY changed since this replica last synced (a
    // concurrent edit on another device won the push race): the edit wins and
    // the entity resurrects, deterministically on every replica.
    const assumed = row({ updatedAt: 'T1', deviceId: 'dA' }, { version: 1 })
    const master = row({ updatedAt: 'T2', deviceId: 'dB' }, { version: 2 })
    const tombstone = row(null, { deleted: true })
    const winner = await handler.resolve({
      realMasterState: master,
      newDocumentState: tombstone,
      assumedMasterState: assumed
    })
    expect(winner).toBe(master)
  })

  it('re-asserts a local tombstone against a remote tombstone race (both deleted)', async () => {
    // A delete/delete race that 412s: the master is already a tombstone with
    // no data, matching the assumed master shape -- keeping either converges;
    // the version-only rule keeps the local one.
    const assumed = row(null, { deleted: true, version: 1 })
    const master = row(null, { deleted: true, version: 2 })
    const tombstone = row(null, { deleted: true, version: 1 })
    const winner = await handler.resolve({
      realMasterState: master,
      newDocumentState: tombstone,
      assumedMasterState: assumed
    })
    expect(winner).toBe(tombstone)
  })
})
