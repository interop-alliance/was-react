/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The pre-login adoption choice dialog, shown by an app's login affordance when
 * the anonymous `local` replica holds data (see `useHasLocalData`). "Bring my
 * data" runs `login({ adopt: 'merge' })`: the local data is merged into the
 * connected storage and the anonymous replica is then deleted. "Set it aside"
 * runs `login({ adopt: 'leave' })`: the anonymous replica stays untouched on
 * this device and returns after a logout. Dismissing the dialog (backdrop /
 * escape / Cancel) runs no login at all.
 */
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle
} from '@mui/material'
import { useLogin } from '../react/hooks.js'

/**
 * @param props {object}
 * @param props.open {boolean}   whether the dialog is shown
 * @param props.onClose {() => void}   called before a chosen login starts and
 *   on a dismiss/cancel (which runs no login)
 * @returns {ReactNode}
 */
export function AdoptDialog({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}) {
  const { login } = useLogin()

  function handleLogin(adopt: 'merge' | 'leave'): void {
    onClose()
    void login({ adopt })
  }

  return (
    <Dialog open={open} onClose={onClose} data-testid="adopt-dialog">
      <DialogTitle>Bring your data with you?</DialogTitle>
      <DialogContent>
        <DialogContentText>
          You created data on this device before logging in. Bring it into your
          own storage so it syncs everywhere you log in, or set it aside -- it
          then stays on this device only and comes back if you log out.
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} data-testid="adopt-cancel">
          Cancel
        </Button>
        <Button onClick={() => handleLogin('leave')} data-testid="adopt-leave">
          Set it aside
        </Button>
        <Button onClick={() => handleLogin('merge')} data-testid="adopt-merge">
          Bring my data
        </Button>
      </DialogActions>
    </Dialog>
  )
}
