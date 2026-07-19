/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
import { describe, expect, it } from 'vitest'
import { validateCollections, type WasCollectionConfig } from './config.js'

describe('validateCollections', () => {
  it('accepts an empty registry and default/explicit visibilities', () => {
    expect(() => validateCollections([])).not.toThrow()
    expect(() =>
      validateCollections([
        { key: 'notes', id: 'notes' },
        { key: 'drafts', id: 'drafts', visibility: 'private' },
        { key: 'posts', id: 'microblog-posts', visibility: 'public' }
      ])
    ).not.toThrow()
  })

  it('accepts the same WAS id under two keys with matching visibility', () => {
    expect(() =>
      validateCollections([
        { key: 'a', id: 'shared', visibility: 'public' },
        { key: 'b', id: 'shared', visibility: 'public' }
      ])
    ).not.toThrow()
    expect(() =>
      validateCollections([
        { key: 'a', id: 'shared' },
        { key: 'b', id: 'shared', visibility: 'private' }
      ])
    ).not.toThrow()
  })

  it('rejects an unknown visibility value (fail-closed)', () => {
    const collections = [
      { key: 'posts', id: 'posts', visibility: 'unlisted' }
    ] as unknown as WasCollectionConfig[]
    expect(() => validateCollections(collections)).toThrow(/unknown visibility/)
  })

  it('rejects the same WAS id registered as both private and public', () => {
    expect(() =>
      validateCollections([
        { key: 'a', id: 'shared' },
        { key: 'b', id: 'shared', visibility: 'public' }
      ])
    ).toThrow(/encrypted and public/)
    expect(() =>
      validateCollections([
        { key: 'a', id: 'shared', visibility: 'public' },
        { key: 'b', id: 'shared', visibility: 'private' }
      ])
    ).toThrow(/encrypted and public/)
  })
})
