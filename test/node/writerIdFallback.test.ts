/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Unit test for this library's writer-id binding in an environment without
 * `localStorage` (this file runs in plain Node): the module still imports, and
 * `getWriterId` mints a fresh id per call instead of throwing. The binding
 * reads the global lazily for exactly this reason; the package's mint answers
 * the same way for any storage that throws.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { getWriterId } from '../../src/storage/writerId.js'

describe('getWriterId without localStorage', () => {
  it('mints a fresh id per call instead of throwing', () => {
    const first = getWriterId()
    expect(first.length).toBeGreaterThan(0)
    expect(getWriterId()).not.toBe(first)
    expect(getWriterId({ storageKeyPrefix: 'myapp:' })).not.toBe(first)
  })
})
