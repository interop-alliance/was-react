/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The replication indicator: an aggregate over the per-collection statuses the
 * sync controller writes into the sync-status store. With no replication running
 * (offline / local-only) it advertises local-only mode; otherwise it rolls the
 * collection states up to error > syncing > synced (see `useSyncStatus`).
 */
import { Chip, Tooltip } from '@mui/material'
import CloudOffIcon from '@mui/icons-material/CloudOff'
import CloudDoneIcon from '@mui/icons-material/CloudDone'
import CloudSyncIcon from '@mui/icons-material/CloudSync'
import CloudAlertIcon from '@mui/icons-material/ErrorOutlined'
import type { ReactElement } from 'react'
import { useSyncStatus, type SyncRollup } from '../react/hooks.js'

const ICON_BY_STATE: Record<SyncRollup, ReactElement> = {
  offline: <CloudOffIcon />,
  error: <CloudAlertIcon />,
  syncing: <CloudSyncIcon />,
  synced: <CloudDoneIcon />
}

export function SyncStatusChip() {
  const { state, label, title } = useSyncStatus()

  return (
    <Tooltip title={title}>
      <Chip
        icon={ICON_BY_STATE[state]}
        label={label}
        size="small"
        variant="outlined"
        data-testid="sync-status-chip"
        data-sync-state={state}
        sx={{ color: 'inherit', borderColor: 'currentColor' }}
      />
    </Tooltip>
  )
}
