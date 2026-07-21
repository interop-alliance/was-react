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
        { updatedAt: '2026-01-02T00:00:00.000Z', clientId: 'a' },
        { updatedAt: '2026-01-01T00:00:00.000Z', clientId: 'z' }
      )
    ).toBe(true)
  })

  it('earlier updatedAt loses (local newer)', () => {
    expect(
      remotePayloadWins(
        { updatedAt: '2026-01-01T00:00:00.000Z', clientId: 'z' },
        { updatedAt: '2026-01-02T00:00:00.000Z', clientId: 'a' }
      )
    ).toBe(false)
  })

  it('breaks an exact updatedAt tie by greater clientId', () => {
    const at = '2026-01-01T00:00:00.000Z'
    expect(
      remotePayloadWins(
        { updatedAt: at, clientId: 'b' },
        { updatedAt: at, clientId: 'a' }
      )
    ).toBe(true)
    expect(
      remotePayloadWins(
        { updatedAt: at, clientId: 'a' },
        { updatedAt: at, clientId: 'b' }
      )
    ).toBe(false)
  })

  it('a fully identical payload does not let remote win', () => {
    const same = { updatedAt: '2026-01-01T00:00:00.000Z', clientId: 'a' }
    expect(remotePayloadWins(same, same)).toBe(false)
  })
})
