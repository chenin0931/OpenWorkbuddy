import { afterEach, describe, expect, it, vi } from 'vitest'

import { TextDeltaBuffer } from './event-buffer'

describe('TextDeltaBuffer', () => {
  afterEach(() => vi.useRealTimers())

  it('coalesces small deltas for at most 50 milliseconds', () => {
    vi.useFakeTimers()
    const emit = vi.fn()
    const buffer = new TextDeltaBuffer(emit)

    buffer.push('hello')
    buffer.push(' world')
    vi.advanceTimersByTime(49)
    expect(emit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(emit).toHaveBeenCalledWith('hello world')
  })

  it('flushes immediately once the pending text reaches 256 characters', () => {
    vi.useFakeTimers()
    const emit = vi.fn()
    const buffer = new TextDeltaBuffer(emit)

    buffer.push('x'.repeat(255))
    expect(emit).not.toHaveBeenCalled()
    buffer.push('y')
    expect(emit).toHaveBeenCalledWith(`${'x'.repeat(255)}y`)
  })

  it('flushes remaining text when disposed', () => {
    vi.useFakeTimers()
    const emit = vi.fn()
    const buffer = new TextDeltaBuffer(emit)
    buffer.push('final')
    buffer.dispose()
    expect(emit).toHaveBeenCalledWith('final')
  })
})
