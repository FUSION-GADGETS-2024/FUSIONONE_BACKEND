/**
 * The Analytics period model — the ONE shared filter (spec §10): preset
 * resolution against the financial year, clamping, empty-period
 * representability, labels, and the URL codec that keeps the workspace's
 * filter state across the five sections.
 */
import { describe, it, expect } from 'vitest'
import {
  decodePeriodPreset,
  encodePeriod,
  formatDateLabel,
  fyLabel,
  isEmptyPeriod,
  monthLabel,
  periodLabel,
  resolvePeriod,
} from '@/features/analytics/period'

const FY = { start_date: '2026-04-01', end_date: '2027-03-31', status: 'active' as const }

describe('resolvePeriod', () => {
  it("resolves 'This Financial Year' to the full FY window", () => {
    const p = resolvePeriod('fy', FY, undefined, '2026-10-08')
    expect(p).toEqual({ preset: 'fy', from: '2026-04-01', to: '2027-03-31' })
  })

  it("resolves 'This Month' as the current month intersected with the FY", () => {
    const p = resolvePeriod('month', FY, undefined, '2026-10-08')
    expect(p).toEqual({ preset: 'month', from: '2026-10-01', to: '2026-10-31' })
  })

  it("resolves 'This Quarter' as the current quarter intersected with the FY", () => {
    const p = resolvePeriod('quarter', FY, undefined, '2026-10-08')
    expect(p).toEqual({ preset: 'quarter', from: '2026-10-01', to: '2026-12-31' })
    // Q1 of the FY (Apr–Jun) with today inside it.
    const q2 = resolvePeriod('quarter', FY, undefined, '2026-05-15')
    expect(q2).toEqual({ preset: 'quarter', from: '2026-04-01', to: '2026-06-30' })
  })

  it('clamps custom ranges into the FY bounds', () => {
    const p = resolvePeriod('custom', FY, { from: '2026-01-01', to: '2027-12-31' }, '2026-10-08')
    expect(p).toEqual({ preset: 'custom', from: '2026-04-01', to: '2027-03-31' })
  })

  it('represents an empty window when the preset has no dates inside the FY', () => {
    // A future-dated active FY (early rollover) vs today's month.
    const futureFy = { start_date: '2027-04-01', end_date: '2028-03-31', status: 'active' as const }
    const p = resolvePeriod('month', futureFy, undefined, '2026-10-08')
    expect(isEmptyPeriod(p)).toBe(true)
    expect(p.from > p.to).toBe(true)
  })

  it('falls back to the FY window without a financial year', () => {
    const p = resolvePeriod('month', null, undefined, '2026-10-08')
    expect(p).toEqual({ preset: 'month', from: '', to: '' })
  })
})

describe('labels', () => {
  it('formats period labels in the app date language', () => {
    expect(formatDateLabel('2026-10-07')).toBe('7 Oct 2026')
    expect(periodLabel({ preset: 'fy', from: '2026-04-01', to: '2027-03-31' })).toBe('1 Apr 2026 – 31 Mar 2027')
    expect(periodLabel({ preset: 'custom', from: '2026-10-07', to: '2026-10-07' })).toBe('7 Oct 2026')
  })

  it('labels empty periods clearly', () => {
    expect(periodLabel({ preset: 'month', from: '2026-11-01', to: '2026-10-01' })).toBe(
      'No matching dates in this financial year',
    )
  })

  it('uses the established FY label convention', () => {
    expect(fyLabel(FY)).toBe('FY 2026\u20132027')
    expect(fyLabel(null)).toBe('—')
  })

  it('labels months compactly for charts', () => {
    expect(monthLabel('2026-04')).toBe('Apr 2026')
  })
})

describe('URL codec', () => {
  it('round-trips every preset', () => {
    for (const preset of ['fy', 'month', 'quarter'] as const) {
      const p = resolvePeriod(preset, FY, undefined, '2026-10-08')
      const encoded = encodePeriod(p)
      const decoded = decodePeriodPreset(encoded.replace(/^\?/, ''))
      expect(decoded.preset).toBe(preset)
    }
  })

  it('round-trips custom ranges with their bounds', () => {
    const p = resolvePeriod('custom', FY, { from: '2026-09-01', to: '2026-11-30' }, '2026-10-08')
    const decoded = decodePeriodPreset(encodePeriod(p).replace(/^\?/, ''))
    expect(decoded).toEqual({ preset: 'custom', from: '2026-09-01', to: '2026-11-30' })
  })

  it('treats unknown/absent params as the default preset', () => {
    expect(decodePeriodPreset('').preset).toBe('fy')
    expect(decodePeriodPreset('?period=bogus').preset).toBe('fy')
    expect(decodePeriodPreset('?period=month').preset).toBe('month')
  })
})
