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

  it('orders mixed-precision stamps chronologically, both directions', () => {
    // `...05Z` is EARLIER than `...05.400Z` by instant, but LEXICALLY greater
    // ('Z' > '.'), so a string compare would invert this pair. `updatedAt` is
    // app-owned and its precision varies, so the compare must parse.
    const coarse = { updatedAt: '2026-07-12T10:00:05Z', clientId: 'dA' }
    const fine = { updatedAt: '2026-07-12T10:00:05.400Z', clientId: 'dB' }
    expect(remotePayloadWins(fine, coarse)).toBe(true)
    expect(remotePayloadWins(coarse, fine)).toBe(false)
  })

  it('treats a +00:00 offset and its Z form as the same instant (clientId decides)', () => {
    const offset = '2026-07-12T10:00:05.400+00:00'
    const zulu = '2026-07-12T10:00:05.400Z'
    expect(Date.parse(offset)).toBe(Date.parse(zulu))
    // Same instant, different spellings: the tie falls to the clientId rule,
    // not to the (misleading) lexical compare of the two spellings.
    expect(
      remotePayloadWins(
        { updatedAt: offset, clientId: 'dZ' },
        { updatedAt: zulu, clientId: 'dA' }
      )
    ).toBe(true)
    expect(
      remotePayloadWins(
        { updatedAt: offset, clientId: 'dA' },
        { updatedAt: zulu, clientId: 'dZ' }
      )
    ).toBe(false)
  })

  it('lets a parseable stamp beat an unparseable one, both directions', () => {
    const good = { updatedAt: '2026-07-12T10:00:05.400Z', clientId: 'dA' }
    const junk = { updatedAt: 'not-a-date', clientId: 'dZ' }
    expect(remotePayloadWins(good, junk)).toBe(true)
    expect(remotePayloadWins(junk, good)).toBe(false)
  })

  it('falls back to a lexical compare when neither stamp parses', () => {
    expect(
      remotePayloadWins(
        { updatedAt: 'T2', clientId: 'dA' },
        { updatedAt: 'T1', clientId: 'dZ' }
      )
    ).toBe(true)
    expect(
      remotePayloadWins(
        { updatedAt: 'T1', clientId: 'dZ' },
        { updatedAt: 'T2', clientId: 'dA' }
      )
    ).toBe(false)
  })
})
