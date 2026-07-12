# @interop/was-react Changelog

## 0.1.3 - 2026-07-12

### Fixed

- Conflict handling and revision tracking: accepted conditional writes now adopt
  the server's response ETag (previously every update paid a guaranteed 412 and
  deletes never replicated -- tombstones silently resurrected); metadata-only
  edits are compared (`custom`) so concurrent metadata changes no longer
  converge by push order; and the post-412 changes-feed re-read throws a
  retryable error when it exhausts its scan budget instead of fabricating a
  false tombstone on large collections.
- Session lifecycle: `reconnect()` no longer logs the user out on expired grants
  (it reads the seed directly rather than through the expiry-wiping
  `restoreAppSession()`); a failed session activation tears the local store back
  down and surfaces the error through `useAppReady` instead of leaving it
  installed for the next (possibly different) identity; hot restore re-validates
  grant coverage of the configured collections and raises the reconnect prompt
  proactively, while the sync controller skips uncovered collections instead of
  403-looping into a spurious session-expired banner.
- Teardown: `SyncController.stop()` is terminal, and session teardown awaits an
  in-flight sync start, so logging out mid-start no longer leaks an unstoppable
  replication loop; a new `destroy()` action on the auth store, called on
  `WasSessionProvider` unmount, disarms the expiry watch and closes the store
  (persisted session survives), fixing orphaned timers under React StrictMode
  remounts.
- README: entity payloads must carry `updatedAt` and `deviceId` (from
  `getDeviceId()`) on every insert and update -- the last-write-wins pair; the
  Quick start `Note` example now includes `deviceId`.

### Changed

- Performance: the sync pull path coalesces a burst of incoming remote changes
  into one entity-store update per flush (initial sync was O(N^2) Map copies
  plus one re-render per document).
- Reuse and API shape: 401/403 from the sync port now throw a typed
  `WasSyncAuthError` (with shared `errorStatus`/`errorMessage` helpers exported
  from the sync entry); grant-target parsing, response-ETag reading, and
  conditional-write headers now come from `@interop/was-client` (bumped to
  `^0.14.5` -- a reserved sub-endpoint grant like `/space/:id/policy` is no
  longer misread as a collection grant); seed-path base64url/hex codecs come
  from `@scure/base` (new direct dependency); `createWasSyncPort` returns a
  `WasSyncBasePort` without `get()`, which the `withFeedMasterRead` wrapper
  alone provides (the base implementation was unused and broken cross-origin);
  the sync-status precedence rollup moved into the store as `deriveSyncRollup`
  with `useSyncStatus` unchanged in shape.
- Test files colocated under `src/` are no longer compiled into `dist/` (and so
  no longer shipped in the npm package).

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
