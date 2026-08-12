# Agent Guidelines

## Repository

`@interop/was-react` is the reusable React plumbing for "Bring Your Own
Everything" (BYOE) client-side apps on Wallet Attached Storage (WAS): DID-Auth
login via a CHAPI wallet, a seed-derived did:key identity, local-first encrypted
storage (an RxDB/Dexie replica of per-collection EDV envelopes), and background
sync to a WAS server. It wraps `@interop/was-client` and was extracted from a
production BYOE app. An app supplies a `WasAppConfig` and a `StoreRegistry` and
owns its own domain and UI; the library owns everything from login through sync.

The directory map, the session state machine, the Login With Wallet (App
Connect) protocol explainer, and the storage/sync layers live in
@ARCHITECTURE.md -- read it before making changes.

The protocol's normative source is the App Connect companion spec
(<https://github.com/interop-alliance/app-connect-spec>; local checkout
`../app-connect-spec`, read `spec.md` there rather than fetching the rendered
version). Check every protocol claim against it rather than against memory or
against the wallet's implementation. This library is on the `appUrl` profile
(`https://w3id.org/byoe/app-connect/v1`): the request's `app` block is
`{ name, appUrl }`, the app-key credential's `type` is the fixed two-entry
`["VerifiableCredential", "AppKeyCredential"]` over a hosted context, and app
identity is scoped to the triple (user, origin, `appUrl`).

### Terminology

The spec's term for the wire artifact is "app-key credential"; use it in prose.
"Seed credential" survives only in exported identifiers that predate the term
(`issueSeedCredential`, `parseSeedCredential`, `findSeedCredential`,
`ParsedSeedCredential`, and the file `src/identity/seedCredential.ts`) -- keep
those names, do not spread the phrase into new prose or new APIs.

`writerId` (`getWriterId`, `useSession().writerId`, the LWW payload field, and
the `<prefix>writerId` localStorage key) is an unkeyed, clearable, unrecoverable
attribution label whose only jobs are history attribution and breaking
last-write-wins ties. It is never an identity. The keyed client identity of an
(app, user) pair is the app-key credential's subject DID. Do not call either one
a "device": one machine hosts many clients, and neither concept is tied to
hardware.

`actionCeiling` is local shorthand for the spec's normative "Allowed actions"
table row of a target class. When writing prose, prefer the spec's wording
("allowed actions") and mention the helper by name where the code is meant.

### Entry points

Three package entry points, and it matters that they stay separate:

- `.` -- core (config, grants, identity, auth, sync, storage, session, React
  provider/hooks, the `defineDocumentApp` facade).
- `./mui` -- optional MUI + react-router components.
- `./dev` -- Node-only dev-grant provisioner.

`./mui` and `./dev` are NEVER re-exported from the root (`src/index.ts`). The
core entry must not import `@mui/material`, `@mui/icons-material`,
`react-router`, or `node:*`. Keep those imports confined to `src/mui/` and
`src/dev/` respectively.

### Peer-dependency policy

`react`, `zustand`, and `rxdb` are required peers. `@mui/material`,
`@mui/icons-material`, and `react-router` are OPTIONAL peers
(`peerDependenciesMeta`), imported only under `src/mui/`. Do not add a runtime
dependency that an app could reasonably own; prefer a peer.

### Pinned derivation warning (wire/data contract -- never change)

The following are data and wire contracts baked into every user's stored data
and DID. Changing any of them after first use silently derives a different
identity or fails to decrypt existing data -- it is a data-migration event, not
a refactor:

- The 32-byte master seed is fed to `CapabilityAgent.fromSeed` AS-IS (raw bytes,
  never `fromSecret`).
- The internal `keyName` value `'app-key'` (master identity) in
  `src/identity/agents.ts`.
- The Ed25519-to-X25519 (Montgomery) conversion that turns the master identity
  into the app's key-agreement key: it is the recipient identity a wallet
  derives independently from the controller `did:key`, and every encrypted
  collection -- app-owned or shared -- is read with it.

The `handle` / `identityHandle` labels are cosmetic and safe to change; the seed
bytes and the `keyName` are not.

An app's configured `appUrl` is a data contract of the same kind for a shipped
app: it is the claim an existing app-key credential is matched on, so changing
it makes the wallet mint a second identity and orphans the data encrypted under
the first.

### .tsx placement

`.tsx` files live ONLY under `src/react/` and `src/mui/`. Every other directory
(config, grants, identity, auth, sync, storage, session, dev) is
framework-agnostic `.ts` with no JSX.

## Toolchain & Project Layout

### Package Manager

Use `pnpm` (not `npm` or `yarn`). The lockfile is `pnpm-lock.yaml`. Install deps
with `pnpm install`; run scripts with `pnpm run <script>` or `pnpm <script>`.

### Build

The library is built with `tsc` (not `vite build`). `vite.config.ts` exists only
to configure Vitest and to run `vite dev` as a server for Playwright. Running
`pnpm run build` compiles `src/` to `dist/` via `tsconfig.json`.

### Two tsconfigs

- `tsconfig.json` -- library build only; includes `src/**/*` and excludes
  `src/**/*.test.ts` and `src/**/*.test.tsx`, which is what keeps colocated test
  files out of `dist/` while still allowing them to live beside their subjects.
- `tsconfig.dev.json` -- extends the above with `noEmit: true`, `rootDir: "."`,
  and `declaration: false`; adds `test/**/*.ts`, `test/**/*.tsx`,
  `vite.config.ts`, and `playwright.config.ts`, so ESLint's type-aware rules and
  `pnpm run typecheck` cover every file. Its `exclude` drops the build's test
  patterns (keeping only `node_modules` and `dist`), so the colocated tests are
  type-checked here.

### Tests

Two homes, both run by Vitest, and the include pattern in `vite.config.ts` is
`['test/node/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}']`:

- `test/node/` -- integration-shaped Vitest suites (the auth store lifecycle,
  the shared-collection reader, `documentApp`, `ProtectedRoute`, sync
  controller, `writerId`).
- `src/**/*.test.ts` (and `.tsx`) -- unit suites colocated with their subject
  (`src/auth/`, `src/identity/`, `src/storage/`, `src/sync/`, `src/config.ts`,
  `src/grants.ts`). Adding one here is normal and safe; the build's exclude
  keeps it out of `dist/`.
- `test/browser/` -- Playwright tests (`pnpm run test:browser`); run in real
  Chromium via a Vite dev server (`pnpm run dev`).

`pnpm run test:node` runs Vitest over both Vitest homes. The default environment
is `node` (crypto and IndexedDB tests); React hook and component tests opt into
jsdom per file with `// @vitest-environment jsdom`. `pnpm test` runs fix, lint,
typecheck, and both suites.

The `dev` script exists solely to give Playwright a server that can serve and
transform TypeScript source files on the fly. There is no browser app.

### ESM & import paths

The package is ESM-only (`"type": "module"`). Local imports must use the `.js`
extension even though source files are `.ts` -- e.g.
`import { Example } from '../../src/index.js'`. TypeScript's
`moduleResolution: Bundler` resolves these to the `.ts` source at compile time.

## Conventions

Code style, refactoring, JSDoc, comment, and error-handling conventions live in
@CONTRIBUTING.md -- follow them. That file's marked conventions block is the
canonical shared core copied across `@interop/*` repos; edit it there, not in
downstream copies.
