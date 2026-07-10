/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Provider + hook tests (jsdom): the session provider exposes the initial auth
 * state through `useSession`, and `useAuthStore` throws a helpful error when
 * used outside the provider. No IndexedDB / WAS server is touched -- constructing
 * the store and reading its initial state is inert.
 *
 * @vitest-environment jsdom
 */
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { WasSessionProvider } from '../../src/react/WasSessionProvider.js'
import { useAuthStore, useSession } from '../../src/react/hooks.js'
import type { StoreRegistry, WasAppConfig } from '../../src/config.js'

const config: WasAppConfig = {
  appName: 'Test App',
  appOrigin: 'http://localhost:5173',
  collections: [{ key: 'notes', id: 'notes' }],
  credential: {
    credentialType: 'TestAppKey',
    vocabBase: 'urn:test-app:vocab#'
  }
}

const registry: StoreRegistry = {}

function wrapper({ children }: { children: ReactNode }) {
  return (
    <WasSessionProvider config={config} registry={registry}>
      {children}
    </WasSessionProvider>
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('WasSessionProvider + useSession', () => {
  it('exposes the initial (idle) session state', () => {
    const { result } = renderHook(() => useSession(), { wrapper })
    expect(result.current.status).toBe('idle')
    expect(result.current.phase).toBeNull()
    expect(result.current.error).toBeNull()
    expect(result.current.controllerDid).toBeNull()
    expect(result.current.expires).toBeNull()
    expect(result.current.accessExpired).toBe(false)
    expect(result.current.reconnecting).toBe(false)
  })

  it('provides a store with the lifecycle actions', () => {
    const { result } = renderHook(() => useAuthStore(), { wrapper })
    const state = result.current.getState()
    expect(typeof state.restore).toBe('function')
    expect(typeof state.login).toBe('function')
    expect(typeof state.logout).toBe('function')
    expect(typeof state.reconnect).toBe('function')
  })
})

describe('useAuthStore outside a provider', () => {
  it('throws a helpful error', () => {
    // The hook throws during render; swallow React's error log.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    function Bare() {
      useAuthStore()
      return null
    }
    expect(() => render(<Bare />)).toThrow(/WasSessionProvider/)
    errorSpy.mockRestore()
  })
})
