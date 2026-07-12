/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
import { describe, it, expect } from 'vitest'
import { parseSeed, parseCollections } from './cli.js'

describe('parseSeed', () => {
  it('decodes a hex seed to raw bytes', () => {
    // "life-advisor-dev-seed-0123456789" as hex (32 bytes).
    const hex = '6c6966652d6164766973'
    expect(Array.from(parseSeed(hex))).toEqual([
      0x6c, 0x69, 0x66, 0x65, 0x2d, 0x61, 0x64, 0x76, 0x69, 0x73
    ])
  })

  it('decodes uppercase hex', () => {
    expect(Array.from(parseSeed('DEADBEEF'))).toEqual([0xde, 0xad, 0xbe, 0xef])
  })

  it('decodes a base64url seed to raw bytes', () => {
    // Bytes [0xfb, 0xff, 0xbf] encode as base64url "-_-_" (uses - and _).
    expect(Array.from(parseSeed('-_-_'))).toEqual([0xfb, 0xff, 0xbf])
  })

  it('trims surrounding whitespace', () => {
    expect(Array.from(parseSeed('  deadbeef  '))).toEqual([
      0xde, 0xad, 0xbe, 0xef
    ])
  })

  it('decodes hex and base64url of the same bytes to identical output', () => {
    const bytes = [0xfb, 0xff, 0xbf]
    expect(Array.from(parseSeed('fbffbf'))).toEqual(bytes)
    expect(Array.from(parseSeed('-_-_'))).toEqual(bytes)
  })
})

describe('parseCollections', () => {
  it('splits a comma-separated list', () => {
    expect(parseCollections('action-items,projects,goals')).toEqual([
      'action-items',
      'projects',
      'goals'
    ])
  })

  it('trims and drops empty entries', () => {
    expect(parseCollections(' a , , b ,')).toEqual(['a', 'b'])
  })
})
