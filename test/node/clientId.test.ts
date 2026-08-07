/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Unit tests for the per-install LWW client id wiring: `getClientId` persists
 * under the configured `storageKeyPrefix`, and `createAuthStore` resolves the
 * id once from `WasAppConfig.storageKeyPrefix` and exposes it on the session
 * state -- the migration affordance the config documents (a prior install's
 * prefixed id is preserved, and the adoption repair stamps with the same
 * identity as the app's own writes).
 *
 * @vitest-environment jsdom
 */
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { getClientId } from '../../src/storage/storageManager.js'
import { createAuthStore } from '../../src/session/authStore.js'
import { DEFAULT_STORAGE_KEY_PREFIX } from '../../src/config.js'
import type { WasAppConfig } from '../../src/config.js'

function baseConfig(): WasAppConfig {
  return {
    appName: 'Test App',
    appOrigin: 'http://localhost:5173',
    collections: [{ key: 'notes', id: 'notes' }],
    credential: {
      credentialType: 'TestAppKey',
      vocabBase: 'urn:test-app:vocab#'
    }
  }
}

beforeEach(() => {
  localStorage.clear()
})

describe('getClientId', () => {
  it('mints once and stays stable under the default prefix', () => {
    const first = getClientId()
    expect(first.length).toBeGreaterThan(0)
    expect(getClientId()).toBe(first)
    expect(localStorage.getItem(`${DEFAULT_STORAGE_KEY_PREFIX}clientId`)).toBe(
      first
    )
  })

  it('reads an existing id persisted under a custom prefix', () => {
    localStorage.setItem('myapp:clientId', 'existing-install-id')
    expect(getClientId({ storageKeyPrefix: 'myapp:' })).toBe(
      'existing-install-id'
    )
  })

  it('keeps ids under different prefixes independent', () => {
    const defaulted = getClientId()
    const prefixed = getClientId({ storageKeyPrefix: 'myapp:' })
    expect(prefixed).not.toBe(defaulted)
    expect(getClientId({ storageKeyPrefix: 'myapp:' })).toBe(prefixed)
  })
})

describe('createAuthStore clientId resolution', () => {
  it('honors the configured storageKeyPrefix (the migration affordance)', () => {
    localStorage.setItem('myapp:clientId', 'existing-install-id')
    const store = createAuthStore({
      config: { ...baseConfig(), storageKeyPrefix: 'myapp:' },
      registry: {}
    })
    expect(store.getState().clientId).toBe('existing-install-id')
  })

  it('resolves under the default prefix when none is configured', () => {
    const store = createAuthStore({ config: baseConfig(), registry: {} })
    expect(store.getState().clientId).toBe(getClientId())
  })
})
