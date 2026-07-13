import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BoundedTextCapture, searchFilesFallback } from './tool-runner'

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

describe('built-in file search fallback', () => {
  it('finds text without rg while skipping dependency and build directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openworkbuddy-search-'))
    await mkdir(join(root, 'src'))
    await mkdir(join(root, 'node_modules'))
    await writeFile(join(root, 'src', 'report.md'), 'GraphRAG evidence\nsecond line\n')
    await writeFile(join(root, 'node_modules', 'ignored.txt'), 'GraphRAG hidden\n')

    const result = await searchFilesFallback(root, 'GraphRAG') as any
    expect(result).toMatchObject({ engine: 'builtin', matchCount: 1 })
    expect(result.matches[0]).toMatchObject({ path: 'src/report.md', line: 1, column: 1 })
    await rm(root, { recursive: true, force: true })
  })
})
