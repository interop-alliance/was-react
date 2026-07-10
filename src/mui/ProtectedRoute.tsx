/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The auth + hydration gate (wallet mode). Attempts the zero-popup session
 * restore; an unauthenticated visitor is redirected to the login path, and the
 * routed pages render only once the restored session has hydrated the stores.
 *
 * Apps with a local dev mode wrap their own gate; this component is wallet-mode
 * only. Uses react-router's `Navigate` / `Outlet`.
 */
import { useEffect } from 'react'
import { Navigate, Outlet } from 'react-router'
import { Alert, Box, CircularProgress, Typography } from '@mui/material'
import { useAppReady, useAuthStore, useSession } from '../react/hooks.js'

function CenteredSpinner({ label }: { label: string }) {
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 2,
        minHeight: '60vh'
      }}
      data-testid="bootstrap-loading"
    >
      <CircularProgress />
      <Typography color="text.secondary">{label}</Typography>
    </Box>
  )
}

/**
 * @param props {object}
 * @param [props.loginPath] {string}   where to send an unauthenticated visitor
 *   (defaults to `/login`)
 * @returns {ReactNode}
 */
export function ProtectedRoute({
  loginPath = '/login'
}: {
  loginPath?: string
} = {}) {
  const store = useAuthStore()
  const { status } = useSession()
  const { ready, error } = useAppReady()

  useEffect(() => {
    void store.getState().restore()
  }, [store])

  if (error) {
    return (
      <Box sx={{ p: 4 }}>
        <Alert severity="error" data-testid="bootstrap-error">
          Failed to open local storage: {error}
        </Alert>
      </Box>
    )
  }

  if (status === 'idle' || status === 'restoring') {
    return <CenteredSpinner label="Restoring your session..." />
  }
  if (status !== 'authenticated') {
    return <Navigate to={loginPath} replace />
  }

  if (!ready) {
    return <CenteredSpinner label="Opening your storage..." />
  }

  return <Outlet />
}
