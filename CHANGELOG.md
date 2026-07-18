# @interop/was-react Changelog

## 0.1.6 - TBD

### Added

- Local-first onboarding: with no wallet session, the store now opens an
  encrypted anonymous-seed replica (persisted in `<dbName>-anon`, same
  per-collection key derivation as a connected replica), so an app is fully
  usable before or without connecting a wallet. New `WasAppConfig.onboarding`
  (`'local-first' | 'login-gated'`, default `'login-gated'`, the historical gate
  behavior) and `WasAppConfig.seedLocal` (one-time dev-fixtures hook for a
  brand-new anonymous replica).
- `clearLocalData` action (+ `useClearData` hook): deletes the local replica and
  mints a fresh anonymous seed/DID and replica. Backed by the new
  `LocalStore.remove()`.
- `connectWithGrants({ seed, grants })`: non-CHAPI connect from an explicit
  seed + grant set (dev/test and provisioned-grants paths), driving the same
  connected-state replication path as wallet login.
- New `./mui` dialogs `LogoutDialog` (log out keeping vs erasing local data) and
  `ClearDataDialog` (confirm-and-wipe for local mode).

### Changed

- Breaking: the session store is now a four-state machine, `SessionStatus`
  (`'boot' | 'local' | 'connected' | 'reconnect'`), replacing `AuthStatus` with
  no back-compat alias. `restore()` is renamed `boot()`; a restore hit lands
  `connected`, a miss or error falls to `local` (never a dead login screen), and
  both finish opening + hydrating the replica before leaving `'boot'`.
- Breaking: `logout()` now takes `{ wipe?: boolean }` (default keeps the local
  replica) and lands in a fresh anonymous `local` state instead of navigating to
  a login screen.
- Breaking hook shapes: `useSession()` adds `onboarding` and `authenticating`;
  `useLogin()` returns `{ login, authenticating, phase, error, status }`;
  `useLogout()` returns `(options?: { wipe?: boolean }) => Promise<void>`.
- `ProtectedRoute` is now a thin switch over `onboarding` + `status`; boot is
  kicked off by `WasSessionProvider` on mount. Its fatal-error alert is scoped
  to boot/storage failures, so a failed or cancelled wallet login no longer
  blanks a local-first app.
- Breaking: `parseGrants` requires every delegated grant to be collection-scoped
  (space-scoped targets are rejected), and `ParsedTarget.collectionId` is now
  required.

### Removed

- Breaking (privacy): the automatic read-only whole-space capability query in
  the wallet login request. Apps now request only collection-scoped
  capabilities; no runtime code ever invoked the space grant. The
  `SPACE_READ_REFERENCE_ID` export is gone with it.
- Breaking: `useAppReady` -- "app ready" is now simply `status !== 'boot'`.

### Migration

- No persisted-session back-compat: sessions that fail to restore (including
  older ones carrying a space-read grant) silently land in `local`, or on the
  login path in a login-gated app.

## 0.1.5 - 2026-07-12

### Fixed

- Push path: a `404` on `DELETE` is now treated as success (the resource is
  already absent -- a row created and deleted locally before its first push, or
  deleted remotely first). Previously the 404 rejected the whole push batch,
  which RxDB retried indefinitely, permanently wedging that collection's push
  queue on a phantom tombstone.
- Entity stores: the remote patch path now applies the last-write-wins guard
  before upserting. Patch events decrypt asynchronously, so two events for the
  same doc could apply out of order (or a stale pull echo could trail a newer
  optimistic local write) and leave stale content in the UI; a stale incoming
  payload is now discarded. Docs without the LWW fields (`updatedAt`/`deviceId`)
  keep the previous last-patch-wins behavior.

### Removed

- `EntityStore.hydrated`: the flag was written but never read by any consumer.
  Reintroduce it if a UI ever needs a per-collection "hydration done" signal.

## 0.1.4 - 2026-07-12

### Added

- `LocalStore.upsertEntity()`: inserts the entity when the collection has no row
  for its uuid yet, otherwise re-encrypts it in place (the hydration index is
  the source of truth, so callers need not track an insert-vs-update flag).
- `LocalStore.hydrateSingleton()`: hydrates a singleton collection (at most one
  logical entity) and reconciles duplicate rows -- two devices that each created
  the singleton before syncing -- down to the last-write-wins winner,
  tombstoning the losers so the space converges on one row.
- `LocalStore.envelopeIdFor()`: exposes the hydration index's
  `uuid -> envelopeId` mapping so the sync patch path can tell a tombstone for
  the live envelope apart from one for a stale duplicate.
- `cancelScheduledRehydrates()`: drops every pending debounced re-hydrate;
  called during session teardown so a timer that outlives logout never reaches a
  torn-down store.

### Fixed

- `LocalStore.updateEntity()` no longer throws when the entity's envelope is
  gone (a remote tombstone was pulled mid-edit); it resurrects the entity as a
  fresh create, matching the mutable-head LWW rule (a live local edit beats a
  remote tombstone).
- `patchFromChange()` ignores a pulled tombstone whose envelope id differs from
  the one the entity currently lives in (a reconciled singleton loser or a
  pre-resurrection row) -- previously such a stale tombstone dropped the live
  doc; a debounced re-hydrate that fires after teardown is now a no-op.

### Changed

- Performance: hydration and index building decrypt rows concurrently instead of
  serially (the unlock hot path).

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
