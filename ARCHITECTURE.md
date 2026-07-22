# Architecture

How `@interop/was-react` is laid out and how Login With Wallet works. For
contribution conventions see [CONTRIBUTING.md](CONTRIBUTING.md); for
agent-facing rules (toolchain, tests, repo-specific dos and don'ts) see
[AGENTS.md](AGENTS.md).

## Directory map

- `src/config.ts` -- the central `WasAppConfig` + `StoreRegistry` contract and
  the `{ key, id }` collection registry the storage layer routes on.
- `src/grants.ts` -- parses granted zcaps into server URL / space id / topology.
- `src/identity/` -- seed-derived agents + per-collection KAK derivation, the
  seed credential (issue/parse/verify), seed persistence, session bootstrap, and
  the persisted app-session record.
- `src/auth/` -- the relying-party side of Login With Wallet (App Connect):
  CHAPI wrappers, VPR construction, response verification, and the
  login/reconnect orchestration.
- `src/sync/` -- the collection-agnostic RxDB-to-WAS replication core (nothing
  here imports React): replication, doc cipher, LWW conflict handling, the
  `WasSyncPort`.
- `src/storage/` -- the encrypted `LocalStore`, the process-wide store holder,
  generic entity stores, the delegated remote store, the sync controller, sync
  status, and the rehydrate mechanism.
- `src/session/` -- the wallet-mode auth store factory (`createAuthStore`) and
  the shared app-ready gate.
- `src/react/` -- the `WasSessionProvider` + the hooks (`useSession`,
  `useLogin`, `useLogout`, `useReconnect`, `useSyncStatus`, ...).
- `src/mui/` -- optional MUI + react-router components (`ProtectedRoute`,
  `ReconnectBanner`, `SyncStatusChip`).
- `src/dev/` -- Node-only dev-grant provisioner (`provisionDevGrants`).

## Login With Wallet: the App Connect protocol

Login is a **single CHAPI `get`** (since the App Connect rewrite; the old probe
/ store-key / grants three-popup flow is gone, with no dual-protocol window --
was-react and freewallet releases pair). `buildAppConnectVpr` emits a VPR
carrying `DIDAuthentication` plus one `AppConnectQuery`:

- `app: { name, credentialType, vocabBase }` -- `appName` from `WasAppConfig`
  plus the `SeedCredentialConfig` pair;
- `capabilityQuery` entries -- the usual capability descriptors
  (`urn:was:collection` / `urn:was:public-collection`) _minus_ `controller` (the
  wallet fills it with the app-key subject DID; the app cannot know a returning
  user's DID in advance) and minus `reason`.

The wallet finds -- or on first run **mints, wallet-side** -- the app-key seed
credential for this origin (satisfying `parseSeedCredential` unchanged:
self-issued by the seed-derived did:key, origin-bound, seed base64url-no-pad),
delegates the requested capabilities to its subject DID, and answers with one
signed VP: the credential in `verifiableCredential`, the grants in the top-level
`zcap` array, and a wallet-provided `appConnect: { firstRun: boolean }` member
(absent or non-`true` reads as returning). `loginWithWallet` verifies the
presentation, parses the seed credential, and runs `checkGrants` with the parsed
subject DID as controller (skipped when the app requests no collections). A null
CHAPI response is a user cancel (`LoginCancelledError`); a VP without an app-key
credential is an old, pre-App-Connect wallet and throws `WalletUnsupportedError`
(fail closed, "update Freewallet" copy). The `login()` outcome contract is
`{ firstRun }` / `null` / reject; `LoginPhase` is `'connecting' | 'verifying'`.

The seed never transits a server: minting happens in the wallet, delivery is the
browser-direct CHAPI channel. Dev mode (`provisionDevGrants` /
`connectWithGrants`) still self-issues the seed credential app-side via
`issueSeedCredential`.
