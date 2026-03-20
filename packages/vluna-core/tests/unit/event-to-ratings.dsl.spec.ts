import { describe, it, expect } from 'vitest'
import {
  compileEventToRatingsDsl,
  evaluateEventToRatingsDsl,
  resolveEventToRatingsParams,
  ContractParamResolutionError,
} from '../../src/services/event-to-ratings.dsl.js'
import type { EngineInput } from '../../src/services/event-to-ratings.dsl.js'

function buildEventInput(overrides?: Partial<Extract<EngineInput, { source_kind: 'event' }>>): Extract<EngineInput, { source_kind: 'event' }> {
  return {
    source_kind: 'event',
    realm_id: 'realm-default',
    billing_account_id: 'ba_1',
    semantic_kind: 'outcome',
    occurred_at: '2025-01-01T00:00:00Z',
    event_type: 'demo.outcome',
    subject_ref: 'subj_1',
    payload: {},
    labels: {},
    ...overrides,
  }
}

function buildAggregateInput(overrides?: Partial<Extract<EngineInput, { source_kind: 'aggregate' }>>): Extract<EngineInput, { source_kind: 'aggregate' }> {
  return {
    source_kind: 'aggregate',
    realm_id: 'realm-default',
    billing_account_id: 'ba_1',
    semantic_kind: 'outcome',
    event_type: 'demo.outcome',
    aggregation: {
      window_start: '2025-01-01T00:00:00Z',
      window_end: '2025-01-02T00:00:00Z',
    },
    aggs: { count: 7 },
    ...overrides,
  }
}

describe('event-to-ratings.dsl v1', { tags: ['unit'] }, () => {
  it('supports params.source.term_key and resolves from term values', () => {
    const raw: unknown = {
      dsl_version: 'v1',
      engine: 'single',
      params: {
        min_units: { type: 'int', default: 1, source: { term_key: 'x' } },
      },
      match: { event_type: 'demo.outcome' },
      emit: {
        intents: [
          {
            feature_code: 'demo.outcome',
            meters: [
              { meter_code: 'demo.outcome', quantity_minor: { param: 'min_units' } },
            ],
          },
        ],
      },
    }
    const compiled = compileEventToRatingsDsl(raw)
    const { params } = resolveEventToRatingsParams(compiled, { x: 9 })
    const res = evaluateEventToRatingsDsl(compiled, buildEventInput(), params)
    expect(res?.intents[0]?.meters[0]?.quantityMinor).toBe(9)
  })

  it('throws contract_term_missing when param has source and no default and term missing', () => {
    const raw: unknown = {
      dsl_version: 'v1',
      engine: 'single',
      params: {
        min_units: { type: 'int', source: { term_key: 'x' } },
      },
      match: { event_type: 'demo.outcome' },
      emit: { intents: [{ feature_code: 'demo.outcome', meters: [{ meter_code: 'demo.outcome', quantity_minor: 1 }] }] },
    }
    const compiled = compileEventToRatingsDsl(raw)
    expect(() => resolveEventToRatingsParams(compiled, {})).toThrow(ContractParamResolutionError)
  })

  it('rejects non-exact match.event_type ops (prefix/regex reserved but not implemented)', () => {
    const raw: unknown = {
      dsl_version: 'v1',
      engine: 'single',
      params: {},
      match: { event_type: { op: 'prefix', value: 'demo.' } },
      emit: { intents: [{ feature_code: 'demo.outcome', meters: [{ meter_code: 'demo.outcome', quantity_minor: 1 }] }] },
    }
    expect(() => compileEventToRatingsDsl(raw)).toThrow(/not implemented/i)
  })

  it('matches exact event_type and evaluates payload_int / label_str / params', () => {
    const raw: unknown = {
      dsl_version: 'v1',
      engine: 'single',
      params: {
        min_tokens: { type: 'int', default: 5 },
      },
      match: {
        event_type: 'demo.outcome',
        where: {
          all: [
            { gte: [{ payload: 'usage.tokens' }, { param: 'min_tokens' }] },
            { eq: [{ label: 'env' }, 'prod'] },
          ],
        },
      },
      emit: {
        intents: [
          {
            link_kind: 'billed',
            feature_code: 'demo.outcome',
            meters: [
              {
                meter_code: 'demo.outcome',
                quantity_minor: { payload_int: 'usage.tokens', default: 0 },
              },
            ],
            labels: {
              env: { label_str: 'env', default: 'unknown' },
            },
          },
        ],
      },
    }
    const compiled = compileEventToRatingsDsl(raw)
    const { params } = resolveEventToRatingsParams(compiled, {})
    const res = evaluateEventToRatingsDsl(
      compiled,
      buildEventInput({
        payload: { usage: { tokens: 12 } },
        labels: { env: 'prod' },
      }),
      params,
    )
    expect(res?.intents[0]?.meters[0]?.quantityMinor).toBe(12)
    expect(res?.intents[0]?.labels?.env).toBe('prod')
  })

  it('treats missing payload/label as non-match unless exists/default used', () => {
    const raw: unknown = {
      dsl_version: 'v1',
      engine: 'single',
      params: {},
      match: {
        event_type: 'demo.outcome',
        where: { exists: [{ payload: 'missing.path' }] },
      },
      emit: { intents: [{ feature_code: 'demo.outcome', meters: [{ meter_code: 'demo.outcome', quantity_minor: 1 }] }] },
    }
    const compiled = compileEventToRatingsDsl(raw)
    const { params } = resolveEventToRatingsParams(compiled, {})
    const res = evaluateEventToRatingsDsl(compiled, buildEventInput(), params)
    expect(res).toBeNull()
  })

  it('supports arithmetic int_expr (mul/div rounding) and clamps negative quantities to >= 0', () => {
    const raw: unknown = {
      dsl_version: 'v1',
      engine: 'single',
      params: {},
      match: { event_type: 'demo.outcome' },
      emit: {
        intents: [
          {
            feature_code: 'demo.outcome',
            feature_quantity_minor: { div: [{ mul: [{ payload_int: 'n', default: 0 }, 10] }, 3], rounding: 'nearest' },
            meters: [
              { meter_code: 'demo.outcome', quantity_minor: { payload_int: 'neg', default: 0 } },
            ],
          },
        ],
      },
    }
    const compiled = compileEventToRatingsDsl(raw)
    const { params } = resolveEventToRatingsParams(compiled, {})
    const res = evaluateEventToRatingsDsl(
      compiled,
      buildEventInput({
        payload: { n: 2, neg: -3 },
      }),
      params,
    )
    expect(res?.intents[0]?.quantityMinor).toBe(7) // (2*10)/3 ~= 6.666 -> nearest = 7
    expect(res?.intents[0]?.meters[0]?.quantityMinor).toBe(0) // clamp
  })

  it('supports agg.op=count in aggregate mode', () => {
    const raw: unknown = {
      dsl_version: 'v1',
      engine: 'aggregate',
      params: {},
      match: { event_type: 'demo.outcome' },
      emit: {
        intents: [
          {
            feature_code: 'demo.outcome',
            meters: [
              { meter_code: 'demo.outcome', quantity_minor: { agg: { op: 'count' } } },
            ],
            metadata: {
              window_start: { const: 'x' },
            },
          },
        ],
      },
    }
    const compiled = compileEventToRatingsDsl(raw)
    const { params } = resolveEventToRatingsParams(compiled, {})
    const res = evaluateEventToRatingsDsl(
      compiled,
      buildAggregateInput({ aggregation: { window_start: 'a', window_end: 'b' }, aggs: { count: 7 } }),
      params,
    )
    expect(res?.intents[0]?.meters[0]?.quantityMinor).toBe(7)
    expect(res?.intents[0]?.metadata?.window_start).toBe('x')
  })
})
