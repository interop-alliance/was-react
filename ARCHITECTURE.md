# Architecture

How `@interop/was-react` is laid out and how Login With Wallet works. For
contribution conventions see [CONTRIBUTING.md](CONTRIBUTING.md); for
agent-facing rules (toolchain, tests, repo-specific dos and don'ts) see
[AGENTS.md](AGENTS.md).

## Directory map

- `src/config.ts` -- the central `WasAppConfig` + `StoreRegistry` contract, the
  `{ key, id }` collection registry the storage layer routes on, and the
  separate read-only `sharedCollections` registry.
- `src/grants.ts` -- parses granted zcaps into server URL / space id / topology.
- `src/identity/` -- seed-derived agents (including the identity key-agreement
  key every encrypted collection is read with), the seed credential
  (issue/parse/verify), seed persistence, session bootstrap, and the persisted
  app-session record.
- `src/auth/` -- the relying-party side of Login With Wallet (App Connect):
  CHAPI wrappers, VPR construction, response verification, and the
  login/reconnect orchestration.
- `src/sync/` -- the collection-agnostic RxDB-to-WAS replication core (nothing
  here imports React): replication, doc cipher, LWW conflict handling, the
  `WasSyncPort`.
- `src/storage/` -- the encrypted `LocalStore`, the process-wide store holder,
  generic entity stores, the delegated remote store, the read-only
  `SharedCollectionReader`, the sync controller, sync status, and the rehydrate
  mechanism.
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
  (`https://w3id.org/byoe#collection` / `#public-collection`) _minus_
  `controller` (the wallet fills it with the app-key subject DID; the app
  cannot know a returning user's DID in advance) and minus `reason`.

The protocol's normative definition is the **App Connect companion spec**
(<https://github.com/interop-alliance/app-connect-spec>; local checkout
`../app-connect-spec` -- read `spec.md` there instead of fetching the
rendered version): the `AppConnectQuery`, the app-key credential and its
binding rules, the descriptor vocabulary with per-class action ceilings, and
the response presentation this library verifies.

The wallet finds -- or on first run **mints, wallet-side** -- the app-key seed
credential for this origin (satisfying `parseSeedCredential`: carrying the
shared `AppKeyCredential` marker type, self-issued by the seed-derived did:key,
origin-bound, seed base64url-no-pad), delegates the requested capabilities to
its subject DID, and answers with one signed VP: the credential in
`verifiableCredential`, the grants in the top-level `zcap` array, and a
wallet-provided `appConnect: { firstRun: boolean }` member (absent or non-`true`
reads as returning). `loginWithWallet` verifies the presentation, parses the
seed credential, and runs `checkGrants` with the parsed subject DID as
controller (skipped when the app requests no collections). A null CHAPI response
is a user cancel (`LoginCancelledError`); a VP without an app-key credential is
an old, pre-App-Connect wallet and throws `WalletUnsupportedError` (fail closed,
"update Freewallet" copy). The `login()` outcome contract is `{ firstRun }` /
`null` / reject; `LoginPhase` is `'connecting' | 'verifying'`.

Every app key carries the marker type `AppKeyCredential`
(`https://w3id.org/byoe#AppKeyCredential` -- one stable IRI for every app,
defined in the inline `@context`, never interpolated from `vocabBase`), and
`parseSeedCredential` requires it. The marker turns "presents as an app key"
into a term check rather than a shape heuristic, which is what lets a wallet
refuse a foreign app key at store time; requiring it here keeps both sides on
one rule. It is a self-declaration, not evidence -- a planted credential
controls its own `type` array -- so the seed-to-DID binding stays the only thing
that authenticates. The claim terms are shared for the same reason: `seed`
and `origin` map to `https://w3id.org/byoe#seed` / `#origin`, and `vocabBase`
namespaces only the app's own type term. `findSeedCredential` deliberately
still matches on the app type alone, so a returned credential missing the
marker surfaces as a parse error rather than a `null` the caller would read
as first run and answer by minting a second key.

The seed never transits a server: minting happens in the wallet, delivery is the
browser-direct CHAPI channel. Dev mode (`provisionDevGrants` /
`connectWithGrants`) still self-issues the seed credential app-side via
`issueSeedCredential`.

## The three kinds of collection

Three kinds, and the distinctions are load-bearing:

- **App-owned private** (`collections`, `visibility: 'private'`, the default).
  The app provisions, writes, and replicates it. Encrypted with the app's
  identity X25519 key-agreement key -- the same key a shared collection's roster
  entry names. Requested with the `https://w3id.org/byoe#collection`
  descriptor.
- **App-owned public** (`collections`, `visibility: 'public'`). Plaintext and
  world-readable; no key derivation, and the stored resource id IS the payload
  uuid, so a public document has a stable share URL. Requested with
  `https://w3id.org/byoe#public-collection`.
- **Shared, wallet-owned** (`sharedCollections`). One of the WALLET's own
  encrypted collections that the user chooses to let this app read and decrypt.
  Requested with `https://w3id.org/byoe#shared-collection` and the read-only
  `SHARED_ACTIONS` set. It is read-only by construction: no RxDB collection,
  no local replica, no replication, no writes, and the sync bootstrap's
  collection-description PUTs skip it. Reads go straight to the server
  through a `SharedCollectionReader`,
  which fetches the stored EDV envelope raw (the `encryption: 'plaintext'`
  handle override) and decrypts it locally.

`SharedCollectionReader.list()` has two paths. The fast one pages the `changes`
feed -- whole pages of documents with their bodies, undecrypted by the server,
which is exactly what a reader holding its own keys wants, and the same
primitive replication pulls with. It costs one request per page rather than one
per resource, and skips tombstones so the result is the live set. The fallback,
for a backend without the `changes-query` feature (501, surfaced as
`NotImplementedError`), lists the resource summaries and fetches each body; it
warns once per reader that the collection is being read the slow way.

`validateSharedCollections` rejects a collection declared in both registries: a
collection cannot be app-owned and shared read-only at once.

### One key identity

A share hands the app an entry in the collection's key-epoch roster, and the key
in that entry is the app's **identity KAK** -- the X25519 (Montgomery) twin of
its `did:key` controller, on `IdentityAgents.keyAgreementKey`. The wallet
derives the same key from the controller DID alone, so the key never travels on
the wire and no request can pair controller DID A with recipient key B.

That is the SAME key the app's own collections are encrypted with. One rule
holds everywhere: an epoch-roster recipient is the X25519 twin of a controller
did:key, whoever owns the collection, and an app derives its key exactly once
per session (`LocalStore.init` takes it, rather than deriving per collection).

Earlier versions ran a second identity for app-owned collections -- a
per-collection KAK, HKDF-derived from the master seed under the collection id
(`deriveCollectionKeys`, label `kak:v1:<collectionId>`). Unifying gives up that
HKDF domain separation: one key now reads every collection the app touches. The
trade is deliberate. A share is also grantable to an arbitrary `did:key` where
no app seed exists at all, so the recipient must be derivable from the
controller DID alone; per-collection keys cannot cover that case, and only the
identity KAK can be the single rule. And the separation bought less than it
appears to: with key epochs the KAK only unwraps an epoch secret rather than
being the content key, and the seed both keys derive from is persisted in the
same process anyway.

### Failing closed, and the honest ceiling

`https://w3id.org/byoe#shared-collection` is a distinct descriptor type
rather than a flag, for the same reason `#public-collection` is: an unknown
type already resolves to unsatisfiable, so a wallet that predates the
feature refuses visibly. Silently degrading matters more here than
elsewhere -- a share fuses
the read zcap with the roster entry, and half a share is ciphertext the app
cannot decrypt, which reads as corrupt data rather than as a wallet needing an
update.

Two limits the reader states plainly, matching the wallet's consent copy:
removing access stops future reads but cannot take back what was already read;
and resources written before the collection's FIRST share are single-recipient
envelopes sealed to the owner alone, never re-encrypted, so they do not decrypt
here. Those are skipped with a distinguishable warning rather than treated as
corruption. Every other failure -- no covering grant, no roster, not a recipient
-- degrades one reader with a warning and never the session.
