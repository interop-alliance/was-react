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

  it('accepts equality indexes on a public collection', () => {
    expect(() =>
      validateCollections([
        {
          key: 'posts',
          id: 'microblog-posts',
          visibility: 'public',
          indexes: ['author', 'inReplyTo']
        }
      ])
    ).not.toThrow()
  })

  it('rejects indexes on a private collection (fail-closed)', () => {
    expect(() =>
      validateCollections([{ key: 'notes', id: 'notes', indexes: ['author'] }])
    ).toThrow(/require a public/)
  })

  it('rejects empty and duplicate index attribute names', () => {
    expect(() =>
      validateCollections([
        { key: 'posts', id: 'posts', visibility: 'public', indexes: [''] }
      ])
    ).toThrow(/empty index attribute/)
    expect(() =>
      validateCollections([
        {
          key: 'posts',
          id: 'posts',
          visibility: 'public',
          indexes: ['author', 'author']
        }
      ])
    ).toThrow(/twice/)
  })

  it('rejects diverging index declarations for the same WAS id', () => {
    expect(() =>
      validateCollections([
        { key: 'a', id: 'shared', visibility: 'public', indexes: ['author'] },
        { key: 'b', id: 'shared', visibility: 'public', indexes: ['tag'] }
      ])
    ).toThrow(/diverging index/)
    // Identical declarations (in any order) are fine.
    expect(() =>
      validateCollections([
        {
          key: 'a',
          id: 'shared',
          visibility: 'public',
          indexes: ['author', 'tag']
        },
        {
          key: 'b',
          id: 'shared',
          visibility: 'public',
          indexes: ['tag', 'author']
        }
      ])
    ).not.toThrow()
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
