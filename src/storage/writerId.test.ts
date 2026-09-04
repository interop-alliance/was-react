/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Unit tests for the persisted writer-id wipe: {@link clearPersistedWriterId}
 * removes both the current and the pre-rename localStorage keys, so a
 * subsequent {@link getWriterId} mints a fresh id rather than reading a
 * leftover one. `getWriterId` itself (mint-once, custom prefix, legacy-key
 * migration) is covered by `test/node/writerId.test.ts`.
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { clearPersistedWriterId, getWriterId } from './writerId.js'
import { DEFAULT_STORAGE_KEY_PREFIX } from '../config.js'

beforeEach(() => {
  localStorage.clear()
})

describe('clearPersistedWriterId', () => {
  it('removes the persisted id so a later getWriterId mints a fresh one', () => {
    const first = getWriterId()
    clearPersistedWriterId()
    expect(
      localStorage.getItem(`${DEFAULT_STORAGE_KEY_PREFIX}writerId`)
    ).toBeNull()

    const second = getWriterId()
    expect(second).not.toBe(first)
  })

  it('removes the pre-rename legacy key too', () => {
    localStorage.setItem(`${DEFAULT_STORAGE_KEY_PREFIX}clientId`, 'legacy-id')
    clearPersistedWriterId()
    expect(
      localStorage.getItem(`${DEFAULT_STORAGE_KEY_PREFIX}clientId`)
    ).toBeNull()
  })

  it('only clears the configured prefix, leaving other prefixes intact', () => {
    getWriterId({ storageKeyPrefix: 'myapp:' })
    const defaulted = getWriterId()

    clearPersistedWriterId({ storageKeyPrefix: 'myapp:' })

    expect(localStorage.getItem('myapp:writerId')).toBeNull()
    expect(localStorage.getItem(`${DEFAULT_STORAGE_KEY_PREFIX}writerId`)).toBe(
      defaulted
    )
  })
})
