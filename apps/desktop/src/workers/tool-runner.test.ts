import { describe, expect, it } from 'vitest'

import { BoundedTextCapture } from './tool-runner'

describe('BoundedTextCapture', () => {
  it('returns small output unchanged and counts UTF-8 bytes', () => {
    const capture = new BoundedTextCapture(64)
    capture.append('hello ')
    capture.append('世界')

    expect(capture.snapshot()).toEqual({
      text: 'hello 世界',
      truncated: false,
      total: Buffer.byteLength('hello 世界'),
      omittedBytes: 0,
    })
  })

  it('keeps the head and latest tail while reporting omitted bytes', () => {
    const capture = new BoundedTextCapture(10)
    capture.append('abcdefghijklmnop')

    expect(capture.retainedBytes).toBe(10)
    expect(capture.snapshot()).toEqual({
      text: 'abcdefg\n\n…[已省略 6 bytes]…\n\nnop',
      truncated: true,
      total: 16,
      omittedBytes: 6,
    })
  })

  it('rolls the tail across many chunks without exceeding its byte budget', () => {
    const capture = new BoundedTextCapture(12)
    for (const chunk of ['abc', 'defgh', 'ijk', 'lm', 'nop']) capture.append(chunk)

    expect(capture.retainedBytes).toBeLessThanOrEqual(12)
    expect(capture.snapshot()).toEqual({
      text: 'abcdefghi\n\n…[已省略 4 bytes]…\n\nnop',
      truncated: true,
      total: 16,
      omittedBytes: 4,
    })
  })

  it('stays bounded after a very large chunk and subsequent output', () => {
    const capture = new BoundedTextCapture(128)
    capture.append(Buffer.alloc(2 * 1024 * 1024, 'x'))
    capture.append('final-line')

    const snapshot = capture.snapshot()
    expect(capture.retainedBytes).toBe(128)
    expect(snapshot.total).toBe(2 * 1024 * 1024 + Buffer.byteLength('final-line'))
    expect(snapshot.omittedBytes).toBe(snapshot.total - 128)
    expect(snapshot.text.endsWith('final-line')).toBe(true)
  })
})
