/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Browser smoke test: the library imports and evaluates in a real Chromium
 * (via the Vite dev server transforming the TS source on the fly), and its key
 * public exports are present and of the right shape. This catches
 * browser-only breakages (bad import specifiers, top-level DOM/crypto access)
 * that the Node unit tests miss.
 */
import { expect, test } from '@playwright/test'

test('the core entry imports and exposes its public API in the browser', async ({
  page
}) => {
  await page.goto('/test/index.html')

  const exports = await page.evaluate(async entry => {
    // The path is passed as an argument (not a literal) so the TypeScript
    // checker does not try to resolve the Vite-served source URL at build time.
    const mod = await import(entry)
    return {
      createAuthStore: typeof mod.createAuthStore,
      WasSessionProvider: typeof mod.WasSessionProvider,
      useSession: typeof mod.useSession,
      loginWithWallet: typeof mod.loginWithWallet,
      createSyncController: typeof mod.createSyncController,
      startWasSync: typeof mod.startWasSync,
      parseGrants: typeof mod.parseGrants,
      createDocumentLoader: typeof mod.createDocumentLoader,
      DEFAULT_DB_NAME: mod.DEFAULT_DB_NAME
    }
  }, '/src/index.ts')

  expect(exports.createAuthStore).toBe('function')
  expect(exports.WasSessionProvider).toBe('function')
  expect(exports.useSession).toBe('function')
  expect(exports.loginWithWallet).toBe('function')
  expect(exports.createSyncController).toBe('function')
  expect(exports.startWasSync).toBe('function')
  expect(exports.parseGrants).toBe('function')
  expect(exports.createDocumentLoader).toBe('function')
  expect(exports.DEFAULT_DB_NAME).toBe('was-react')
})

test('the mui subpath imports and exposes its components', async ({ page }) => {
  await page.goto('/test/index.html')

  const exports = await page.evaluate(async entry => {
    const mod = await import(entry)
    return {
      ProtectedRoute: typeof mod.ProtectedRoute,
      ReconnectBanner: typeof mod.ReconnectBanner,
      SyncStatusChip: typeof mod.SyncStatusChip,
      LogoutDialog: typeof mod.LogoutDialog,
      ClearDataDialog: typeof mod.ClearDataDialog
    }
  }, '/src/mui/index.ts')

  expect(exports.ProtectedRoute).toBe('function')
  expect(exports.ReconnectBanner).toBe('function')
  expect(exports.SyncStatusChip).toBe('function')
  expect(exports.LogoutDialog).toBe('function')
  expect(exports.ClearDataDialog).toBe('function')
})
