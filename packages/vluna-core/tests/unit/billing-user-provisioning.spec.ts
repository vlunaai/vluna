import { describe, expect, it } from 'vitest'
import { HttpException } from '@nestjs/common'
import {
  normalizeSeatLimitValue,
  resolveSeatLimitFromMetadata,
} from '../../src/services/billing-user-provisioning.js'

describe('billing user provisioning seat metadata', { tags: ['unit'] }, () => {
  it('resolves fixed seat limits', () => {
    expect(resolveSeatLimitFromMetadata({ seat_limit: { mode: 'fixed', limit: 5 } })).toBe(5)
    expect(resolveSeatLimitFromMetadata({ seat_limit: '7' })).toBe(7)
  })

  it('resolves quantity-based seat limits', () => {
    expect(resolveSeatLimitFromMetadata({ seat_limit: { mode: 'per_unit', seats_per_unit: 2 } }, 3)).toBe(6)
    expect(resolveSeatLimitFromMetadata({ seat_limit: { mode: 'per_unit' } }, 4)).toBe(4)
  })

  it('represents unlimited seats as null', () => {
    expect(resolveSeatLimitFromMetadata({ seat_limit: null })).toBeNull()
    expect(resolveSeatLimitFromMetadata({ seat_limit: { mode: 'unlimited' } })).toBeNull()
    expect(resolveSeatLimitFromMetadata({ seat_limit: { unlimited: true } })).toBeNull()
  })

  it('rejects invalid explicit seat limits', () => {
    expect(() => normalizeSeatLimitValue(-1)).toThrow(HttpException)
    expect(() => normalizeSeatLimitValue(1.5)).toThrow(HttpException)
    expect(() => normalizeSeatLimitValue('abc')).toThrow(HttpException)
  })
})
