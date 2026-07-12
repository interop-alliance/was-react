# @interop/was-react Changelog

## 0.1.3 - TBD

### Fixed

- Sync now tracks the server's revisions: accepted conditional writes report
  their response ETag (`WasSyncPort` writes now resolve to the acked revision)
  and write it back into the local row, and the conflict handler adopts a
  revision-only change from the pull echo. Previously every row's `version`
  stayed at 0, so every update paid a guaranteed 412 round trip -- and deletes
  never replicated at all: the local tombstone lost master-wins resolution and
  the entity silently resurrected. A genuine delete-vs-edit race stays
  deterministic (the edit wins; see the conflict-handler doc comment).
- README: entity payloads must carry `updatedAt` and `deviceId` (from
  `getDeviceId()`) on every insert and update -- the last-write-wins pair; the
  Quick start `Note` example now includes `deviceId`.

## 0.1.0-0.1.2 - 2026-07-10

### Added

- Initial extraction of the reusable "Bring Your Own Everything" (BYOE) React
  plumbing from a production BYOE app.
- CHAPI "Login With Wallet" DID-Auth flow: seed probe, grants request, and
  relying-party response verification.
- Self-issued seed credential: mint, store to, and recover from the wallet, with
  origin and seed-to-DID binding checks; a stable did:key identity and
  per-collection vault keys derived deterministically from the master seed.
- Session lifecycle store plus React provider and hooks (`useSession`,
  `useLogin`, `useLogout`, `useReconnect`, `useSyncStatus`, `useAppReady`): hot
  restore, login, near-expiry reconnect, and logout.
- Encrypted local-first RxDB (Dexie/IndexedDB) replica of per-collection EDV
  envelopes, with background WAS replication, last-writer-wins conflict
  resolution, and an aggregate sync-status rollup.
- Optional MUI + react-router components (`ProtectedRoute`, `ReconnectBanner`,
  `SyncStatusChip`) under the `./mui` entry.
- Node-only dev-grants provisioner (`provisionDevGrants`) and the
  `was-provision-dev-grants` CLI under the `./dev` entry.
