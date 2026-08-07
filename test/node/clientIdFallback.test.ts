/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Unit test for `getClientId` in an environment without `localStorage` (this
 * file runs in plain Node): instead of throwing, it falls back to a
 * process-stable unpersisted id, so every LWW stamp within one run still
 * agrees on the writer.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { getClientId } from '../../src/storage/storageManager.js'

describe('getClientId without localStorage', () => {
  it('falls back to one process-stable id instead of throwing', () => {
    const first = getClientId()
    expect(first.length).toBeGreaterThan(0)
    expect(getClientId()).toBe(first)
    // The fallback is shared across prefixes -- there is no store to key on.
    expect(getClientId({ storageKeyPrefix: 'myapp:' })).toBe(first)
  })
})
