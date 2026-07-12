import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PANEL_WIDTH,
  MAX_PANEL_WIDTH,
  MIN_PANEL_WIDTH,
  clampPanelWidth,
} from './panel-resizer'

describe('clampPanelWidth', () => {
  it('keeps widths inside the default bounds', () => {
    expect(clampPanelWidth(DEFAULT_PANEL_WIDTH)).toBe(330)
    expect(clampPanelWidth(376)).toBe(376)
  })

  it('clamps widths to the default minimum and maximum', () => {
    expect(clampPanelWidth(120)).toBe(MIN_PANEL_WIDTH)
    expect(clampPanelWidth(900)).toBe(MAX_PANEL_WIDTH)
  })

  it('rounds fractional pixels and falls back for non-finite values', () => {
    expect(clampPanelWidth(350.6)).toBe(351)
    expect(clampPanelWidth(Number.NaN)).toBe(DEFAULT_PANEL_WIDTH)
    expect(clampPanelWidth(Number.POSITIVE_INFINITY)).toBe(DEFAULT_PANEL_WIDTH)
  })

  it('supports custom and reversed bounds', () => {
    expect(clampPanelWidth(250, 220, 280)).toBe(250)
    expect(clampPanelWidth(100, 420, 300)).toBe(300)
    expect(clampPanelWidth(500, 420, 300)).toBe(420)
  })
})
