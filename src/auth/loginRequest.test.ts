/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * buildGrantsVpr tests: VPR #2 emits exactly one collection-scoped capability
 * query per requested collection, delegated to the controller DID, and adds no
 * extra whole-space query.
 */
import { describe, expect, it } from 'vitest'
import { buildGrantsVpr, RW_ACTIONS } from './loginRequest.js'
import type {
  ICapabilityQueryDetail,
  IVPRDetails,
  IZcapQuery
} from './walletRequestTypes.js'

const BASE = {
  challenge: 'challenge-1',
  domain: 'https://app.example',
  controllerDid: 'did:key:zApp',
  appName: 'Example'
}

function capabilityQueriesOf(vpr: IVPRDetails): ICapabilityQueryDetail[] {
  const queries = Array.isArray(vpr.query) ? vpr.query : [vpr.query]
  const zcapQuery = queries.find(
    (entry): entry is IZcapQuery =>
      entry.type === 'AuthorizationCapabilityQuery'
  )
  if (zcapQuery === undefined) {
    throw new Error('No AuthorizationCapabilityQuery in the VPR.')
  }
  const { capabilityQuery } = zcapQuery
  return Array.isArray(capabilityQuery) ? capabilityQuery : [capabilityQuery]
}

describe('buildGrantsVpr', () => {
  it('emits exactly one collection-scoped query per collection and no more', () => {
    const collections = ['notes', 'projects']
    const vpr = buildGrantsVpr({ ...BASE, collections })
    const capabilityQuery = capabilityQueriesOf(vpr)

    expect(capabilityQuery).toHaveLength(collections.length)
    expect(capabilityQuery.map(entry => entry.referenceId)).toEqual(collections)
    for (const entry of capabilityQuery) {
      expect(entry.invocationTarget).toEqual({
        type: 'urn:was:collection',
        name: entry.referenceId
      })
      expect(entry.controller).toBe(BASE.controllerDid)
      expect(entry.allowedAction).toEqual(RW_ACTIONS)
    }
  })

  it('requests no whole-space (urn:was:space) query', () => {
    const vpr = buildGrantsVpr({ ...BASE, collections: ['notes'] })
    const capabilityQuery = capabilityQueriesOf(vpr)

    const hasSpaceQuery = capabilityQuery.some(
      entry =>
        typeof entry.invocationTarget === 'object' &&
        entry.invocationTarget.type === 'urn:was:space'
    )
    expect(hasSpaceQuery).toBe(false)
  })

  it('honors a custom action set', () => {
    const vpr = buildGrantsVpr({
      ...BASE,
      collections: ['notes'],
      actions: ['GET', 'HEAD']
    })
    const capabilityQuery = capabilityQueriesOf(vpr)
    expect(capabilityQuery).toHaveLength(1)
    expect(capabilityQuery[0]?.allowedAction).toEqual(['GET', 'HEAD'])
  })
})
