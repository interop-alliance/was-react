#!/usr/bin/env node
/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * CLI wrapper around `provisionDevGrants`. Creates a dev Space + collections on a
 * running was-teaching-server and delegates per-collection RW zcaps to the app
 * DID derived from `--seed`, optionally writing the grants JSON to `--out`.
 *
 * Usage:
 *   was-provision-dev-grants \
 *     --server-url http://localhost:3002 \
 *     --seed <hex-or-base64url 32-byte seed> \
 *     --collections action-items,projects,goals \
 *     [--space-name "Dev Space"] [--out ./public/dev-grants.local.json] [--probe]
 */
import { parseArgs } from 'node:util'
import { argv } from 'node:process'
import { pathToFileURL } from 'node:url'
import { base64urlnopad, hex } from '@scure/base'
import { provisionDevGrants } from './provisionDevGrants.js'

const USAGE = `Usage: was-provision-dev-grants [options]

Required:
  --server-url <url>       base URL of a running was-teaching-server
  --seed <string>          the app master seed, hex or base64url encoded
  --collections <ids>      comma-separated WAS collection ids

Optional:
  --space-name <name>      Space name (default "Dev Space")
  --out <path>             write the { grants } JSON to this file
  --probe                  probe whether the delegated RW zcap authorizes the
                           encryption-marker PUT
  --help                   show this message
`

/**
 * Decodes a seed string as hex (all hex chars, even length) or base64url.
 *
 * @param input {string}
 * @returns {Uint8Array}
 */
export function parseSeed(input: string): Uint8Array {
  const value = input.trim()
  if (/^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0) {
    // hex.decode requires lowercase, even-length input.
    return hex.decode(value.toLowerCase())
  }
  return base64urlnopad.decode(value)
}

/**
 * Splits a comma-separated collection-ids string into a trimmed, non-empty list.
 *
 * @param input {string}
 * @returns {string[]}
 */
export function parseCollections(input: string): string[] {
  return input
    .split(',')
    .map(id => id.trim())
    .filter(id => id.length > 0)
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'server-url': { type: 'string' },
      seed: { type: 'string' },
      collections: { type: 'string' },
      'space-name': { type: 'string' },
      out: { type: 'string' },
      probe: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false }
    }
  })

  if (values.help) {
    console.log(USAGE)
    return
  }

  const serverUrl = values['server-url']
  const seedInput = values.seed
  const collectionsInput = values.collections
  const missing: string[] = []
  if (!serverUrl) {
    missing.push('--server-url')
  }
  if (!seedInput) {
    missing.push('--seed')
  }
  if (!collectionsInput) {
    missing.push('--collections')
  }
  if (missing.length > 0) {
    console.error(`Missing required argument(s): ${missing.join(', ')}\n`)
    console.error(USAGE)
    process.exit(1)
  }

  const collections = parseCollections(collectionsInput!)
  if (collections.length === 0) {
    console.error('--collections must list at least one collection id.\n')
    console.error(USAGE)
    process.exit(1)
  }

  await provisionDevGrants({
    serverUrl: serverUrl!,
    seed: parseSeed(seedInput!),
    collections,
    spaceName: values['space-name'],
    outFile: values.out,
    probe: values.probe,
    log: console.log
  })
}

// Run only when invoked as a script, not when imported (e.g. by tests).
if (argv[1] !== undefined && import.meta.url === pathToFileURL(argv[1]).href) {
  main().catch(err => {
    console.error('Provisioning failed:', err)
    process.exit(1)
  })
}
