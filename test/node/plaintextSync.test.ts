/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * End-to-end plaintext-collection sync against a real in-process
 * was-teaching-server (the published npm package): provisions a dev Space with
 * a public (plaintext) collection and a private (encrypted) one, replicates
 * local writes up through the real sync stack, asserts the server-side bodies
 * (the public payload verbatim; an EDV envelope for the private one), and
 * pulls both back down into a second, fresh replica.
 *
 * @vitest-environment node
 */
import 'fake-indexeddb/auto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, FileSystemBackend } from 'was-teaching-server'
import { provisionDevGrants } from '../../src/dev/provisionDevGrants.js'
import { parseGrants, type ParsedGrants } from '../../src/grants.js'
import { deriveIdentity } from '../../src/identity/agents.js'
import { LocalStore } from '../../src/storage/localStore.js'
import { startWasSync } from '../../src/storage/wasSync.js'
import {
  createSyncController,
  type SyncController
} from '../../src/storage/syncController.js'
import type { WasRemoteStore } from '../../src/storage/wasRemoteStore.js'
import type { ZcapClient } from '@interop/ezcap'
import type { WasCollectionConfig } from '../../src/config.js'

// The SyncController wires an `online` listener on `window`; Node has no
// window, so give it an inert stand-in.
;(globalThis as { window?: unknown }).window ??= {
  addEventListener: () => {},
  removeEventListener: () => {}
}

const PUBLIC_ID = 'microblog-posts'
const PRIVATE_ID = 'notes'
const REGISTRY: WasCollectionConfig[] = [
  { key: 'posts', id: PUBLIC_ID, visibility: 'public' },
  { key: 'notes', id: PRIVATE_ID }
]

// A fixed 32-byte app (relying party) master seed.
const SEED = new Uint8Array(32).map((_, index) => (index * 13 + 5) & 0xff)

interface PostDoc {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  deviceId: string
}

function makeDoc(title: string): PostDoc {
  const now = new Date().toISOString()
  return {
    id: crypto.randomUUID(),
    title,
    createdAt: now,
    updatedAt: now,
    deviceId: 'device-test'
  }
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

/**
 * Polls `probe` until it resolves non-null (errors count as null) or the
 * timeout elapses.
 */
async function waitFor<T>(
  probe: () => Promise<T | null>,
  label: string,
  timeoutMs = 30000
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const result = await probe().catch(() => null)
    if (result !== null) {
      return result
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}.`)
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

let dataDir: string
let app: Awaited<ReturnType<typeof createApp>>
let serverUrl: string
let parsed: ParsedGrants
let zcapClient: ZcapClient
const controllers: SyncController[] = []
const stores: LocalStore[] = []
let remoteStore: WasRemoteStore

// Written by the push test, read back by the pull test.
const post = makeDoc('A world-readable post')
const note = makeDoc('secret-note-marker')

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'was-react-plaintext-'))
  const port = await freePort()
  serverUrl = `http://localhost:${port}`
  app = createApp({
    serverUrl,
    backend: new FileSystemBackend({ dataDir, capacityBytes: Infinity })
  })
  await app.listen({ port, host: '0.0.0.0' })

  const provisioned = await provisionDevGrants({
    serverUrl,
    seed: SEED,
    collections: [PUBLIC_ID, PRIVATE_ID]
  })
  parsed = parseGrants(provisioned.grants)
  ;({ zcapClient } = await deriveIdentity({ seed: SEED }))
}, 60000)

afterAll(async () => {
  for (const controller of controllers) {
    await controller.stop()
  }
  for (const store of stores) {
    await store.close()
  }
  await app.close()
  await rm(dataDir, { recursive: true, force: true })
}, 60000)

/**
 * Opens a replica over the registry and starts real replication against the
 * in-process server (fast retry/poll so the tests converge quickly).
 */
async function openSyncedReplica(dbName: string): Promise<LocalStore> {
  const store = await LocalStore.init({
    seed: SEED,
    collections: REGISTRY,
    dbName
  })
  stores.push(store)
  const controller = createSyncController({
    collections: REGISTRY,
    sync: { pollMs: 500, retryMs: 500 }
  })
  controllers.push(controller)
  remoteStore = await startWasSync({
    parsed,
    zcapClient,
    collections: REGISTRY,
    localStore: store,
    syncController: controller,
    onRemoteChange: () => {}
  })
  return store
}

describe('plaintext-collection sync against was-teaching-server', () => {
  it('pushes the public payload verbatim and the private one encrypted', async () => {
    const store = await openSyncedReplica('plaintext-sync-a')
    await store.insertEntity('posts', post)
    await store.insertEntity('notes', note)

    // The public resource lands under its own logical id, plaintext.
    const publicBody = await waitFor(async () => {
      const response = await remoteStore.was.request({
        capability: remoteStore.collectionCapability(PUBLIC_ID),
        path: `/space/${remoteStore.spaceId}/${PUBLIC_ID}/${post.id}`,
        method: 'GET'
      })
      return response.data as PostDoc
    }, 'the public resource to be pushed')
    expect(publicBody).toEqual(post)

    // The private resource lands under its random envelope id, as ciphertext.
    const rows = await store.rxCollection('notes').find().exec()
    expect(rows).toHaveLength(1)
    const envelopeId = rows[0]!.id
    expect(envelopeId).not.toBe(note.id)
    const privateBody = await waitFor(async () => {
      const response = await remoteStore.was.request({
        capability: remoteStore.collectionCapability(PRIVATE_ID),
        path: `/space/${remoteStore.spaceId}/${PRIVATE_ID}/${envelopeId}`,
        method: 'GET'
      })
      return response.data as { jwe?: unknown }
    }, 'the private envelope to be pushed')
    expect(typeof privateBody.jwe).toBe('object')
    expect(JSON.stringify(privateBody)).not.toContain('secret-note-marker')
  }, 60000)

  it('leaves the public collection unmarked (no encryption marker)', async () => {
    const response = await remoteStore.was.request({
      capability: remoteStore.collectionCapability(PUBLIC_ID),
      path: `/space/${remoteStore.spaceId}/${PUBLIC_ID}`,
      method: 'GET'
    })
    const description = response.data as { encryption?: unknown }
    expect(description.encryption).toBeUndefined()
  }, 60000)

  it('pulls both collections into a fresh replica', async () => {
    const replica = await openSyncedReplica('plaintext-sync-b')

    const pulledPosts = await waitFor(async () => {
      const listed = await replica.listEntities<PostDoc>('posts')
      return listed.length > 0 ? listed : null
    }, 'the public post to be pulled')
    expect(pulledPosts).toEqual([post])

    const pulledNotes = await waitFor(async () => {
      const listed = await replica.listEntities<PostDoc>('notes')
      return listed.length > 0 ? listed : null
    }, 'the private note to be pulled')
    expect(pulledNotes).toEqual([note])
  }, 60000)
})
