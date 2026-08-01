# @interop/was-react Changelog

## 0.7.0 - TBD

### Changed

- **BREAKING**: Renamed the collection-encryption "marker" surface to
  "encryption descriptor", following the WAS spec's wording (the object is the
  `encryption` member of a Collection Description, so "descriptor" names it by
  what it describes). Renamed exports: `LocalStore.applyRemoteMarker` to
  `applyRemoteDescriptor`, `LocalStore.open({ markers })` to `{ descriptors }`,
  `SeedStore.saveMarkers` / `loadMarkers` to `saveDescriptors` /
  `loadDescriptors`, `startWasSync({ onMarkersFetched })` to
  `{ onDescriptorsFetched }`, and `activateSession({ markers })` to
  `{ descriptors }`. `MarkerResult` -- the outcome type shared by
  `markCollectionEncrypted()` and `declareCollectionIndexes()` -- is renamed to
  the neutral `DeclarationResult` rather than an encryption-specific name, since
  the indexes declaration has nothing to do with encryption. The persisted
  offline-cache record key in the session IndexedDB moves from `markers` to
  `descriptors` with no migration: an orphaned cached entry is refetched on the
  next connected sync. The `AppKeyCredential` marker type and the App Connect
  response marker are different senses of the word and are unchanged.
- Bumped `@interop/wallet-core` to `^0.8.0` and `@interop/was-client` to
  `^0.23.0`, the releases carrying the same rename upstream (the wire format is
  unchanged -- the word never crosses the wire).

## 0.6.0 - 2026-08-01

### Added

- did:webvh resolution in the app document loader. `createDocumentLoader` now
  composes `@interop/security-document-loader`'s default did:key + did:web
  resolver set with the `@interop/did-method-webvh` driver, so a wallet may
  present its Login With Wallet VP holder as a did:webvh (proof verification
  method `<did:webvh>#<key>`) and `verifyLoginPresentation` resolves it.
  Resolution is VERIFIED resolution -- the driver's default history-log verifier
  (hash chain + entry proofs) is active, and a tampered or forged `did.jsonl`
  fails closed. did:key / did:web resolution is unchanged, and did:webvh DIDs on
  `localhost` resolve over plain http for local dev, matching did:web.
  Backward-compatible: apps should pick up this release before any wallet
  switches its VP holder to a did:webvh.

### Fixed

- README's "Login flow" section documented the removed three-popup flow (probe /
  store-key / request-grants); rewritten to the shipped single-popup App Connect
  exchange, including the `WalletUnsupportedError` fail-closed path and the
  `{ firstRun }` login result.
- The login-flow test wallet's `appConnect` context term now uses the IRI the
  real wallet emits (`urn:freewallet:vocab#appConnect`), so the fixture drifts
  with the actual wire term instead of coining its own.

## 0.5.0 - 2026-07-30

### Added

- Read-and-decrypt support for SHARED collections: one of the wallet's own
  encrypted collections that the user chooses to let this app read. Declare them
  in the new `WasAppConfig.sharedCollections` registry (`{ key, id }`, validated
  by `validateSharedCollections`); they are read-only by construction -- never
  replicated into RxDB, never written to, no local replica, and excluded from
  the sync bootstrap's collection-description writes. Each covered collection
  gets a `SharedCollectionReader` (`list` / `get`), exposed on the auth store as
  `sharedCollections` and through the new `useSharedCollection(key)` hook.
  `list()` pages the WAS `changes` feed, which returns whole pages of documents
  with their (undecrypted) bodies, so reading a collection costs one request per
  page rather than one per resource; tombstones are skipped so the result is the
  live set. A backend without the `changes-query` feature falls back to a
  listing plus per-resource reads, with a one-time warning.
  `SHARED_CHANGES_PAGE_SIZE` is exported and `SharedCollectionReader.open` takes
  an optional `pageSize`.
- `buildAppConnectVpr` takes `sharedCollections` (WAS collection ids) and
  appends one `urn:was:shared-collection` capability query per id with the new
  read-only `SHARED_ACTIONS` (`GET`/`HEAD`) set -- an app never requests writes
  on a wallet collection. As with `urn:was:public-collection`, a wallet that
  predates the descriptor type reports it unsatisfiable and the request fails
  closed, rather than degrading to a ciphertext-only read that would look like
  corrupt data.
- `IdentityAgents` now carries `keyAgreementKey` + `keyResolver`: the app's
  IDENTITY key-agreement key, the X25519 twin of its `did:key` controller. That
  is the recipient identity a wallet writes into the key-epoch roster of any
  collection this app reads, so the key is derived on both sides and never
  travels on the wire.

### Changed

- **Breaking:** every encrypted collection -- app-provisioned as well as shared
  -- is now read and written with the app's IDENTITY key-agreement key, derived
  once per session. `LocalStore.init` takes `keyAgreementKey` + `keyResolver`
  (`IdentityAgents`) in place of the master `seed`, and no longer derives a key
  per collection; `rebuildCipher` reuses the same key material. One rule now
  covers every key-epoch roster entry: a recipient is the X25519 (Montgomery)
  twin of a controller `did:key`, whether the recipient is an app or a person. A
  share is grantable to an arbitrary `did:key` where no app seed exists, so the
  recipient has to be derivable from the controller DID alone -- which is why
  unification could only go this way. It also gets a client secret out of the
  wallet's grant path: the wallet no longer needs the app seed to provision an
  encrypted app collection.

  What this costs, stated plainly: the HKDF domain separation between
  collections is gone, and one key now reads every collection the app touches.
  With key epochs that key only unwraps an epoch secret rather than being the
  content key, and the seed it derives from is persisted in the same process
  anyway, so the separation bought less than it looks like.

  This is a data-migration event for any app that already stored rows under the
  old per-collection keys: existing envelopes were sealed to a key that is no
  longer derived, so they will not decrypt.

- **Breaking:** `deriveCollectionKeys`, `DEFAULT_KAK_HANDLE`, and
  `CollectionKeys` are no longer re-exported from `@interop/was-react` (nor from
  `identity/agents.js`). The derivation itself is unchanged and still lives in
  `@interop/wallet-core/identity`; it simply has no caller here. Import it from
  there if an app still needs it.
- **Breaking:** `startWasSync` now resolves to
  `{ remoteStore, sharedCollections }` rather than the remote store alone, so
  the bootstrapped shared-collection readers reach the caller.
- **Breaking:** every app-key credential now carries a shared `AppKeyCredential`
  marker type (`urn:was:AppKeyCredential` -- one stable IRI for every app,
  defined in the inline `@context`), and `parseSeedCredential` requires it. The
  marker makes "presents as an app key" a term check rather than a shape
  heuristic, which is what lets a wallet refuse a foreign app key at store time
  instead of storing it and quietly ignoring it. It is a self-declaration, not
  evidence -- a planted credential controls its own `type` array -- so the
  seed-to-DID binding remains the only check that authenticates. Requiring it on
  both sides means a credential can only reach the delegation path by carrying
  it. An app key issued by an earlier version (or a wallet that predates the
  marker) no longer parses; `findSeedCredential` still finds it by the app's own
  type, so this surfaces as a visible parse error rather than a silent re-mint.
  `APP_KEY_CREDENTIAL_TYPE` is exported.
- **Breaking:** an app key's `seed` and `origin` claims now carry shared
  `urn:was:seed` / `urn:was:origin` IRIs instead of ones namespaced under the
  app's `vocabBase`: they mean the same thing in every app, so two apps' keys no
  longer make semantically identical claims under different IRIs. The JSON shape
  is unchanged (`credentialSubject.seed` / `.origin` keep their keys);
  `vocabBase` now namespaces only the app's own type term.

## 0.4.0 - 2026-07-23

### Added

- Multi-recipient (key-epoch) read support for app-provisioned encrypted
  collections. `WasRemoteStore.readCollectionEncryption` reads a collection's
  encryption marker via its delegated capability; on login/reconnect each
  private collection's marker is fetched and cached (persisted alongside the
  session seed) so an offline or hot-restored session can build its epoch-aware
  ciphers without a live read.
- A private collection's document cipher now routes through the marker: a
  multi-recipient envelope decrypts from the app's own deterministic
  per-collection key (the same key registered as its roster entry), while a
  pre-epoch envelope keeps decrypting through the single-key path (no
  migration). Writes on an epoch collection stamp the current epoch. A decrypt
  that meets an unseen epoch (a rotation on another device) re-reads the marker
  once and rebuilds the cipher; a marker whose epoch differs from the one a
  collection opened with rebuilds its cipher so later writes use the current
  epoch.

### Changed

- `WasRemoteStore.markCollectionEncrypted` now reads the collection description
  first and skips the bare-marker PUT when any `encryption` block is already
  present, so it can never overwrite an existing epoch roster (reported as
  `ok` + `skipped`). It becomes a no-op fallback for servers/wallets that did
  not provision a roster.

## 0.3.6 - 2026-07-23

### Changed

- `deriveCollectionKeys` / `CollectionKeys` / `DEFAULT_KAK_HANDLE` now delegate
  to `@interop/wallet-core/identity` (moved there verbatim; re-exported here, so
  existing imports keep working).

## 0.3.5 - 2026-07-22

### Changed

- Improve diagnostics when a wallet presentation fails verification: the thrown
  error now includes each failing check's problem details (not just the check
  names), and the full presentation plus the failing check results are logged to
  the console for debugging.

## 0.3.4 - 2026-07-22

### Fixed

- Connecting (via `login` or `connectWithGrants`) with the merge-adoption
  default could fail for apps with many collections: the adoption collect opened
  a fresh handle on the anonymous replica while the process-wide holder was
  still open, so both replicas' collections were open at once -- and the
  connected replica's open then tripped RxDB's process-wide open-collections cap
  (error COL23; free RxDB allows 13, so any app with more than 6 collections
  could not connect). The connect transition now tears the anonymous holder down
  before collecting the adoptable payloads, so at most one replica's collections
  are open at any moment; a collect failure at that point re-opens the anonymous
  replica and rethrows, leaving `local` intact.

## 0.3.3 - 2026-07-22

### Changed

- Update to latest `@interop/` deps, convert private fields from `_` to `#`
  prefix.

## 0.3.2 - 2026-07-20

### Fixed

- Revoked/expired storage access is now detected against real WAS servers. A WAS
  server masks a failed capability invocation as `404` ("URL not found or
  invalid authorization") rather than `401`/`403`, so an unauthorized caller
  cannot probe which resources exist -- which meant the sync port's 401/403-only
  mapping never recognized a revoked grant, and the session stayed `connected`
  (no reconnect banner) with only a generic sync error showing. The port now
  also maps a `404` on the query (pull) and content/meta write paths to
  `WasSyncAuthError`: on those paths the invoked collection is known to exist,
  so a `404` means the invocation itself was rejected. A `404` on delete still
  counts as the already-absent success.

## 0.3.1 - 2026-07-20

### Fixed

- Revoked/expired storage access was not detected on live replication errors:
  RxDB serializes a pull/push handler's thrown error to plain JSON before
  wrapping it, so the typed `WasSyncAuthError` instance never appears in the
  emitted error graph and `isAuthError` returned false -- the session stayed
  `connected` (no reconnect banner) while the sync status chip showed an error.
  `isAuthError` now also matches the serialized error by `name`.

## 0.3.0 - 2026-07-20

### Changed

- **BREAKING**: Renamed the hook returned by `defineDocumentApp` from
  `useDocument` to `useAppDocument`.
- **BREAKING**: Renamed `deviceId` to `clientId` across the board (an SPA is a
  client, not a device): the LWW tiebreak field stamped into every synced
  payload, the `getDeviceId` helper (now `getClientId`), and the
  `<prefix>deviceId` localStorage key (now `<prefix>clientId`). No migration:
  rows already stored or synced under `deviceId` no longer carry a recognized
  LWW stamp, and each install mints a fresh client id on first load after the
  upgrade.

## 0.2.2 - 2026-07-20

### Removed

- **BREAKING**: Removed the `was-provision-dev-grants` CLI (the package `bin`
  entry and `src/dev/cli.ts`). Use the programmatic `provisionDevGrants` from
  `@interop/was-react/dev` instead.

## 0.2.1 - 2026-07-20

### Changed

- `ClearDataDialog` warning text is now mode-aware: once connected, it explains
  that only the device copy is erased and the data already synced to the Web
  Space survives (reconnect to bring it back), instead of the local-only "cannot
  be recovered" warning, which was inaccurate in that state.
- `clearLocalData` now also clears the persisted connected session (as `logout`
  already did), so clearing data while connected fully disconnects -- the next
  page load lands in `local` mode instead of silently reconnecting and syncing
  the cleared data back down.

## 0.2.0 - 2026-07-20

### Changed

- Login With Wallet is now a single CHAPI popup ("App Connect") instead of the
  former three-popup (probe, store, grants) first-run flow. One `get` carries a
  new `AppConnectQuery` (app name + seed-credential naming + the collection
  grant requests); the wallet matches an existing app key or mints a fresh one
  internally and returns the app-key credential together with the delegated
  zcaps in one signed response VP. `buildSeedProbeVpr` and `buildGrantsVpr` are
  replaced by `buildAppConnectVpr`, and the CHAPI store step is gone
  (`chapiStore` and `wrapCredentialForStore` removed). The `login()` outcome
  contract is unchanged (`{ firstRun }` on success, `null` on cancel, reject on
  error); `firstRun` is now read from the wallet-provided
  `presentation.appConnect.firstRun`.
- The `LoginPhase` values collapse from `probing` / `storing-key` /
  `requesting-grants` / `verifying` to just `connecting` / `verifying`.

### Requirements

- This release requires a wallet that understands `AppConnectQuery` (Freewallet
  with App Connect support). An older wallet cannot satisfy the query and
  returns no app key; that fails closed with a clear `WalletUnsupportedError`
  ("Your wallet does not support App Connect yet; update Freewallet to log in.")
  rather than a generic verification error.

## 0.1.12 - 2026-07-20

### Fixed

- Fixed a race where a fast unmount/remount of the session provider (for
  example, React dev-mode double effects) could leave the app on a closed
  database handle or an empty-looking hydrate. `boot` and `destroy` are now
  serialized inside the session store, so a teardown fired while a boot is still
  opening/hydrating waits for that boot to settle before running, and a boot
  queued after it re-opens cleanly -- the open/hydrate/sync bring-up can no
  longer overlap a teardown.

### Changed

- The sync-status chip no longer labels the no-replication state "Offline"
  (local-only mode is not offline). The rollup states now read `Local only`,
  `Sync error`, `Syncing`, and `Synced`, with tooltips clarifying that
  local-only data stays on the device and the other states are connected to
  storage. The `SyncStatusChip` `data-sync-state` attribute now emits the
  machine state key (`offline`/`error`/`syncing`/`synced`) directly, so it is
  stable regardless of the human-readable copy.
- The app-key credential now carries a top-level `name` and `description` so a
  wallet renders it as, for example, "Text Editor app key" with a sentence
  explaining what the key is for, instead of a generic "Verifiable Credential".
  `issueSeedCredential` gains a required `appName` option supplying the
  human-readable app name.

## 0.1.11 - 2026-07-20

### Changed

- `login()` now rejects on a genuine failure instead of swallowing it. It still
  records the message in `error` (so the UI state reflects the failure), but the
  returned promise rejects rather than resolving. On success it resolves with
  `{ firstRun }` (`firstRun` is true when this login created a brand-new app
  key, so an app can show a "connected for the first time" confirmation); on a
  user cancellation of a wallet popup it resolves with `null` and leaves no
  error. The tier-1 `useDocument().connect()` facade returns the same outcome.

### Removed

- The `wasServerUrl` app-config option (on `WasAppConfig` and
  `defineDocumentApp`) and the corresponding `expectedServerUrl` grant check.
  Grants are no longer required to target a pre-configured server URL: the
  wallet decides where the user's Space lives and the sync layer derives its
  target from the grants. Grants are still verified on their own terms
  (controlled by the expected DID, cover the requested collections, unexpired,
  single origin and single space).

## 0.1.10 - 2026-07-19

### Added

- Server-side equality queries on public collections. `WasCollectionConfig`
  grows an optional `indexes` field declaring the queryable content attributes
  (e.g. `indexes: ['author', 'inReplyTo']`); `validateCollections` rejects
  declarations fail-closed (public collections only -- the encrypted
  blinded-index path is not yet supported -- plus empty/duplicate names and
  diverging declarations for one WAS collection id). The sync bootstrap
  best-effort announces the declaration in the collection description
  (`WasRemoteStore.declareCollectionIndexes`, a sibling of the encryption marker
  PUT).
- `EntityStore.query({ equals, limit?, cursor? })`: runs one equality query
  against the collection on the server and returns `{ docs, hasMore, cursor? }`
  without touching the in-memory Map. Multiple `equals` attributes AND together;
  values are string equality only. On the wire it is the cacheable
  `filter[attr]=value` GET on the collection list endpoint with filter
  attributes emitted in sorted (canonical) order, signed with the granted
  collection capability (`WasRemoteStore.queryCollectionByEquality`; page type
  `EqualityQueryPage`).
- A process-wide holder for the per-session delegated remote store
  (`setRemoteStore` / `requireRemoteStore` / `hasRemoteStore` /
  `clearRemoteStore`), installed by `createAuthStore` once background sync
  bootstraps and cleared on logout/teardown, so entity-store verbs that need the
  server (`query`) can reach it. `LocalStore` exposes `collectionConfig(key)`
  (the registered `WasCollectionConfig` for one collection key).
- `publicUrlFor({ collectionKey, id })` (and the underlying
  `WasRemoteStore.publicUrlFor({ collectionId, id })`): composes the stable,
  world-readable resource URL for a document in a public collection -- the share
  link an unauthenticated reader fetches, for the publish-copy share pattern.
  Stable across edits because a public collection stores the payload under its
  logical uuid; fails closed on non-public / unprovisioned collections and empty
  ids.

### Changed

- **BREAKING**: The login flow now requests `visibility: 'public'` collections
  with the distinct `urn:was:public-collection` descriptor type, so the wallet
  provisions them plaintext with a public-read policy and renders a
  world-readable consent warning. Wallets that predate the descriptor render
  such a request unsatisfiable (fail-closed) instead of silently provisioning a
  private collection. `buildGrantsVpr` and `LoginConfig` now take
  `GrantRequestCollection[]` (`{ id, visibility? }`, exported) instead of bare
  collection-id strings; apps using `createAuthStore` are unaffected.
- `createDocumentLoader` no longer takes a `wasServerUrl` option: the http
  did:web dev shim is gone, since `@interop/security-document-loader` 9.4.4 (via
  `@interop/did-web-resolver` 6.3.0) now resolves did:web DIDs on loopback hosts
  (`localhost` / `127.0.0.1`, any port) over plain http natively. The loader is
  the plain security loader again.

## 0.1.9 - 2026-07-19

### Added

- Public (plaintext) collections: `WasCollectionConfig` grows an optional
  `visibility` field (`'private'` default | `'public'`). A public collection is
  world-readable and therefore plaintext -- `LocalStore` skips per-collection
  key derivation and stores payloads as-is through a pass-through codec
  (`createPlaintextDocCodec`), the stored resource id is the payload's own
  logical `id` (a stable, shareable resource URL across edits), and the
  encryption-marker PUT is skipped for it during sync bootstrap. Reading an EDV
  envelope out of a public collection fails with a descriptive error instead of
  mis-indexing it.
- `validateCollections()`: fail-closed registry validation (unknown `visibility`
  values; the same WAS collection id registered as both private and public), run
  automatically by `LocalStore.init`.
- End-to-end plaintext sync coverage against an in-process `was-teaching-server`
  (push verbatim public payloads + encrypted private envelopes, marker skip,
  pull into a fresh replica).

### Changed

- `startWasSync` now requires the app's collection registry (`collections`), and
  `WasRemoteStore.fromGrants` accepts an optional one, so the sync bootstrap
  knows which collections are public. `MarkerResult` gains a `skipped` flag.

## 0.1.8 - 2026-07-19

### Added

- `defineDocumentApp()` + `useDocument()`: the "one sandbox document" facade.
  `defineDocumentApp<T>({ appName, appOrigin, document: { collectionId, initial }, credential, ... })`
  builds the complete wiring for an app whose entire model is a single key-value
  document (an Excalidraw-style editor, a game save file): a one-collection
  local-first `WasAppConfig`, the singleton-document store registry, and a typed
  `useDocument` hook returning
  `{ doc, update, status, sync, exportFile, importFile, connect, disconnect, connecting, error }`.
  The facade owns the LWW stamping (app data is wrapped beside
  `updatedAt`/`deviceId`, so app fields can never collide with them), hydrates
  through `LocalStore.hydrateSingleton` (duplicate singleton envelopes reconcile
  to the LWW winner), serializes tagged `was-document/v1` export files, and
  wires `connect()` to the wallet login -- the config registers exactly one
  collection, so the consent screen shows a single legible request and the
  adopt-on-login merge carries the local document into it.
- `EntityStore.upsert(doc)`: persisting insert-or-update over
  `LocalStore.upsertEntity`, for callers that do not track an insert-vs-update
  flag of their own (e.g. a singleton document).

## 0.1.7 - 2026-07-19

### Added

- Local-to-connected adoption: `login()` and `connectWithGrants()` now take
  `{ adopt: 'merge' | 'leave' }` (default `'merge'`). On a merge, data created
  in the anonymous `local` replica is copied into the connected replica before
  its first hydrate and sync start (decrypted with the anonymous cipher,
  re-encrypted with the connected one -- the two replicas derive their keys from
  different seeds), so adopted documents reach the server as ordinary creates on
  first push. Merge policy is last-write-wins per logical uuid, using the same
  `remotePayloadWins` rule replication runs; payloads missing
  `updatedAt`/`deviceId` are stamped at adoption time, and ones that carry them
  keep their original values. After a successful merge the anonymous seed and
  database are deleted (a later logout lands in a genuinely fresh `local`);
  `'leave'` -- and any login cancel or failure -- keeps the anonymous replica
  fully intact.
- `hasLocalData()` store action + `useHasLocalData()` hook: whether the
  anonymous `local` replica holds any documents, the check a login affordance
  runs to decide whether to offer the adoption choice.
- `AdoptDialog` in `./mui`: the pre-login three-way choice (bring my data / set
  it aside / cancel), calling `login({ adopt })` itself.
- `LocalStore.countEntities(key)` (live-row count without decrypting) and static
  `LocalStore.removeDatabase({ dbName, storage })` (delete a closed database by
  name).
- `lwwFields()` is now exported from the sync layer (previously an internal
  helper of the entity store).

### Changed

- `LocalStore.insertEntity` / `updateEntity` / `upsertEntity` are now generic
  over the payload type (`T extends { id: string }`), so typed app documents and
  inline literals pass without tripping excess-property checks.
- `connectWithGrants` and login adoption read the anonymous replica through a
  fresh database handle derived from the persisted anonymous seed, so a
  StrictMode double-boot after a page reload (which can leave the process-wide
  holder as a closed duplicate) can no longer abort the connect.

## 0.1.6 - 2026-07-18

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
