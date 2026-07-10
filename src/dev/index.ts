/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Node-only dev tooling, exposed through the package `./dev` subpath. Provisions
 * dev grants against a running was-teaching-server so an app can dev-sync
 * without a CHAPI wallet in the loop.
 */
export {
  provisionDevGrants,
  DEFAULT_PROVISIONER_SEED,
  type ProvisionDevGrantsResult
} from './provisionDevGrants.js'
