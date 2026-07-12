/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Unit tests for `deriveSyncRollup`, the per-collection-to-aggregate rollup that
 * backs `useSyncStatus`. Covers the offline (no collections) case and the
 * error > syncing > synced precedence (with `idle` counted as syncing).
 */
import { describe, it, expect } from 'vitest'
import { deriveSyncRollup } from './syncStatusStore.js'

describe('deriveSyncRollup', () => {
  it('reports offline when no collections are registered', () => {
    expect(deriveSyncRollup([]).state).toBe('offline')
  })

  it('reports error when any collection errored (highest precedence)', () => {
    expect(deriveSyncRollup(['synced', 'syncing', 'error']).state).toBe('error')
    expect(deriveSyncRollup(['error', 'idle']).state).toBe('error')
  })

  it('reports syncing when a collection is syncing or idle (no error)', () => {
    expect(deriveSyncRollup(['synced', 'syncing']).state).toBe('syncing')
    expect(deriveSyncRollup(['idle', 'synced']).state).toBe('syncing')
  })

  it('reports synced only when every collection is synced', () => {
    expect(deriveSyncRollup(['synced', 'synced']).state).toBe('synced')
  })

  it('carries a label and title for each rollup state', () => {
    for (const rollup of [
      deriveSyncRollup([]),
      deriveSyncRollup(['error']),
      deriveSyncRollup(['syncing']),
      deriveSyncRollup(['synced'])
    ]) {
      expect(rollup.label.length).toBeGreaterThan(0)
      expect(rollup.title.length).toBeGreaterThan(0)
    }
  })
})
