/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Conditional-write (`If-Match` / `If-None-Match`) coverage for the push side of
 * the sync adapter, driven against a REAL in-process was-teaching-server and a
 * REAL encrypted collection: a dev Space is provisioned with a private
 * (EDV-encrypted) collection, every pushed body is a genuine EDV envelope sealed
 * under the collection's key epoch, and the sync port is the one the sync
 * controller builds (`createWasSyncPort` wrapped in `withFeedPrimaryRead`).
 *
 * The assumption under test, in one line: a write precondition APPLIES on an
 * encrypted collection, so a lost race answers `412` and `pushWrites` turns it
 * into an RxDB conflict entry carrying the current primary state. The fake-port
 * unit suite lives in `@interop/was-sync`; these tests
 * assert that a real encrypted collection actually produces the `412` the
 * mapping is written for.
 *
 * A note on where `@interop/was-client` 0.42.0 fits, since its release notes
 * name this behavior: what 0.42.0 fixed is the CODEC-driven handle API
 * (`Resource.put({ ifMatch })`), which used to drop the caller's precondition
 * on an encrypted collection. Replication never travels that path -- the sync
 * port writes verbatim through `was.request()` with the precondition headers
 * set directly, and the server evaluates them without regard to encryption.
 * These tests are what establishes that, rather than leaving the two paths
 * conflated.
 *
 * @vitest-environment node
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, FileSystemBackend } from 'was-teaching-server'
import type { WithDeleted } from 'rxdb/plugins/core'
import { provisionDevGrants } from '../../src/dev/provisionDevGrants.js'
import { parseGrants } from '../../src/grants.js'
import { deriveIdentity } from '../../src/identity/agents.js'
import { WasRemoteStore } from '../../src/storage/wasRemoteStore.js'
import {
  makeLwwConflictHandler,
  type Json,
  type SyncedDoc,
  type WasSyncPort
} from '@interop/was-sync'
import {
  createPushHandler,
  withFeedPrimaryRead,
  type PushWriteAck
} from '@interop/was-sync/rxdb'
import { formatEtag } from '@interop/was-client/sync'
import { hasKeyEpochs } from '@interop/was-client/edv'
import { createDocCipher, type DocCipher } from '../../src/storage/docCipher.js'
import { createWasSyncPort } from '../../src/storage/wasSyncPort.js'
import type { WasCollectionConfig } from '../../src/config.js'

const PRIVATE_ID = 'conflict-notes'
const REGISTRY: WasCollectionConfig[] = [{ key: 'notes', id: PRIVATE_ID }]

// A fixed 32-byte app (relying party) master seed, distinct from the other
// integration suites' so the two never share a provisioned Space.
const SEED = new Uint8Array(32).map((_, index) => (index * 17 + 3) & 0xff)

const WRITER_ID = 'writer-conditional'

/**
 * A push row as RxDB hands one to the push handler: the new local state, plus
 * the master state the replica believes it is editing (absent on a create).
 */
interface PushRow {
  newDocumentState: WithDeleted<SyncedDoc>
  assumedMasterState?: WithDeleted<SyncedDoc>
}

/**
 * A sealed payload as the document cipher returns it: the random envelope id,
 * the EDV envelope that travels as the stored body, and the key epoch it was
 * sealed under.
 */
interface Sealed {
  id: string
  envelope: Json
  epoch?: string
}

/**
 * An OS-assigned free TCP port (bound and released before the server starts).
 */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => {
        if (address !== null && typeof address === 'object') {
          resolve(address.port)
        } else {
          reject(new Error('No port assigned.'))
        }
      })
    })
  })
}

let dataDir: string
let app: Awaited<ReturnType<typeof createApp>>
let remoteStore: WasRemoteStore
let cipher: DocCipher
let port: WasSyncPort

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'was-react-conditional-'))
  const listenPort = await freePort()
  const serverUrl = `http://localhost:${listenPort}`
  app = createApp({
    serverUrl,
    backend: new FileSystemBackend({ dataDir, capacityBytes: Infinity })
  })
  await app.listen({ port: listenPort, host: '0.0.0.0' })

  const provisioned = await provisionDevGrants({
    serverUrl,
    seed: SEED,
    collections: [{ id: PRIVATE_ID, visibility: 'private' }]
  })
  const parsed = parseGrants(provisioned.grants)
  const { zcapClient, keyAgreementKey, keyResolver } = await deriveIdentity({
    seed: SEED
  })
  remoteStore = WasRemoteStore.fromGrants({
    parsed,
    zcapClient,
    collections: REGISTRY,
    keys: { keyAgreementKey, keyResolver }
  })

  // The collection is genuinely encrypted: it carries a key-epoch roster from
  // provisioning, and the cipher below seals every body under it.
  const encryption = await remoteStore.readCollectionEncryption(PRIVATE_ID)
  expect(encryption).toBeDefined()
  expect(hasKeyEpochs(encryption)).toBe(true)
  cipher = await createDocCipher({
    keyAgreementKey,
    keyResolver,
    collectionId: PRIVATE_ID,
    encryption: encryption!
  })

  // The exact port the sync controller builds for a granted collection.
  port = withFeedPrimaryRead(
    createWasSyncPort({
      was: remoteStore.was,
      spaceId: remoteStore.spaceId,
      collectionId: PRIVATE_ID,
      capability: remoteStore.collectionCapability(PRIVATE_ID)!
    })
  )
}, 60000)

afterAll(async () => {
  await app?.close()
  await rm(dataDir, { recursive: true, force: true })
}, 60000)

/**
 * An LWW-stamped app payload (the plaintext that goes inside an envelope).
 *
 * @param options {object}
 * @param options.title {string}
 * @param options.updatedAt {string}
 * @returns {Json}
 */
function payload({
  title,
  updatedAt
}: {
  title: string
  updatedAt: string
}): Json {
  return { id: crypto.randomUUID(), title, updatedAt, writerId: WRITER_ID }
}

/**
 * Runs one push batch through a fresh push handler, collecting the acked
 * revisions the handler reports out-of-band.
 *
 * @param rows {PushRow[]}
 * @returns {Promise<{ conflicts: WithDeleted<SyncedDoc>[], acks: PushWriteAck[] }>}
 */
async function runPush(rows: PushRow[]): Promise<{
  conflicts: WithDeleted<SyncedDoc>[]
  acks: PushWriteAck[]
}> {
  const acks: PushWriteAck[] = []
  const push = createPushHandler(port, async ack => {
    acks.push(ack)
  })
  const conflicts = await push(rows)
  return { conflicts, acks }
}

/**
 * The local row shape a sealed envelope travels in.
 *
 * @param options {object}
 * @param options.sealed {Sealed}
 * @param options.updatedAt {string}
 * @param options.version {number}
 * @param [options.custom] {Json}
 * @returns {WithDeleted<SyncedDoc>}
 */
function row({
  sealed,
  updatedAt,
  version,
  custom
}: {
  sealed: Sealed
  updatedAt: string
  version: number
  custom?: Json
}): WithDeleted<SyncedDoc> {
  return {
    id: sealed.id,
    updatedAt,
    version,
    _deleted: false,
    data: sealed.envelope,
    ...(sealed.epoch !== undefined && { epoch: sealed.epoch }),
    ...(custom !== undefined && { custom })
  }
}

/**
 * Creates one resource through the push handler (the `If-None-Match: *` create
 * path) and returns the sealed body plus the acked content version.
 *
 * @param options {object}
 * @param options.title {string}
 * @param options.updatedAt {string}
 * @returns {Promise<{ sealed: Sealed, version: number }>}
 */
async function createRow({
  title,
  updatedAt
}: {
  title: string
  updatedAt: string
}): Promise<{ sealed: Sealed; version: number }> {
  const sealed = await cipher.encrypt({ data: payload({ title, updatedAt }) })
  const { conflicts, acks } = await runPush([
    { newDocumentState: row({ sealed, updatedAt, version: 0 }) }
  ])
  expect(conflicts).toEqual([])
  expect(acks[0]?.version).toBeTypeOf('number')
  return { sealed, version: acks[0]!.version! }
}

/**
 * A sealed metadata body. On an encrypted collection the server requires the
 * user-writable `custom` to be a structurally valid encryption envelope, so a
 * `/meta` body is sealed exactly like a content body.
 *
 * @param label {string}
 * @returns {Promise<Json>}
 */
async function sealedMeta(label: string): Promise<Json> {
  const { envelope } = await cipher.encrypt({ data: { label } })
  return envelope
}

describe('conditional writes against an encrypted collection', () => {
  it('reports a stale If-Match as a conflict carrying the current master', async () => {
    // Protects: since was-client 0.42.0 an `If-Match` precondition APPLIES on an
    // encrypted collection. A stale baseline must lose the write and come back
    // as an RxDB conflict entry -- not throw, and not silently overwrite the
    // winner (the pre-0.42.0 last-write-wins degradation).
    const base = await createRow({
      title: 'the original',
      updatedAt: '2026-01-01T00:00:00.000Z'
    })

    // Another replica commits an update against the current baseline.
    const winnerPayload = payload({
      title: 'the winner',
      updatedAt: '2026-01-01T00:02:00.000Z'
    })
    const winner = await cipher.encryptUpdate({
      id: base.sealed.id,
      data: winnerPayload,
      current: base.sealed.envelope
    })
    const winnerVersion = await port.putContent({
      id: winner.id,
      data: winner.envelope,
      ifMatch: formatEtag(base.version),
      ...(winner.epoch !== undefined && { epoch: winner.epoch })
    })
    expect(winnerVersion).toBeTypeOf('number')

    // This replica still believes the baseline it created, and pushes over it.
    const loser = await cipher.encryptUpdate({
      id: base.sealed.id,
      data: payload({
        title: 'the loser',
        updatedAt: '2026-01-01T00:01:00.000Z'
      }),
      current: base.sealed.envelope
    })
    const assumed = row({
      sealed: base.sealed,
      updatedAt: '2026-01-01T00:00:00.000Z',
      version: base.version
    })
    const { conflicts } = await runPush([
      {
        newDocumentState: row({
          sealed: loser,
          updatedAt: '2026-01-01T00:01:00.000Z',
          version: base.version
        }),
        assumedMasterState: assumed
      }
    ])

    expect(conflicts).toHaveLength(1)
    const conflict = conflicts[0]!
    expect(conflict.id).toBe(base.sealed.id)
    expect(conflict._deleted).toBe(false)
    expect(conflict.version).toBe(winnerVersion)
    // The conflict entry carries the WINNER's envelope, which decrypts under
    // this app's identity key: the stale write did not land.
    expect(await cipher.decrypt({ envelope: conflict.data! })).toEqual(
      winnerPayload
    )
  }, 60000)

  it('reports a second create-if-absent as a conflict', async () => {
    // Protects: the `If-None-Match: *` half of the same assumption. A second
    // create of an id that already exists must be refused by the server (412)
    // and surface as a conflict entry, rather than clobbering the existing row.
    const base = await createRow({
      title: 'created once',
      updatedAt: '2026-02-01T00:00:00.000Z'
    })
    const original = await cipher.decrypt({ envelope: base.sealed.envelope })

    // A second replica that has never seen this resource pushes it as a create.
    const duplicate = await cipher.encryptUpdate({
      id: base.sealed.id,
      data: payload({
        title: 'created twice',
        updatedAt: '2026-02-01T00:01:00.000Z'
      }),
      current: base.sealed.envelope
    })
    const { conflicts } = await runPush([
      {
        newDocumentState: row({
          sealed: duplicate,
          updatedAt: '2026-02-01T00:01:00.000Z',
          version: 0
        })
      }
    ])

    expect(conflicts).toHaveLength(1)
    const conflict = conflicts[0]!
    expect(conflict.id).toBe(base.sealed.id)
    expect(conflict._deleted).toBe(false)
    expect(conflict.version).toBe(base.version)
    expect(await cipher.decrypt({ envelope: conflict.data! })).toEqual(original)
  }, 60000)

  it('reports a rejected /meta precondition as a conflict, not a throw', async () => {
    // Protects: the metadata half of a synced document is independently
    // versioned and carries its OWN precondition (`pushWrites.ts` lines
    // 237-239), which since was-client 0.42.0 applies on an encrypted
    // collection like the content half's. Both forms -- `If-None-Match: *`
    // when the replica believes no metadata exists, and a stale `If-Match` on
    // `metaVersion` -- must come back as conflict entries rather than
    // propagating an error out of the push handler.
    const base = await createRow({
      title: 'with metadata',
      updatedAt: '2026-03-01T00:00:00.000Z'
    })
    const assumedNoMeta = row({
      sealed: base.sealed,
      updatedAt: '2026-03-01T00:00:00.000Z',
      version: base.version
    })
    // On an encrypted collection the server refuses a plaintext `custom`, so
    // every metadata body here is a sealed envelope like the content bodies.
    const [first, second, third, stale] = await Promise.all([
      sealedMeta('first'),
      sealedMeta('second'),
      sealedMeta('third'),
      sealedMeta('stale')
    ])

    // First metadata write: the content half is unchanged, so only `/meta` is
    // written, with `If-None-Match: *`.
    const written = await runPush([
      {
        newDocumentState: { ...assumedNoMeta, custom: first },
        assumedMasterState: assumedNoMeta
      }
    ])
    expect(written.conflicts).toEqual([])
    const metaVersion = written.acks[0]?.metaVersion
    expect(metaVersion).toBeTypeOf('number')

    // A replica that still believes there is no metadata: `If-None-Match: *`
    // now fails against the metadata just written.
    const duplicate = await runPush([
      {
        newDocumentState: { ...assumedNoMeta, custom: second },
        assumedMasterState: assumedNoMeta
      }
    ])
    expect(duplicate.conflicts).toHaveLength(1)
    expect(duplicate.conflicts[0]!.metaVersion).toBe(metaVersion)
    expect(
      await cipher.decrypt({ envelope: duplicate.conflicts[0]!.custom! })
    ).toEqual({ label: 'first' })

    // Another replica commits a metadata update, moving `metaVersion` on.
    const bumped = await port.putMeta({
      id: base.sealed.id,
      custom: third,
      ifMatch: formatEtag(metaVersion!)
    })
    expect(bumped).toBeTypeOf('number')

    // A stale `If-Match` on `metaVersion` is refused the same way.
    const assumedStaleMeta: WithDeleted<SyncedDoc> = {
      ...assumedNoMeta,
      metaVersion: metaVersion!,
      custom: first
    }
    const lost = await runPush([
      {
        newDocumentState: { ...assumedStaleMeta, custom: stale },
        assumedMasterState: assumedStaleMeta
      }
    ])
    expect(lost.conflicts).toHaveLength(1)
    expect(lost.conflicts[0]!.metaVersion).toBe(bumped)
    expect(
      await cipher.decrypt({ envelope: lost.conflicts[0]!.custom! })
    ).toEqual({ label: 'third' })
  }, 60000)

  it('settles a concurrent push race into one resolvable conflict', async () => {
    // Protects: two replicas pushing the same baseline concurrently must
    // produce exactly one 412, reported as a conflict entry RxDB's conflict
    // handler can resolve -- never an unhandled rejection out of the push
    // handler. Both pushes go through the same port, as two replication cycles
    // of one session would.
    const base = await createRow({
      title: 'contested',
      updatedAt: '2026-04-01T00:00:00.000Z'
    })
    const assumed = row({
      sealed: base.sealed,
      updatedAt: '2026-04-01T00:00:00.000Z',
      version: base.version
    })

    const earlierAt = '2026-04-01T00:01:00.000Z'
    const laterAt = '2026-04-01T00:02:00.000Z'
    const [earlier, later] = await Promise.all([
      cipher.encryptUpdate({
        id: base.sealed.id,
        data: payload({ title: 'earlier edit', updatedAt: earlierAt }),
        current: base.sealed.envelope
      }),
      cipher.encryptUpdate({
        id: base.sealed.id,
        data: payload({ title: 'later edit', updatedAt: laterAt }),
        current: base.sealed.envelope
      })
    ])

    const rows: PushRow[] = [
      {
        newDocumentState: row({
          sealed: earlier,
          updatedAt: earlierAt,
          version: base.version
        }),
        assumedMasterState: assumed
      },
      {
        newDocumentState: row({
          sealed: later,
          updatedAt: laterAt,
          version: base.version
        }),
        assumedMasterState: assumed
      }
    ]
    const results = await Promise.all(rows.map(async each => runPush([each])))
    const conflicts = results.flatMap(result => result.conflicts)

    // Exactly one of the two writes won; the other came back as a conflict.
    expect(conflicts).toHaveLength(1)
    const loserIndex = results.findIndex(result => result.conflicts.length > 0)
    const conflict = conflicts[0]!
    expect(conflict.id).toBe(base.sealed.id)

    // The conflict entry is the input RxDB's LWW handler is written for: it
    // resolves to a real document rather than throwing.
    const handler = makeLwwConflictHandler(async envelope =>
      cipher.decrypt({ envelope })
    )
    const resolved = await handler.resolve({
      realMasterState: conflict,
      newDocumentState: rows[loserIndex]!.newDocumentState,
      assumedMasterState: assumed
    })
    // Later `updatedAt` wins, whichever push lost the race.
    const winning = await cipher.decrypt({ envelope: resolved.data! })
    expect((winning as { title: string }).title).toBe('later edit')
  }, 60000)
})
