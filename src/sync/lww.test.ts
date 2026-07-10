/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Unit tests for the last-write-wins tiebreak.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { remotePayloadWins } from './lww.js'

describe('remotePayloadWins', () => {
  it('later updatedAt wins (remote newer)', () => {
    expect(
      remotePayloadWins(
        { updatedAt: '2026-01-02T00:00:00.000Z', deviceId: 'a' },
        { updatedAt: '2026-01-01T00:00:00.000Z', deviceId: 'z' }
      )
    ).toBe(true)
  })

  it('earlier updatedAt loses (local newer)', () => {
    expect(
      remotePayloadWins(
        { updatedAt: '2026-01-01T00:00:00.000Z', deviceId: 'z' },
        { updatedAt: '2026-01-02T00:00:00.000Z', deviceId: 'a' }
      )
    ).toBe(false)
  })

  it('breaks an exact updatedAt tie by greater deviceId', () => {
    const at = '2026-01-01T00:00:00.000Z'
    expect(
      remotePayloadWins(
        { updatedAt: at, deviceId: 'b' },
        { updatedAt: at, deviceId: 'a' }
      )
    ).toBe(true)
    expect(
      remotePayloadWins(
        { updatedAt: at, deviceId: 'a' },
        { updatedAt: at, deviceId: 'b' }
      )
    ).toBe(false)
  })

  it('a fully identical payload does not let remote win', () => {
    const same = { updatedAt: '2026-01-01T00:00:00.000Z', deviceId: 'a' }
    expect(remotePayloadWins(same, same)).toBe(false)
  })
})
