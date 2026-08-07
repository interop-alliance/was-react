/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The confirmation-dialog frame the library's three dialogs (adopt, clear data,
 * logout) share: a MUI `Dialog` carrying a `<testId>-dialog` test id, a title, a
 * one-paragraph body, and an actions row that always opens with a Cancel button
 * (`<testId>-cancel`) wired to `onClose`. Each dialog supplies its own confirm
 * buttons after it.
 *
 * Internal to `src/mui/` -- deliberately NOT exported from the `./mui` entry
 * point, so it stays a refactoring detail rather than public API.
 */
import type { ReactNode } from 'react'
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle
} from '@mui/material'

/**
 * @param props {object}
 * @param props.testId {string}   test-id stem: the dialog gets
 *   `<testId>-dialog`, the Cancel button `<testId>-cancel`
 * @param props.title {string}   the dialog title
 * @param props.body {ReactNode}   the body copy, rendered in a
 *   `DialogContentText`
 * @param props.actions {ReactNode}   the confirm buttons, rendered after Cancel
 * @param props.open {boolean}   whether the dialog is shown
 * @param props.onClose {() => void}   dismiss/cancel handler
 * @returns {ReactNode}
 */
export function ConfirmDialog({
  testId,
  title,
  body,
  actions,
  open,
  onClose
}: {
  testId: string
  title: string
  body: ReactNode
  actions: ReactNode
  open: boolean
  onClose: () => void
}) {
  return (
    <Dialog open={open} onClose={onClose} data-testid={`${testId}-dialog`}>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <DialogContentText>{body}</DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} data-testid={`${testId}-cancel`}>
          Cancel
        </Button>
        {actions}
      </DialogActions>
    </Dialog>
  )
}
