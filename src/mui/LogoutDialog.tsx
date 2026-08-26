/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The logout confirmation dialog (connected mode). A dumb presentational
 * component over the store's `logout` action: it makes the keep-vs-wipe choice
 * explicit -- log out but leave the connected replica on this browser, or log
 * out and erase it -- since a shared machine and a personal one want opposite
 * defaults. The copy names WHICH copy erasing removes: the connected replica
 * only. The anonymous local-first replica and the writer id survive a logout of
 * either grade, and removing everything is `ClearDataDialog`'s job. Dismissing
 * the dialog (backdrop / escape / Cancel) cancels logout entirely; no action
 * runs and the session stays connected.
 */
import { Button } from '@mui/material'
import { ConfirmDialog } from './ConfirmDialog.js'
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
    <ConfirmDialog
      testId="logout"
      open={open}
      onClose={onClose}
      title="Log out"
      body={
        'Keep the copy on this browser for next time, or erase it now. ' +
        'Erasing removes only the copy this browser holds of your Web Space ' +
        '-- the data itself stays in your Web Space and comes back when you ' +
        'log in again. To remove everything this app has stored here, use ' +
        'Clear data instead.'
      }
      actions={
        <>
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
            Log out, erase local copy
          </Button>
        </>
      }
    />
  )
}
