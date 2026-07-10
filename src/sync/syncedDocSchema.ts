/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The single generic RxDB JSON schema reused across every synced collection.
 * One shape (`{ id, updatedAt, version, metaVersion?, data?, custom? }`) carries
 * both a content revision and an independently-versioned metadata sub-resource;
 * `_deleted` is added by RxDB via `deletedField`. `data` / `custom` are opaque
 * bodies (plaintext JSON, or an EDV envelope on an encrypted collection), so
 * they are typed as free-form objects.
 */
import type { RxJsonSchema } from 'rxdb/plugins/core'
import type { SyncedDoc } from './types.js'

/**
 * Returns the synced-doc schema. `id` is the primary key (the WAS resourceId);
 * `updatedAt` is indexed because it is the change-feed sort field / checkpoint
 * component.
 *
 * @returns {RxJsonSchema<SyncedDoc>}
 */
export function syncedDocSchema(): RxJsonSchema<SyncedDoc> {
  return {
    version: 0,
    primaryKey: 'id',
    type: 'object',
    properties: {
      id: { type: 'string', maxLength: 256 },
      updatedAt: { type: 'string', maxLength: 64 },
      version: { type: 'number' },
      metaVersion: { type: 'number' },
      // Opaque stored bodies -- content and metadata envelopes -- moved verbatim.
      data: { type: 'object', additionalProperties: true },
      custom: { type: 'object', additionalProperties: true }
    },
    required: ['id', 'updatedAt', 'version'],
    indexes: ['updatedAt']
  } as RxJsonSchema<SyncedDoc>
}
