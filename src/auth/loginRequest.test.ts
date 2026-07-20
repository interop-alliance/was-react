/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * buildAppConnectVpr tests: the one-popup App Connect VPR carries a
 * DIDAuthentication query plus a single `AppConnectQuery` naming the app and the
 * seed-credential, with exactly one collection-scoped capability query per
 * requested collection -- and no `controller` or `reason` on those entries (the
 * wallet fills the controller; the consent screen supersedes reasons).
 */
import { describe, expect, it } from 'vitest'
import { buildAppConnectVpr, RW_ACTIONS } from './loginRequest.js'
import type {
  IAppConnectCapabilityQuery,
  IAppConnectQuery,
  IVPRDetails
} from './walletRequestTypes.js'

const BASE = {
  challenge: 'challenge-1',
  domain: 'https://app.example',
  appName: 'Example',
  credential: {
    credentialType: 'ExampleAppKey',
    vocabBase: 'urn:example:vocab#'
  }
}

function appConnectQueryOf(vpr: IVPRDetails): IAppConnectQuery {
  const queries = Array.isArray(vpr.query) ? vpr.query : [vpr.query]
  const query = queries.find(
    (entry): entry is IAppConnectQuery => entry.type === 'AppConnectQuery'
  )
  if (query === undefined) {
    throw new Error('No AppConnectQuery in the VPR.')
  }
  return query
}

function capabilityQueriesOf(vpr: IVPRDetails): IAppConnectCapabilityQuery[] {
  const { capabilityQuery } = appConnectQueryOf(vpr)
  return Array.isArray(capabilityQuery) ? capabilityQuery : [capabilityQuery]
}

describe('buildAppConnectVpr', () => {
  it('includes a DIDAuthentication query alongside the AppConnectQuery', () => {
    const vpr = buildAppConnectVpr({ ...BASE, collections: [{ id: 'notes' }] })
    const queries = Array.isArray(vpr.query) ? vpr.query : [vpr.query]
    expect(queries.map(entry => entry.type)).toEqual([
      'DIDAuthentication',
      'AppConnectQuery'
    ])
    expect(vpr.challenge).toBe(BASE.challenge)
    expect(vpr.domain).toBe(BASE.domain)
  })

  it('carries the app name and seed-credential naming in the app block', () => {
    const vpr = buildAppConnectVpr({ ...BASE, collections: [{ id: 'notes' }] })
    expect(appConnectQueryOf(vpr).app).toEqual({
      name: BASE.appName,
      credentialType: BASE.credential.credentialType,
      vocabBase: BASE.credential.vocabBase
    })
  })

  it('emits exactly one collection-scoped query per collection, no controller or reason', () => {
    const collections = [{ id: 'notes' }, { id: 'projects' }]
    const vpr = buildAppConnectVpr({ ...BASE, collections })
    const capabilityQuery = capabilityQueriesOf(vpr)

    expect(capabilityQuery).toHaveLength(collections.length)
    expect(capabilityQuery.map(entry => entry.referenceId)).toEqual(
      collections.map(collection => collection.id)
    )
    for (const entry of capabilityQuery) {
      expect(entry.invocationTarget).toEqual({
        type: 'urn:was:collection',
        name: entry.referenceId
      })
      expect(entry.allowedAction).toEqual(RW_ACTIONS)
      // The wallet fills the controller; the consent screen supersedes reasons.
      expect('controller' in entry).toBe(false)
      expect('reason' in entry).toBe(false)
    }
  })

  it(
    'emits urn:was:public-collection for visibility: public and keeps ' +
      'private collections on urn:was:collection',
    () => {
      const vpr = buildAppConnectVpr({
        ...BASE,
        collections: [
          { id: 'microblog-posts', visibility: 'public' },
          { id: 'drafts', visibility: 'private' },
          { id: 'notes' }
        ]
      })
      const capabilityQuery = capabilityQueriesOf(vpr)

      expect(capabilityQuery.map(entry => entry.invocationTarget)).toEqual([
        { type: 'urn:was:public-collection', name: 'microblog-posts' },
        { type: 'urn:was:collection', name: 'drafts' },
        { type: 'urn:was:collection', name: 'notes' }
      ])
      // Public collections get the same RW zcap request: public covers only
      // unauthenticated reads; writes stay capability-only.
      for (const entry of capabilityQuery) {
        expect(entry.allowedAction).toEqual(RW_ACTIONS)
      }
    }
  )

  it('requests no whole-space (urn:was:space) query', () => {
    const vpr = buildAppConnectVpr({ ...BASE, collections: [{ id: 'notes' }] })
    const capabilityQuery = capabilityQueriesOf(vpr)

    const hasSpaceQuery = capabilityQuery.some(
      entry =>
        typeof entry.invocationTarget === 'object' &&
        entry.invocationTarget.type === 'urn:was:space'
    )
    expect(hasSpaceQuery).toBe(false)
  })

  it('honors a custom action set', () => {
    const vpr = buildAppConnectVpr({
      ...BASE,
      collections: [{ id: 'notes' }],
      actions: ['GET', 'HEAD']
    })
    const capabilityQuery = capabilityQueriesOf(vpr)
    expect(capabilityQuery).toHaveLength(1)
    expect(capabilityQuery[0]?.allowedAction).toEqual(['GET', 'HEAD'])
  })

  it('emits an empty capabilityQuery when no collections are requested', () => {
    const vpr = buildAppConnectVpr({ ...BASE, collections: [] })
    expect(capabilityQueriesOf(vpr)).toEqual([])
  })
})
