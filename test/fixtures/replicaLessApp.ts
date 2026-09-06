/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The replica-less consumer fixture: everything a BYOE app that only READS a
 * wallet-owned shared collection asks of this library. It builds no local
 * replica, so it should resolve with `rxdb` absent from the install.
 *
 * It is a fixture rather than a test: `test/node/replicaLessInstall.test.ts`
 * imports it under a resolver where every `rxdb` entry point fails, which is
 * what a missing peer looks like.
 */
import {
  SharedCollectionReader,
  deriveIdentity,
  parseGrants,
  useSharedCollection
} from '../../src/index.js'

/**
 * Names the replica-less surface so the imports above cannot be dropped as
 * unused, and so a change that moves one of them off the root entry fails here
 * rather than in a consumer's build.
 *
 * @returns {string[]}
 */
export function replicaLessSurface(): string[] {
  return [
    SharedCollectionReader.name,
    deriveIdentity.name,
    parseGrants.name,
    useSharedCollection.name
  ]
}
