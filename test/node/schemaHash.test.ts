/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The replica schema is stored state: RxDB hashes the declared schema and
 * refuses to open an existing collection whose stored hash differs at the same
 * `version`. The schema this library now declares comes from
 * `@interop/was-sync` and adds `createdBy`, so a replica created under the
 * previous shape cannot be reopened.
 *
 * This test pins that refusal, and with it the CHANGELOG's note that every
 * remembered browser has to clear its local data and log in again once. It
 * ships at `version: 0` with no migration strategy, which is the greenfield
 * answer rather than an oversight: if this test ever goes green, the note has
 * gone stale.
 *
 * @vitest-environment node
 */
import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { createRxDatabase } from 'rxdb/plugins/core'
import { getRxStorageDexie } from 'rxdb/plugins/storage-dexie'
import { syncedDocSchema } from '@interop/was-sync'

/**
 * The synced-doc schema exactly as this library declared it before the driver
 * moved to `@interop/was-sync`: no `createdBy` property. Inlined rather than
 * imported, since the module it came from is deleted; it exists here only to
 * create a replica under the old hash.
 *
 * @returns {object}
 */
function previousSyncedDocSchema(): Record<string, unknown> {
  return {
    version: 0,
    primaryKey: 'id',
    type: 'object',
    properties: {
      id: { type: 'string', maxLength: 256 },
      updatedAt: { type: 'string', maxLength: 64 },
      version: { type: 'number' },
      metaVersion: { type: 'number' },
      epoch: { type: 'string', maxLength: 256 },
      data: { type: 'object', additionalProperties: true },
      custom: { type: 'object', additionalProperties: true }
    },
    required: ['id', 'updatedAt', 'version'],
    indexes: ['updatedAt']
  }
}

describe('the synced-doc schema hash', () => {
  it('refuses to reopen a replica created under the previous shape', async () => {
    const name = `schemahash${Date.now()}`
    const open = async () =>
      await createRxDatabase({
        name,
        storage: getRxStorageDexie(),
        closeDuplicates: true,
        multiInstance: false
      })

    const before = await open()
    await before.addCollections({
      notes: { schema: previousSyncedDocSchema() as never }
    })
    await before.close()

    const after = await open()
    await expect(
      after.addCollections({ notes: { schema: syncedDocSchema() as never } })
    ).rejects.toThrow()
    await after.close()
  })
})
