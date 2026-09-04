/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Unit tests for the storage manager: the process-wide ACTIVE
 * {@link StorageContext} pointer and the facades (`requireWriterId`,
 * `stampLww`) that resolve to it.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { StorageContext } from './storageContext.js'
import {
  activateStorageContext,
  deactivateStorageContext,
  requireWriterId,
  stampLww
} from './storageManager.js'

let context: StorageContext | undefined

afterEach(() => {
  if (context) {
    deactivateStorageContext(context)
    context = undefined
  }
})

describe('requireWriterId', () => {
  it('throws while no storage context is active', () => {
    expect(() => requireWriterId()).toThrow(/No storage context is active/)
  })

  it('resolves to the active context writer id', () => {
    context = new StorageContext({ registry: {}, writerId: 'writer-1' })
    activateStorageContext(context)
    expect(requireWriterId()).toBe('writer-1')
  })

  it('tracks resetWriterId on the active context', () => {
    context = new StorageContext({ registry: {}, writerId: 'writer-1' })
    activateStorageContext(context)
    const next = context.resetWriterId()
    expect(requireWriterId()).toBe(next)
    expect(requireWriterId()).not.toBe('writer-1')
  })
})

describe('stampLww', () => {
  it('stamps a parseable instant and the active context writer id', () => {
    context = new StorageContext({ registry: {}, writerId: 'writer-2' })
    activateStorageContext(context)
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
    context = new StorageContext({ registry: {}, writerId: 'writer-3' })
    activateStorageContext(context)
    const stamped = stampLww({
      id: 'a',
      updatedAt: '1999-01-01T00:00:00.000Z',
      writerId: 'someone-else'
    })

    expect(stamped.writerId).toBe('writer-3')
    expect(stamped.updatedAt).not.toBe('1999-01-01T00:00:00.000Z')
  })

  it('stamps with the id resetWriterId changes to', () => {
    context = new StorageContext({ registry: {}, writerId: 'writer-4' })
    activateStorageContext(context)
    const next = context.resetWriterId()
    const stamped = stampLww({ id: 'a' })
    expect(stamped.writerId).toBe(next)
    expect(stamped.writerId).not.toBe('writer-4')
  })
})
