import { describe, expect, it } from 'vitest'

import type { ApprovalGrant, ToolCall, ToolDescriptor } from '@onmyworkbuddy/contracts'

import {
  classifyToolRisk,
  evaluateToolPolicy,
  evaluateToolPolicyForMode,
  fingerprintArguments,
  isForbiddenMacAutomationCommand,
  isSafeReadOnlyShellCommand,
  isValidationShellCommand,
} from './policy'

const now = '2026-07-10T12:00:00.000Z'

function call(toolName: string, argumentsValue: ToolCall['arguments'], source: ToolCall['source'] = 'builtin'): ToolCall {
  return {
    id: 'call-1',
    runId: 'run-1',
    toolName,
    source,
    arguments: argumentsValue,
    status: 'requested',
    idempotent: false,
    createdAt: now,
    updatedAt: now,
  }
}

function descriptor(name: string, source: ToolDescriptor['source'] = 'builtin', annotations?: ToolDescriptor['annotations']): ToolDescriptor {
  return {
    name,
    title: name,
    description: '',
    source,
    inputSchema: { type: 'object' },
    ...(annotations ? { annotations } : {}),
  }
}

describe('risk policy', () => {
  it('allows only strict read-only shell commands', () => {
    expect(isSafeReadOnlyShellCommand('git diff -- src')).toBe(true)
    expect(isSafeReadOnlyShellCommand('rg TODO .')).toBe(true)
    expect(isSafeReadOnlyShellCommand('rg TODO . | sh')).toBe(false)
    expect(isSafeReadOnlyShellCommand('ls /etc')).toBe(false)
    expect(isSafeReadOnlyShellCommand('ls ./../../etc')).toBe(false)
    expect(isSafeReadOnlyShellCommand('git --git-dir=/tmp/repo status')).toBe(false)
    expect(isSafeReadOnlyShellCommand('git -c core.pager=cat status')).toBe(false)
    expect(isSafeReadOnlyShellCommand('git diff --output=change.patch')).toBe(false)
    expect(isSafeReadOnlyShellCommand('git diff -o change.patch')).toBe(false)
    expect(isSafeReadOnlyShellCommand('git diff --no-index a b')).toBe(false)
    expect(isSafeReadOnlyShellCommand('git diff --ext-diff')).toBe(false)
    expect(isSafeReadOnlyShellCommand('rg --pre touch TODO .')).toBe(false)
    expect(evaluateToolPolicy({ call: call('shell.exec', { command: 'git status' }), descriptor: descriptor('shell.exec') }).effect).toBe('allow')
  })

  it('requires approval when a web read sends query or userinfo data', () => {
    expect(evaluateToolPolicy({ call: call('web.fetch', { url: 'https://example.com/page' }), descriptor: descriptor('web.fetch') }).effect).toBe('allow')
    expect(evaluateToolPolicy({ call: call('web.fetch', { url: 'https://example.com/?secret=value' }), descriptor: descriptor('web.fetch') }).effect).toBe('require_approval')
    expect(evaluateToolPolicy({ call: call('web.fetch', { url: 'https://user:pass@example.com/' }), descriptor: descriptor('web.fetch') }).effect).toBe('require_approval')
  })

  it('requires approval before sending a search query off-device', () => {
    expect(
      classifyToolRisk(call('web.search', { query: 'OpenWorkbuddy' }), descriptor('web.search')),
    ).toMatchObject({
      riskLevel: 'external_side_effect',
      ruleId: 'network.search-with-outgoing-query',
      reversible: true,
      idempotent: true,
      sendsDataOffDevice: true,
    })
    expect(evaluateToolPolicy({ call: call('web.search', { query: 'OpenWorkbuddy' }), descriptor: descriptor('web.search') }).effect).toBe('require_approval')
  })

  it('applies the selected permission mode without relaxing external or destructive actions', () => {
    const fileWrite = { call: call('file.write', { path: 'notes.md', content: 'x' }), descriptor: descriptor('file.write') }
    const search = { call: call('web.search', { query: 'public release notes' }), descriptor: descriptor('web.search') }
    const validation = { call: call('shell.command', { command: 'pnpm test' }), descriptor: descriptor('shell.command') }
    const localCommand = { call: call('shell.command', { command: 'node scripts/generate.mjs' }), descriptor: descriptor('shell.command') }
    const external = { call: call('shell.command', { command: 'git push origin main' }), descriptor: descriptor('shell.command') }
    const destructive = { call: call('shell.command', { command: 'rm report.md' }), descriptor: descriptor('shell.command') }

    expect(evaluateToolPolicyForMode(fileWrite, 'cautious').effect).toBe('require_approval')
    expect(evaluateToolPolicyForMode(fileWrite, 'balanced').effect).toBe('allow')
    expect(evaluateToolPolicyForMode(search, 'balanced').effect).toBe('allow')
    expect(evaluateToolPolicyForMode(validation, 'balanced').effect).toBe('allow')
    expect(evaluateToolPolicyForMode(localCommand, 'balanced').effect).toBe('require_approval')
    expect(evaluateToolPolicyForMode(localCommand, 'autonomous').effect).toBe('allow')
    expect(evaluateToolPolicyForMode(external, 'autonomous').effect).toBe('require_approval')
    expect(evaluateToolPolicyForMode(destructive, 'autonomous')).toMatchObject({ effect: 'require_approval', riskLevel: 'high_risk_irreversible' })
  })

  it('recognizes only single validation commands for balanced automatic execution', () => {
    expect(isValidationShellCommand('corepack pnpm typecheck')).toBe(true)
    expect(isValidationShellCommand('cargo test --locked')).toBe(true)
    expect(isValidationShellCommand('pnpm test && curl https://example.com')).toBe(false)
    expect(isValidationShellCommand('node scripts/test-data.mjs')).toBe(false)
  })

  it.each([
    'osascript -e \'tell application "Finder" to activate\'',
    '/usr/bin/OSASCRIPT -l JavaScript -e \'Application("Finder").activate()\'',
    'command osacompile -o payload.scpt payload.applescript',
    'o\'sa\'script -e \'tell application "Finder" to activate\'',
    'env shortcuts run "Daily workflow"',
    '/usr/bin/automator workflow.workflow',
    'sh -c \'open -a Finder\'',
    'open --bundle-identifier com.apple.TextEdit',
    '/usr/bin/open README.md',
    'o"pe"n -a Finder',
    '/Applications/Calculator.app/Contents/MacOS/Calculator',
  ])('deterministically denies macOS app automation through Shell: %s', (command) => {
    expect(isForbiddenMacAutomationCommand(command)).toBe(true)
    const toolCall = call('shell.exec', { command })
    const broadGrant: ApprovalGrant = {
      id: 'grant-macos-automation',
      runId: toolCall.runId,
      toolName: toolCall.toolName,
      scope: 'run_tool',
      createdAt: now,
    }
    expect(evaluateToolPolicy({ call: toolCall, descriptor: descriptor('shell.exec'), grants: [broadGrant] })).toMatchObject({
      effect: 'deny',
      ruleId: 'shell.macos-app-automation-denied',
    })
  })

  it('does not confuse ordinary text containing open with a LaunchServices command', () => {
    expect(isForbiddenMacAutomationCommand('git log --grep=open')).toBe(false)
    expect(isForbiddenMacAutomationCommand('rg open README.md')).toBe(false)
  })

  it('requires exact approval for destructive operations', () => {
    const toolCall = call('filesystem.delete', { action: 'delete', path: '/workspace/a' })
    const result = evaluateToolPolicy({ call: toolCall, descriptor: descriptor('filesystem.delete') })
    expect(result).toMatchObject({ effect: 'require_approval', riskLevel: 'high_risk_irreversible' })

    const broadGrant: ApprovalGrant = {
      id: 'grant',
      runId: 'run-1',
      toolName: toolCall.toolName,
      scope: 'run_tool',
      createdAt: now,
    }
    expect(evaluateToolPolicy({ call: toolCall, descriptor: descriptor('filesystem.delete'), grants: [broadGrant] }).effect).toBe('require_approval')
  })

  it('honors an exact one-shot grant but denies an unauthorized target', () => {
    const toolCall = call('filesystem.write', { action: 'write', path: '/workspace/a', content: 'x' })
    const grant: ApprovalGrant = {
      id: 'grant',
      runId: 'run-1',
      toolName: toolCall.toolName,
      scope: 'once',
      approvedArguments: toolCall.arguments,
      argumentFingerprint: fingerprintArguments(toolCall.arguments),
      createdAt: now,
    }
    expect(evaluateToolPolicy({ call: toolCall, descriptor: descriptor('filesystem.write'), grants: [grant] }).effect).toBe('allow')
    expect(evaluateToolPolicy({ call: toolCall, descriptor: descriptor('filesystem.write'), grants: [grant], targetAuthorized: false }).effect).toBe('deny')
  })

  it('treats browser submission as high risk and read-only MCP hints as read-only', () => {
    expect(classifyToolRisk(call('chrome.act', { action: 'submit' }, 'chrome'), descriptor('chrome.act', 'chrome')).riskLevel).toBe('high_risk_irreversible')
    expect(
      classifyToolRisk(call('search', { query: 'x' }, 'mcp'), descriptor('search', 'mcp', { readOnlyHint: true })).riskLevel,
    ).toBe('readonly')
  })
})
