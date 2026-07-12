/// <reference types="node" />

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const designDirectory = fileURLToPath(new URL('.', import.meta.url))
const rendererDirectory = fileURLToPath(new URL('..', import.meta.url))

function readRendererFile(path: string): string {
  return readFileSync(join(rendererDirectory, path), 'utf8')
}

function readDesignFile(path: string): string {
  return readFileSync(join(designDirectory, path), 'utf8')
}

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? filesUnder(path) : [path]
  })
}

const mainSource = readRendererFile('main.tsx')
const baseCss = readDesignFile('base.css')
const indexCss = readDesignFile('index.css')
const overlaysCss = readDesignFile('overlays.css')
const pagesCss = readDesignFile('pages.css')
const shellCss = readDesignFile('shell.css')
const tokensCss = readDesignFile('tokens.css')
const workCss = readDesignFile('work.css')

const productStyles = [
  ['base.css', baseCss],
  ['shell.css', shellCss],
  ['work.css', workCss],
  ['pages.css', pagesCss],
  ['overlays.css', overlaysCss],
] as const

const rendererSourceFiles = filesUnder(rendererDirectory)
  .filter((file) => ['.ts', '.tsx'].includes(extname(file)) && !file.includes('.test.'))

interface Declaration {
  file: string
  line: number
  value: string
}

function declarations(file: string, source: string, property: string): Declaration[] {
  const matches: Declaration[] = []
  const pattern = new RegExp(`\\b${property}\\s*:\\s*([^;}\\n]+)`, 'g')
  for (const match of source.matchAll(pattern)) {
    const index = match.index ?? 0
    matches.push({
      file,
      line: source.slice(0, index).split('\n').length,
      value: (match[1] ?? '').trim(),
    })
  }
  return matches
}

function formatViolations(items: Declaration[]): string {
  return items.map((item) => `${item.file}:${item.line} (${item.value})`).join(', ')
}

function rootBlock(source: string, selector: RegExp): string {
  return source.match(selector)?.[1] ?? ''
}

function tokenValue(block: string, name: string): string {
  return block.match(new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]{6})`))?.[1] ?? ''
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  const [red = 0, green = 0, blue = 0] = channels
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = luminance(foreground)
  const backgroundLuminance = luminance(background)
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
}

describe('Renderer design system invariants', () => {
  it('loads product CSS only through design/index.css', () => {
    const cssImports = rendererSourceFiles.flatMap((file) => (
      [...readFileSync(file, 'utf8').matchAll(/\bimport\s+['"]([^'"]+\.css)['"]/g)]
        .map((match) => ({ file: relative(rendererDirectory, file), specifier: match[1] }))
    ))

    expect(mainSource).toContain("import './design/index.css'")
    expect(cssImports).toHaveLength(1)
    expect(cssImports[0]?.file).toBe('main.tsx')
    expect(cssImports[0]?.specifier).toBe('./design/index.css')
    expect([...indexCss.matchAll(/@import\s+['"]([^'"]+)['"]/g)].map((match) => match[1])).toEqual([
      './tokens.css',
      './base.css',
      './shell.css',
      './work.css',
      './pages.css',
      './overlays.css',
    ])
    expect(existsSync(join(rendererDirectory, 'styles.css'))).toBe(false)
  })

  it('defines required semantic colors for light and dark themes', () => {
    const lightTheme = rootBlock(tokensCss, /(?:^|\n):root\s*\{([\s\S]*?)\}/)
    const darkTheme = rootBlock(tokensCss, /:root\[data-theme=['"]dark['"]\]\s*\{([\s\S]*?)\}/)

    for (const token of ['--accent', '--text', '--surface']) {
      expect(lightTheme, `missing ${token} in light theme`).toMatch(new RegExp(`${token}\\s*:`))
      expect(darkTheme, `missing ${token} in dark theme`).toMatch(new RegExp(`${token}\\s*:`))
    }
  })

  it('keeps every text token at 4.5:1 against product surfaces', () => {
    const themes = [
      ['light', rootBlock(tokensCss, /(?:^|\n):root\s*\{([\s\S]*?)\}/)],
      ['dark', rootBlock(tokensCss, /:root\[data-theme=['"]dark['"]\]\s*\{([\s\S]*?)\}/)],
    ] as const

    for (const [theme, block] of themes) {
      for (const foregroundToken of ['--text', '--text-secondary', '--text-tertiary']) {
        for (const backgroundToken of ['--surface', '--surface-subtle', '--surface-muted']) {
          const foreground = tokenValue(block, foregroundToken)
          const background = tokenValue(block, backgroundToken)
          expect(foreground, `${theme} ${foregroundToken} must be a six-digit hex color`).not.toBe('')
          expect(background, `${theme} ${backgroundToken} must be a six-digit hex color`).not.toBe('')
          expect(
            contrastRatio(foreground, background),
            `${theme} ${foregroundToken} on ${backgroundToken}`,
          ).toBeGreaterThanOrEqual(4.5)
        }
      }
    }
  })

  it('keeps high-contrast and reduced-motion adaptations', () => {
    expect(tokensCss).toMatch(/@media\s*\(prefers-contrast:\s*more\)/)
    expect(baseCss).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/)
  })

  it('does not use explicit font sizes below 11px', () => {
    const fontSizes = productStyles.flatMap(([file, source]) => declarations(file, source, 'font-size'))
    const violations = fontSizes.filter(({ value }) => {
      if (/^var\(--[\w-]+\)$/.test(value)) return false
      const pixels = value.match(/^(\d+(?:\.\d+)?)px$/)?.[1]
      return pixels === undefined || Number(pixels) < 11
    })

    expect(violations, `font-size violations: ${formatViolations(violations)}`).toEqual([])
  })

  it('uses only semantic radius tokens', () => {
    const radii = productStyles.flatMap(([file, source]) => declarations(file, source, 'border-radius'))
    const violations = radii.filter(({ value }) => (
      !/^(?:var\(--radius-(?:control|surface|floating)\))(?:\s+var\(--radius-(?:control|surface|floating)\)){0,3}$/.test(value)
    ))

    expect(violations, `border-radius violations: ${formatViolations(violations)}`).toEqual([])
  })
})
