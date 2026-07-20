/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The clear-data confirmation dialog. A dumb presentational component over the
 * store's `clearLocalData` action: it confirms the destructive reset --
 * deleting the local replica and minting a brand-new anonymous identity. The
 * warning text is mode-aware: in `local` mode the device copy is the ONLY copy,
 * so it nudges the user to export first; once connected, the copy already
 * synced to the Web Space survives the reset, so the text says so instead of
 * threatening total loss. Dismissing the dialog (backdrop / escape / Cancel)
 * leaves the data untouched.
 */
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle
} from '@mui/material'
import { useClearData, useSession } from '../react/hooks.js'

/**
 * @param props {object}
 * @param props.open {boolean}   whether the dialog is shown
 * @param props.onClose {() => void}   called after the reset completes and on a
 *   dismiss/cancel (which clears nothing)
 * @returns {ReactNode}
 */
export function ClearDataDialog({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}) {
  const clearData = useClearData()
  const { status } = useSession()
  const connected = status === 'connected' || status === 'reconnect'

  async function handleClear(): Promise<void> {
    await clearData()
    onClose()
  }

  return (
    <Dialog open={open} onClose={onClose} data-testid="clear-data-dialog">
      <DialogTitle>Clear data</DialogTitle>
      <DialogContent>
        <DialogContentText>
          {connected
            ? 'This erases the copy stored on this device and disconnects it ' +
              'from your Web Space. The data already saved to your Web Space ' +
              'stays there -- reconnect with your wallet to bring it back ' +
              'onto this device.'
            : 'This permanently erases everything stored on this device and ' +
              'starts you over fresh. Your data lives only on this device, ' +
              'so once cleared it cannot be recovered -- export a copy first ' +
              'if you want to keep it.'}
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} data-testid="clear-data-cancel">
          Cancel
        </Button>
        <Button
          color="error"
          onClick={() => void handleClear()}
          data-testid="clear-data-confirm"
        >
          Clear data
        </Button>
      </DialogActions>
    </Dialog>
  )
}
