/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { WithDeleted } from 'rxdb/plugins/core'
import type { Json, SyncedDoc } from './types.js'
import { makeLwwConflictHandler } from './lwwConflictHandler.js'

// The marker body an "unreadable" envelope carries: the epoch-aware fake cipher
// below throws for it, standing in for an envelope written under a key epoch
// this device has not seen.
const SEALED = 'sealed-under-an-unseen-epoch'

// A fake cipher whose "envelope" is just the plaintext payload wrapped in
// `{ jwe: payload }`; decrypt unwraps it. Lets us drive the handler's LWW
// decision without real crypto.
const decrypt = async (envelope: Json): Promise<Json> => {
  const { jwe } = envelope as { jwe: Json }
  if (jwe === SEALED) {
    // Shaped like the real UnknownEpochError: the decrypt THROWS rather than
    // returning a payload with no LWW stamp.
    throw new Error('Unknown key epoch "e9".')
  }
  return jwe
}

function row(
  payload: { updatedAt: string; clientId: string } | null,
  {
    deleted = false,
    version = 0,
    metaVersion,
    custom
  }: {
    deleted?: boolean
    version?: number
    metaVersion?: number
    custom?: Json
  } = {}
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
  if (metaVersion !== undefined) {
    doc.metaVersion = metaVersion
  }
  if (custom !== undefined) {
    doc.custom = custom
  }
  return doc
}

/**
 * A live row whose body does not decrypt on this device (an envelope under an
 * unseen key epoch), as distinct from a tombstone or a body with no LWW stamp.
 */
function sealedRow(version = 0): WithDeleted<SyncedDoc> {
  return {
    id: 'r1',
    updatedAt: '2026-01-01T00:00:00Z',
    version,
    _deleted: false,
    data: { jwe: SEALED } as unknown as Json
  }
}

const handler = makeLwwConflictHandler(decrypt)

afterEach(() => {
  vi.restoreAllMocks()
})

describe('makeLwwConflictHandler', () => {
  it('isEqual is true only when body + deletion agree', () => {
    const a = row({ updatedAt: 't1', clientId: 'd1' })
    const b = row({ updatedAt: 't1', clientId: 'd1' })
    const c = row({ updatedAt: 't2', clientId: 'd1' })
    expect(handler.isEqual(a, b)).toBe(true)
    expect(handler.isEqual(a, c)).toBe(false)
    expect(handler.isEqual(a, { ...b, _deleted: true })).toBe(false)
  })

  it('isEqual is false when only the server revision differs (feed echo)', () => {
    // Our own write echoing back from the changes feed: byte-identical body,
    // but one revision ahead. It must NOT compare equal, so the local row
    // adopts the server version and later If-Match headers stay in step.
    const local = row({ updatedAt: 't1', clientId: 'd1' }, { version: 0 })
    const echo = row({ updatedAt: 't1', clientId: 'd1' }, { version: 1 })
    expect(handler.isEqual(local, echo)).toBe(false)
    expect(handler.isEqual(echo, { ...echo })).toBe(true)
    expect(handler.isEqual(echo, { ...echo, metaVersion: 1 })).toBe(false)
  })

  it('resolves to the later payload (remote wins)', async () => {
    const remote = row({ updatedAt: '2026-02-02T00:00:00Z', clientId: 'dB' })
    const local = row({ updatedAt: '2026-01-01T00:00:00Z', clientId: 'dA' })
    const winner = await handler.resolve({
      realMasterState: remote,
      newDocumentState: local
    })
    expect(winner).toBe(remote)
  })

  it('resolves to the later payload (local wins)', async () => {
    const remote = row({ updatedAt: '2026-01-01T00:00:00Z', clientId: 'dB' })
    const local = row({ updatedAt: '2026-02-02T00:00:00Z', clientId: 'dA' })
    const winner = await handler.resolve({
      realMasterState: remote,
      newDocumentState: local
    })
    expect(winner).toBe(local)
  })

  it('breaks an exact updatedAt tie by greater clientId', async () => {
    const remote = row({ updatedAt: 'T', clientId: 'dZ' })
    const local = row({ updatedAt: 'T', clientId: 'dA' })
    const winner = await handler.resolve({
      realMasterState: remote,
      newDocumentState: local
    })
    expect(winner).toBe(remote)
  })

  it('keeps a live local edit over a remote tombstone', async () => {
    const remote = row(null, { deleted: true, version: 3 })
    const local = row({ updatedAt: 'T', clientId: 'dA' })
    const winner = await handler.resolve({
      realMasterState: remote,
      newDocumentState: local
    })
    expect(winner).toBe(local)
  })

  it('defaults to the master when incomparable (local tombstone)', async () => {
    const remote = row({ updatedAt: 'T', clientId: 'dB' }, { version: 2 })
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
    const payload = { updatedAt: 'T', clientId: 'dA' }
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
    const payload = { updatedAt: 'T1', clientId: 'dA' }
    const assumed = row(payload, { version: 0 })
    const master = row(payload, { version: 1 })
    const edit = row({ updatedAt: 'T2', clientId: 'dA' })
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
    const assumed = row({ updatedAt: 'T1', clientId: 'dA' }, { version: 1 })
    const master = row({ updatedAt: 'T2', clientId: 'dB' }, { version: 2 })
    const tombstone = row(null, { deleted: true })
    const winner = await handler.resolve({
      realMasterState: master,
      newDocumentState: tombstone,
      assumedMasterState: assumed
    })
    expect(winner).toBe(master)
  })

  it('lets the real master win for custom on a metadata-only conflict (no data change)', async () => {
    // Devices A and B both edit only `custom` of the same resource. A's
    // `/meta` write commits first (metaVersion bumps); B's putMeta 412s, so the
    // assembled master carries A's committed `custom` with `data` unchanged.
    // The equal-`data` LWW payloads would tie and keep B's stale `custom`; rule
    // 2 instead adopts the server-committed metadata so A's edit is not lost.
    const payload = { updatedAt: 'T', clientId: 'dA' }
    const assumed = row(payload, {
      version: 3,
      metaVersion: 1,
      custom: { jwe: 'C0' }
    })
    const master = row(payload, {
      version: 3,
      metaVersion: 2,
      custom: { jwe: 'Ca' }
    })
    const localEdit = row(payload, {
      version: 3,
      metaVersion: 1,
      custom: { jwe: 'Cb' }
    })
    const winner = await handler.resolve({
      realMasterState: master,
      newDocumentState: localEdit,
      assumedMasterState: assumed
    })
    expect(winner).toBe(master)
  })

  it('re-asserts local state on a version-only conflict when custom is also unchanged', async () => {
    // Both `data` and `custom` match the assumed master (only the revision
    // moved), so rule 1 fires even though metadata exists: keep the local edit.
    const payload = { updatedAt: 'T1', clientId: 'dA' }
    const assumed = row(payload, {
      version: 0,
      metaVersion: 1,
      custom: { jwe: 'C0' }
    })
    const master = row(payload, {
      version: 1,
      metaVersion: 1,
      custom: { jwe: 'C0' }
    })
    const edit = row(
      { updatedAt: 'T2', clientId: 'dA' },
      { version: 0, metaVersion: 1, custom: { jwe: 'C0' } }
    )
    const winner = await handler.resolve({
      realMasterState: master,
      newDocumentState: edit,
      assumedMasterState: assumed
    })
    expect(winner).toBe(edit)
  })

  it('adopts an undecryptable master rather than re-pushing the older local payload', async () => {
    // The master was written under a key epoch this device has not seen, so its
    // decrypt throws. It must NOT be scored as absent: an unreadable body is
    // presumed newer, so the master is adopted and the older local payload is
    // not pushed over it.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const master = sealedRow(2)
    const local = row({ updatedAt: '2026-01-01T00:00:00Z', clientId: 'dA' })
    const winner = await handler.resolve({
      realMasterState: master,
      newDocumentState: local
    })
    expect(winner).toBe(master)
    expect(warn).toHaveBeenCalledOnce()
  })

  it('re-asserts an undecryptable local row rather than dropping the local edit', async () => {
    // The mirror case: this replica cannot read its OWN row (e.g. it was
    // written under an epoch since rotated away). Dropping it for the master
    // would silently lose the user's edit, so the local row is re-asserted.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const master = row(
      { updatedAt: '2026-02-02T00:00:00Z', clientId: 'dB' },
      {
        version: 2
      }
    )
    const local = sealedRow(1)
    const winner = await handler.resolve({
      realMasterState: master,
      newDocumentState: local
    })
    expect(winner).toBe(local)
    expect(warn).toHaveBeenCalledOnce()
  })

  it('adopts the master when neither side decrypts', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const master = sealedRow(2)
    const local = sealedRow(1)
    const winner = await handler.resolve({
      realMasterState: master,
      newDocumentState: local
    })
    expect(winner).toBe(master)
    expect(warn).toHaveBeenCalledOnce()
  })

  it('still treats a tombstone as absent, not as undecryptable', async () => {
    // Regression for the three-kind split: a tombstone has nothing to decrypt,
    // so the tombstone rules must still apply -- a live local edit beats a
    // remote tombstone, and a local tombstone loses to a real remote change --
    // with no warning logged.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const localEdit = row({ updatedAt: '2026-01-01T00:00:00Z', clientId: 'dA' })
    expect(
      await handler.resolve({
        realMasterState: row(null, { deleted: true, version: 3 }),
        newDocumentState: localEdit
      })
    ).toBe(localEdit)

    const assumed = row({ updatedAt: 'T1', clientId: 'dA' }, { version: 1 })
    const master = row({ updatedAt: 'T2', clientId: 'dB' }, { version: 2 })
    expect(
      await handler.resolve({
        realMasterState: master,
        newDocumentState: row(null, { deleted: true }),
        assumedMasterState: assumed
      })
    ).toBe(master)
    expect(warn).not.toHaveBeenCalled()
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
