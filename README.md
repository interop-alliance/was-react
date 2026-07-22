# @interop/was-react _(@interop/was-react)_

[![NPM Version](https://img.shields.io/npm/v/@interop/was-react.svg)](https://npm.im/@interop/was-react)

> React library for building "Bring Your Own Everything" (BYOE) apps on Wallet
> Attached Storage: DID-Auth login via a CHAPI wallet, local-first encrypted
> storage, and background sync to a WAS server.

## Table of Contents

- [Background](#background)
- [Install](#install)
- [Quick start](#quick-start)
- [Login flow](#login-flow)
- [Session lifecycle](#session-lifecycle)
- [Sync architecture](#sync-architecture)
- [Entry points](#entry-points)
- [Dev tooling](#dev-tooling)
- [Testing](#testing)
- [Contribute](#contribute)
- [License](#license)

## Background

"Bring Your Own Everything" (BYOE) is a way to build web apps with no backend
that the app owns. The user brings their own identity (a wallet) and their own
storage (Wallet Attached Storage, WAS), and the app stores everything encrypted
in that user-owned space. The app is a Relying Party (RP): it authenticates via
"Login With Wallet" (CHAPI) and reads and writes the user's WAS space using
wallet-delegated authorization capabilities (zcaps). It never owns the space,
never holds the wallet's root key, and invokes only the zcaps the wallet grants
it.

"Bring Your Own Storage" (BYOS) is the storage half of that model. Every
application collection is encrypted client-side as an Encrypted Data Vault
(EDV): the WAS server only ever sees opaque JWE envelopes and can neither read
nor search the plaintext. Data is local-first -- a local RxDB (IndexedDB)
database holds the encrypted envelopes and replicates them to WAS in the
background. The app works fully offline; sync resumes on reconnect.

`@interop/was-react` is the reusable plumbing for that model, extracted from a
production BYOE app. It wraps
[`@interop/was-client`](https://npm.im/@interop/was-client) and owns identity
derivation, the CHAPI login flow, the session lifecycle store, the encrypted
local replica, WAS replication, and a small set of React hooks and optional MUI
components. An app supplies its configuration, its collection registry, and its
own domain and UI; the library owns everything in between.

## Install

Node.js 24+ is recommended. The package is ESM-only.

```
pnpm add @interop/was-react
```

Peer dependencies (install the ones you use):

```
pnpm add react zustand rxdb
```

`react >= 19`, `zustand ^5`, and `rxdb ^17` are required peers. The optional
`@interop/was-react/mui` entry additionally needs `@mui/material`,
`@mui/icons-material`, and `react-router`; the core entry never imports them.

```
pnpm add @mui/material @mui/icons-material @emotion/react @emotion/styled react-router
```

## Quick start

An app builds one `WasAppConfig`, a `StoreRegistry` (per-collection hydrate and
patch handlers), wraps its tree in `<WasSessionProvider>`, and drives the
session through the hooks. The example below wires a single `notes` collection.

### 1. Configuration

```ts
// app.config.ts
import type { WasAppConfig } from '@interop/was-react'

export const config: WasAppConfig = {
  appName: 'Notes',
  appOrigin: 'https://notes.example',
  collections: [{ key: 'notes', id: 'notes' }],
  credential: {
    credentialType: 'NotesAppKey',
    vocabBase: 'urn:notes-app:vocab#'
  }
}
```

`collections` maps each app-side `key` (the local RxDB collection handle) to a
WAS collection `id` (a deliberately unprefixed, generic name shared across
interoperable apps). `credential` names the self-issued seed credential the
first-run flow mints. All other fields (`mediatorBase`, `dbName`,
`storageKeyPrefix`, `sync`, `expiry`) are optional with documented defaults.

A collection may also declare `visibility: 'public'`
(`{ key: 'posts', id: 'microblog-posts', visibility: 'public' }`); the default
is `'private'`. A public collection is world-readable and therefore PLAINTEXT:
no per-collection key is derived, payloads are stored as-is locally and
remotely, and the stored resource id is the payload's own logical `id`, so a
public document keeps a stable, shareable resource URL across edits. Be aware
that everything in a public payload is world-readable -- including the LWW
bookkeeping fields `updatedAt` and `clientId` (`clientId` is a random
per-install identifier, but still a linkability handle across a user's public
documents). Changing a collection's visibility after first use is a
data-migration event, not a config tweak: rows written in the other mode stop
being readable. A registry that maps one WAS collection id to both visibilities
is rejected at store open. Two payload constraints on public collections: a
top-level object-valued `jwe` field is reserved (the read path uses it to
recognize a stray encrypted envelope and refuses the row), and payloads should
carry the `updatedAt` / `clientId` LWW fields like any other collection --
without them a concurrent multi-device edit falls back to server-wins.

At login, a public collection is requested from the wallet with the distinct
`urn:was:public-collection` descriptor type (private collections use
`urn:was:collection`): the wallet provisions it plaintext with a public-read
policy, shows a world-readable consent warning, and delegates the usual
read/write capability (public covers only unauthenticated reads; writes stay
capability-only). A wallet that predates the descriptor reports the request
unsatisfiable rather than silently provisioning a private collection, so the
feature fails closed with older wallets. Publicness is granted at consent time
by the wallet -- the app itself can never escalate an existing private
collection to public.

### 2. Entity stores and the registry

```ts
// stores.ts
import { createEntityStore, type StoreRegistry } from '@interop/was-react'

export interface Note {
  id: string
  title: string
  body: string
  createdAt: string
  updatedAt: string
  clientId: string
}

export const useNotes = createEntityStore<Note>('notes')

export const registry: StoreRegistry = {
  notes: {
    hydrate: () => useNotes.getState().hydrate(),
    upsert: doc => useNotes.getState().patch(doc as Note),
    drop: uuid => useNotes.getState().drop(uuid),
    clear: () => useNotes.getState().replaceAll([])
  }
}
```

`createEntityStore` returns a zustand hook holding the decrypted payloads as a
`Map<uuid, Note>`; its `insert` / `update` / `remove` verbs persist through the
encrypted local store, while `hydrate` / `patch` / `drop` / `replaceAll` are the
handlers the rehydrate mechanism drives on login, remote sync, and logout.

### 3. Provider

```tsx
// main.tsx
import { WasSessionProvider } from '@interop/was-react'
import { config } from './app.config.js'
import { registry } from './stores.js'

export function Root() {
  return (
    <WasSessionProvider config={config} registry={registry}>
      <App />
    </WasSessionProvider>
  )
}
```

### 4. Login page

```tsx
// LoginPage.tsx
import { useLogin } from '@interop/was-react'

export function LoginPage() {
  const { login, status, phase, error } = useLogin()
  const busy = status === 'authenticating'

  return (
    <div>
      <button onClick={() => void login()} disabled={busy}>
        {busy ? 'Connecting your wallet...' : 'Login with wallet'}
      </button>
      {busy && phase && <p>{phase}</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  )
}
```

### 5. Reading and writing

```tsx
import { uuidv7 } from 'uuidv7'
import { getClientId } from '@interop/was-react'
import { useNotes } from './stores.js'

export function Notes() {
  const notes = useNotes(state => [...state.byId.values()])
  const insert = useNotes(state => state.insert)

  async function addNote() {
    const now = new Date().toISOString()
    await insert({
      id: uuidv7(),
      title: 'Untitled',
      body: '',
      createdAt: now,
      updatedAt: now,
      clientId: getClientId()
    })
  }

  return (
    <div>
      <button onClick={() => void addNote()}>Add note</button>
      <ul>
        {notes.map(note => (
          <li key={note.id}>{note.title}</li>
        ))}
      </ul>
    </div>
  )
}
```

Entity payloads MUST carry `updatedAt` and `clientId` (from `getClientId()`),
stamped on EVERY insert and update: they are the last-write-wins pair that
settles concurrent multi-device edits of the same entity. A payload without them
loses every sync conflict.

A public collection can additionally answer server-side equality queries.
Declare the queryable content attributes in the collection config:

```ts
{ key: 'posts', id: 'microblog-posts', visibility: 'public',
  indexes: ['author', 'inReplyTo'] }
```

The sync bootstrap announces the declaration in the collection description (the
server rejects filters on undeclared attributes fail-closed), and the entity
store's `query` verb runs the query:

```ts
const page = await usePosts.getState().query({
  equals: { author: 'did:key:z6Mk...' }
})
// page.docs: the matching payloads
// page.hasMore / page.cursor: pass cursor back in to fetch the next page
```

`query` is a read verb against the server (signed with the granted collection
capability, so it needs a wallet-connected session), not a sync path: it never
touches the in-memory Map. Multiple `equals` attributes AND together; values are
string equality only. On the wire it is the collection list endpoint's cacheable
`filter[attr]=value` GET form, with filter attributes emitted in sorted order so
identical queries produce identical URLs; on a public collection the same URL
also answers anonymously for non-app consumers. Declaring `indexes` on a private
collection is rejected at config validation -- the encrypted (blinded-index)
query path is not yet supported.

### Share links (publish-copy)

A public collection also gives every document a stable, world-readable resource
URL, which is the basis for share links. The pattern is publish-copy: declare
one public collection for shared documents,

```ts
{ key: 'sharedNotes', id: 'shared-notes', visibility: 'public' }
```

to share a document, copy it into that store, and the share URL is that copy's
resource URL:

```ts
import { publicUrlFor } from '@interop/was-react'
import { useSharedNotes } from './stores.js'

// Share: copy the doc into the public collection.
await useSharedNotes.getState().insert(doc)
const url = publicUrlFor({ collectionKey: 'sharedNotes', id: doc.id })

// Unshare: remove the copy; replication pushes the delete and the URL stops
// resolving.
await useSharedNotes.getState().remove(doc.id)
```

The URL is stable across edits because a public collection stores the payload
under its own logical uuid. Whether a share is a copy (which survives later
unsharing edits of the original) or a move is an app product decision;
content-addressed ids (hashing immutable content so identical content shares one
URL) are likewise an app-level choice.

Anyone on the web can read the URL -- there is no auth. A consumer can fetch it
with `WasClient.publicRead` from `@interop/was-client` or a plain GET. The URL
resolves only after the document has synced to the server (a locally-inserted
doc shares after the next sync push). Expiring or time-boxed share links are not
supported: sharing IS public-collection membership, so a share lasts until the
copy is removed.

The MUI entry supplies a router gate and status UI on top of this; see
[Entry points](#entry-points).

## Login flow

Login is driven by CHAPI Verifiable Presentation Requests (VPRs). The
`useLogin().login()` action (backed by `loginWithWallet`) runs the flow, with a
`phase` string surfaced for a progress line (`probing` to `storing-key` to
`requesting-grants` to `verifying`):

1. **CHAPI polyfill loads lazily.** The `credential-handler-polyfill` is loaded
   on demand the first time a wallet request is made, not at import time.
2. **Probe (popup #1).** A VPR asking for DIDAuthentication plus the app's seed
   credential is sent to the wallet. No credential returned means this is a
   first run.
3. **First run: mint and store the seed.** A fresh 32-byte master seed is
   generated (`crypto.getRandomValues`), a seed credential is self-issued
   (`issueSeedCredential`, using the configured `credentialType` and `vocabBase`
   plus the app `origin` anti-phishing bind), and stored in the wallet via
   `chapiStore`. The flow blocks until the wallet confirms the store -- a
   dismissed store would silently break cross-device recovery.
4. **Returning login: recover and verify.** When the probe returns the seed
   credential, `parseSeedCredential` recovers the seed and cryptographically
   verifies the credential is self-issued, origin-bound, and seed-to-DID bound.
5. **Derive identity.** The stable `did:key` controller and its signer are
   derived deterministically from the seed via `CapabilityAgent.fromSeed`
   (`initAppSession` / `deriveIdentity`). The same seed yields the same identity
   on every device.
6. **Request grants (popup #2).** `buildGrantsVpr` requests a per-collection
   read/write zcap (plus a read-only space grant) for the controller DID. The
   wallet provisions the collections and returns a signed presentation.
7. **Verify the response.** `verifyLoginPresentation` checks the VP and embedded
   proofs (purpose `authentication`, matching domain and challenge), and
   `checkGrants` asserts every zcap is controlled by the app DID, shares one
   space on a single WAS host, and is unexpired. The wallet decides where the
   user's Space lives; the sync layer derives its target from the grants.
8. **Activate.** The session (seed, grants, earliest expiry) is persisted to
   IndexedDB, the encrypted local store is opened, the entity stores hydrate,
   and background WAS sync starts.

## Session lifecycle

The session is owned by a zustand auth store built once per app by the provider
(`createAuthStore`). Its `status` is `idle` to `restoring` to `unauthenticated`
/ `authenticating` / `authenticated`, and it is the router gate: a protected
route waits for the restore attempt to settle before choosing between the app
and the login page.

- **Restore (zero popups).** On mount, `restore()` reads the persisted session
  from IndexedDB and, if present and consistent, re-derives the identity, opens
  the local store, hydrates, and starts sync with no wallet interaction. A
  missing, corrupt, or wrong-server record falls through to `unauthenticated`.
- **Login.** `useLogin().login()` runs the full [login flow](#login-flow).
- **Reconnect.** Grants are expiry-only. The store watches the earliest grant
  expiry and, once within the warning window (`expiry.warningMs`, default 1h) or
  after a live 401/403, sets `accessExpired`. `useReconnect().reconnect()`
  re-requests grants with the existing seed (one wallet popup, same identity,
  same data) and restarts sync.
- **Logout.** `useLogout()` stops sync, closes and forgets the local store,
  clears the entity stores, and clears the persisted session.
- **Expiry.** Because the seed survives grant expiry and the derived DID and
  vault keys are stable, an expired session re-grants in place; previously
  stored data stays readable.

Hooks:

| Hook              | Returns                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------- |
| `useSession()`    | `status`, `phase`, `error`, `controllerDid`, `expires`, `accessExpired`, `reconnecting` |
| `useLogin()`      | `{ login, status, phase, error }`                                                       |
| `useLogout()`     | `() => Promise<void>`                                                                   |
| `useReconnect()`  | `{ accessExpired, reconnecting, reconnect }`                                            |
| `useSyncStatus()` | `{ state, label, title }` (see below)                                                   |
| `useAppReady()`   | `{ ready, error }` -- the hydration gate                                                |
| `useAuthStore()`  | the bound vanilla store (for `getState().restore()`, etc.)                              |

## Sync architecture

- **Local-first replica.** An always-on local encrypted RxDB (Dexie/IndexedDB)
  database (`LocalStore`) holds one collection per app collection. Every at-rest
  row is `{ id, updatedAt, version, data }`, where `data` is an EDV envelope
  `{ id, sequence, jwe }`. The app reads exclusively from the in-memory entity
  stores hydrated from this replica, so it works fully offline.
- **Envelope encryption.** Each private collection is encrypted with its own
  X25519 key-agreement key, HKDF-derived from the master seed with the label
  `kak:v1:<collectionId>` (`deriveCollectionKeys`). HKDF one-wayness means a
  shared per-collection key exposes nothing about the master seed or the sibling
  collections. The WAS server never sees plaintext. A collection declared
  `visibility: 'public'` opts out entirely: payloads are stored plaintext (no
  key derivation, no envelope) behind the same storage seam.
- **Replication.** A per-session `SyncController` runs RxDB replication per
  collection over a `WasSyncPort` (signed requests authorized by the granted
  zcaps). Pull is driven by the WAS `changes` feed; a low-frequency periodic
  re-sync (`sync.pollMs`, default 15s) keeps open sessions converging.
- **Conflict resolution.** Last-writer-wins on the payload's own
  `(updatedAt, clientId)` (ISO lexical compare, with a per-install random
  `clientId` tiebreaker). Updates re-encrypt in place under the same envelope id
  with `sequence`+1 (a mutable-head model); deletes are soft-delete tombstones.
- **Status.** `useSyncStatus()` rolls the per-collection replication states up
  to an aggregate: `offline` (no replication running / local-only), or
  `error > syncing > synced`. The `SyncStatusChip` MUI component renders it.

## Entry points

The package exposes three entry points. `./mui` and `./dev` are never
re-exported from the root, so an app that does not use them pays no dependency
cost.

| Import                   | Contents                                                                             | Extra peers                                            |
| ------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| `@interop/was-react`     | Core: config, identity, auth, sync, storage, session store, React provider and hooks | `react`, `zustand`, `rxdb`                             |
| `@interop/was-react/mui` | Optional `ProtectedRoute`, `ReconnectBanner`, `SyncStatusChip`                       | `@mui/material`, `@mui/icons-material`, `react-router` |
| `@interop/was-react/dev` | Node-only `provisionDevGrants`                                                       | (none; Node only)                                      |

MUI usage:

```tsx
import { Routes, Route } from 'react-router'
import {
  ProtectedRoute,
  ReconnectBanner,
  SyncStatusChip
} from '@interop/was-react/mui'
import { LoginPage } from './LoginPage.js'

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<ProtectedRoute loginPath="/login" />}>
        <Route
          path="/"
          element={
            <>
              <SyncStatusChip />
              <ReconnectBanner />
              <Notes />
            </>
          }
        />
      </Route>
    </Routes>
  )
}
```

`ProtectedRoute` calls `restore()` on mount, shows a spinner while the session
restores and the stores hydrate, redirects an unauthenticated visitor to
`loginPath`, and renders the routed `<Outlet />` once ready.

## Dev tooling

The `./dev` entry provisions a Space, collections, and delegated read/write
grants against a running was-teaching-server, so an app can dev-sync without a
CHAPI wallet in the loop. It is Node-only (uses `node:fs`).

```ts
import { provisionDevGrants } from '@interop/was-react/dev'

const result = await provisionDevGrants({
  serverUrl: 'http://localhost:3002',
  seed: mySeedBytes,
  collections: ['notes'],
  outFile: './public/dev-grants.local.json'
})
// result.grants, result.spaceId, result.spaceUrl, result.appDid
```

A throwaway "provisioner" identity owns the created Space (a genuine
cross-identity delegation, as in the real wallet-to-relying-party flow), and a
per-collection RW zcap is delegated to the app DID derived from `seed`. Pass
`--probe` (or `probe: true`) to check whether the delegated zcap authorizes
PUTting the EDV encryption marker.

## Testing

The repo runs three test tiers:

```
pnpm run test:node       # Vitest unit tests (test/node/), Node
pnpm run test:browser    # Playwright tests (test/browser/), real Chromium
pnpm test                # fix + lint + typecheck + node + browser
```

`pnpm run test:coverage` runs the Vitest suite with V8 coverage. The Playwright
tier runs against a Vite dev server that serves and transforms the TypeScript
source on the fly; there is no standalone browser app.

## Contribute

PRs accepted. If editing the Readme, please conform to the
[standard-readme](https://github.com/RichardLitt/standard-readme) specification.

See:

- [ARCHITECTURE.md](ARCHITECTURE.md) -- the directory map and the Login With
  Wallet (App Connect) protocol.
- [CONTRIBUTING.md](CONTRIBUTING.md) -- editor setup and code style conventions.

## License

[MIT License](LICENSE.md) © 2026 Interop Alliance. </content> </invoke>
