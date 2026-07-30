# Agent Guidelines

## Repository

`@interop/was-react` is the reusable React plumbing for "Bring Your Own
Everything" (BYOE) client-side apps on Wallet Attached Storage (WAS): DID-Auth
login via a CHAPI wallet, a seed-derived did:key identity, local-first encrypted
storage (an RxDB/Dexie replica of per-collection EDV envelopes), and background
sync to a WAS server. It wraps `@interop/was-client` and was extracted from a
production BYOE app. An app supplies a `WasAppConfig` and a `StoreRegistry` and
owns its own domain and UI; the library owns everything from login through sync.

The directory map and the Login With Wallet (App Connect) protocol explainer
live in @ARCHITECTURE.md -- read it before making changes.

### Entry points

Three package entry points, and it matters that they stay separate:

- `.` -- core (config, identity, auth, sync, storage, session, React
  provider/hooks).
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

### .tsx placement

`.tsx` files live ONLY under `src/react/` and `src/mui/`. Every other directory
(config, identity, auth, sync, storage, session, dev) is framework-agnostic
`.ts` with no JSX.

## Toolchain & Project Layout

### Package Manager

Use `pnpm` (not `npm` or `yarn`). The lockfile is `pnpm-lock.yaml`. Install deps
with `pnpm install`; run scripts with `pnpm run <script>` or `pnpm <script>`.

### Build

The library is built with `tsc` (not `vite build`). `vite.config.ts` exists only
to configure Vitest and to run `vite dev` as a server for Playwright. Running
`pnpm run build` compiles `src/` to `dist/` via `tsconfig.json`.

### Two tsconfigs

- `tsconfig.json` — library build only; includes `src/**/*`
- `tsconfig.dev.json` — extends the above with `noEmit: true`; adds `test/**/*`,
  `vite.config.ts`, and `playwright.config.ts` so ESLint's type-aware rules
  cover all files

Do not add test files to `tsconfig.json` — they would be emitted into `dist/`.

### Tests

- `test/node/` — Vitest unit tests (`pnpm run test:node`); run in Node
- `test/browser/` — Playwright tests (`pnpm run test:browser`); run in real
  Chromium via a Vite dev server (`pnpm run dev`)

The `dev` script exists solely to give Playwright a server that can serve and
transform TypeScript source files on the fly. There is no browser app.

### ESM & import paths

The package is ESM-only (`"type": "module"`). Local imports must use the `.js`
extension even though source files are `.ts` — e.g.
`import { Example } from '../../src/index.js'`. TypeScript's
`moduleResolution: Bundler` resolves these to the `.ts` source at compile time.

## Conventions

Code style, refactoring, JSDoc, comment, and error-handling conventions live in
@CONTRIBUTING.md -- follow them. That file's marked conventions block is the
canonical shared core copied across `@interop/*` repos; edit it there, not in
downstream copies.
