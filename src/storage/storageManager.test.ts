/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Unit tests for the writer-id holder and the shared LWW stamping helper. The
 * holder is module-level, so the "unset" assertion runs first, before any test
 * installs a value.
 */
import { describe, it, expect } from 'vitest'
import { requireWriterId, setWriterId, stampLww } from './storageManager.js'

describe('requireWriterId', () => {
  it('throws while no writer id has been installed', () => {
    expect(() => requireWriterId()).toThrow(/Writer id is not resolved/)
  })

  it('returns the installed writer id', () => {
    setWriterId('writer-1')
    expect(requireWriterId()).toBe('writer-1')
  })
})

describe('stampLww', () => {
  it('stamps a parseable instant and the resolved writer id', () => {
    setWriterId('writer-2')
    const before = Date.now()
    const stamped = stampLww({ id: 'a', text: 'hi' })

    expect(stamped.id).toBe('a')
    expect(stamped.text).toBe('hi')
    expect(stamped.writerId).toBe('writer-2')
    const stampedAt = Date.parse(stamped.updatedAt)
    expect(Number.isNaN(stampedAt)).toBe(false)
    expect(stampedAt).toBeGreaterThanOrEqual(before)
  })

  it('overwrites caller-supplied LWW fields', () => {
    setWriterId('writer-3')
    const stamped = stampLww({
      id: 'a',
      updatedAt: '1999-01-01T00:00:00.000Z',
      writerId: 'someone-else'
    })

    expect(stamped.writerId).toBe('writer-3')
    expect(stamped.updatedAt).not.toBe('1999-01-01T00:00:00.000Z')
  })
})
