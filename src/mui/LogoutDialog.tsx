/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The logout confirmation dialog (connected mode). A dumb presentational
 * component over the store's `logout` action: it makes the keep-vs-wipe choice
 * explicit -- log out but leave the local replica on this device, or log out and
 * erase it -- since a shared machine and a personal one want opposite defaults.
 * Dismissing the dialog (backdrop / escape / Cancel) cancels logout entirely; no
 * action runs and the session stays connected.
 */
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle
} from '@mui/material'
import { useLogout } from '../react/hooks.js'

/**
 * @param props {object}
 * @param props.open {boolean}   whether the dialog is shown
 * @param props.onClose {() => void}   called after an action completes and on a
 *   dismiss/cancel (which runs no logout)
 * @returns {ReactNode}
 */
export function LogoutDialog({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}) {
  const logout = useLogout()

  async function handleLogout(wipe: boolean): Promise<void> {
    await logout({ wipe })
    onClose()
  }

  return (
    <Dialog open={open} onClose={onClose} data-testid="logout-dialog">
      <DialogTitle>Log out</DialogTitle>
      <DialogContent>
        <DialogContentText>
          Keep your data on this device for next time, or erase it now. Erasing
          removes the local copy from this device only -- data already synced to
          your storage stays there and returns when you log back in.
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} data-testid="logout-cancel">
          Cancel
        </Button>
        <Button
          onClick={() => void handleLogout(false)}
          data-testid="logout-keep"
        >
          Log out, keep data
        </Button>
        <Button
          color="error"
          onClick={() => void handleLogout(true)}
          data-testid="logout-wipe"
        >
          Log out, erase data
        </Button>
      </DialogActions>
    </Dialog>
  )
}
