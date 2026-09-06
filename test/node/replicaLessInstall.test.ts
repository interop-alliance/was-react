/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The replica-less install: an app that only reads a wallet-owned shared
 * collection builds no local replica, and should therefore resolve this library
 * with `rxdb` absent. Moving the replication driver into `@interop/was-sync`
 * (whose root entry is free of `rxdb` in its module graph and its declarations)
 * took the driver out of that app's graph, but it did not finish the job: the
 * root barrel still value-exports `LocalStore`, which value-imports
 * `rxdb/plugins/core`, and a missing package is a module resolution failure
 * rather than something a bundler drops.
 *
 * So this suite is written against the end state and SKIPPED. It is the gate on
 * WR-44 (splitting the `LocalStore` entry point so a replica-less install needs
 * no `rxdb`); unskip it there. The fixture stands in for a separate install: a
 * resolver where every `rxdb` entry point throws is what a missing peer looks
 * like at import time.
 *
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'

describe.skip('the replica-less install (gated on WR-44)', () => {
  it('resolves the root entry with rxdb absent', async () => {
    // `doMock` rather than `mock`: the hoisted form would run its factory even
    // while this suite is skipped, and fail the file rather than sit waiting
    // for WR-44.
    const absent = () => {
      throw new Error("Cannot find package 'rxdb'")
    }
    vi.doMock('rxdb/plugins/core', absent)
    vi.doMock('rxdb/plugins/storage-dexie', absent)
    vi.doMock('rxdb/plugins/replication', absent)

    const { replicaLessSurface } = await import('../fixtures/replicaLessApp.js')
    expect(replicaLessSurface()).toContain('SharedCollectionReader')
  })
})
