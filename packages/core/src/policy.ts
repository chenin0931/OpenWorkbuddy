import type {
  ApprovalGrant,
  ApprovalRequest,
  JsonValue,
  PermissionMode,
  PolicyDecision,
  RiskLevel,
  ToolCall,
  ToolDescriptor,
} from '@onmyworkbuddy/contracts'

export interface RiskClassification {
  riskLevel: RiskLevel
  reason: string
  ruleId: string
  reversible: boolean
  idempotent: boolean
  sendsDataOffDevice: boolean
}

export interface PolicyEvaluationInput {
  call: ToolCall
  descriptor: ToolDescriptor
  grants?: ApprovalGrant[]
  now?: Date
  /** Set to false after the filesystem/path authorization layer rejects a target. */
  targetAuthorized?: boolean
}

const READONLY_FILE_ACTIONS = new Set(['read', 'list', 'search', 'glob', 'stat', 'exists', 'diff'])
const REVERSIBLE_FILE_ACTIONS = new Set(['write', 'edit', 'create', 'mkdir', 'copy', 'move', 'rename', 'restore'])
const READONLY_BROWSER_ACTIONS = new Set(['read', 'read_dom', 'screenshot', 'navigate', 'get_url', 'get_title', 'wait'])
const HIGH_RISK_ACTIONS = new Set(['delete', 'purchase', 'pay', 'publish', 'send', 'submit', 'transfer', 'erase'])
const EXTERNAL_ACTIONS = new Set(['upload', 'download', 'post', 'comment', 'input_sensitive', 'share'])

function asRecord(value: JsonValue): Record<string, JsonValue> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

function stringArgument(argumentsValue: JsonValue, ...keys: string[]): string | undefined {
  const record = asRecord(argumentsValue)
  if (!record) return undefined
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string') return value
  }
  return undefined
}

function normalizedAction(call: ToolCall): string {
  const explicit = stringArgument(call.arguments, 'action', 'operation', 'method')?.toLowerCase()
  if (explicit) return explicit
  const parts = call.toolName.toLowerCase().split(/[.:/_-]/).filter(Boolean)
  return parts.at(-1) ?? call.toolName.toLowerCase()
}

export function isSafeReadOnlyShellCommand(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed || /[;&|><`\n\r]|\$\(|\$\{|\*\*/.test(trimmed)) return false
  // Automatic execution is deliberately narrower than shell syntax. Commands
  // that need quoting, expansion or non-ASCII paths go through approval.
  if (!/^[A-Za-z0-9_./:@%+=,\-\s]+$/.test(trimmed)) return false

  const tokens = trimmed.split(/\s+/)
  if (
    tokens.some((token) => {
      const unquoted = token.replace(/^['"]/, '')
      return (
        unquoted.startsWith('/') ||
        unquoted.startsWith('~') ||
        /(?:^|\/)\.\.(?:\/|$)/.test(unquoted) ||
        token.includes('=/') ||
        token.includes('=~') ||
        token.includes('=..')
      )
    })
  ) {
    return false
  }
  const executable = tokens[0]
  if (executable === 'pwd' || executable === 'ls') return true
  if (executable === 'rg') return !tokens.some((token) => token === '--pre' || token.startsWith('--pre='))
  if (executable !== 'git') return false
  if (tokens.some((token) => {
    const lower = token.toLowerCase()
    return (
      lower === '-c' ||
      /^-c[^-]/.test(lower) ||
      lower === '-o' ||
      /^-o[^-]/.test(lower) ||
      lower === '--no-index' ||
      lower === '--ext-diff' ||
      lower === '--no-ext-diff' ||
      lower === '--textconv' ||
      lower === '--no-textconv' ||
      lower === '--config-env' ||
      lower.startsWith('--config-env=') ||
      lower === '--exec-path' ||
      lower.startsWith('--exec-path=') ||
      lower === '--output' ||
      lower.startsWith('--output=') ||
      lower === '--git-dir' ||
      lower.startsWith('--git-dir=') ||
      lower === '--work-tree' ||
      lower.startsWith('--work-tree=') ||
      lower === '--namespace' ||
      lower.startsWith('--namespace=')
    )
  })) {
    return false
  }
  const subcommand = tokens.find((token, index) => index > 0 && !token.startsWith('-'))
  return subcommand === 'status' || subcommand === 'diff' || subcommand === 'log'
}

/**
 * Shell approval must not become an alternate macOS app-control surface.
 *
 * This check intentionally runs before grant matching. It recognizes direct,
 * absolute-path, wrapper-based and nested-shell invocations of the standard
 * Apple Event / app-launching utilities. Chrome automation remains available
 * only through the explicitly tab-scoped Chrome bridge.
 */
export function isForbiddenMacAutomationCommand(command: string): boolean {
  // Collapse two common shell spelling tricks before inspecting command words.
  const inspected = command
    .normalize('NFKC')
    .replace(/\\([A-Za-z])/g, '$1')
    // Shell concatenates quoted and unquoted pieces in one command word, so
    // `osa'script'` and `o"pe"n` must be inspected as their executed names.
    .replace(/['"]/g, '')
    .toLowerCase()

  // These utilities are never valid shell targets for this product, even when
  // nested in `sh -c`, prefixed by `env`/`command`, or addressed absolutely.
  const forbiddenExecutable = /(?:^|[\s'"`;&|()])(?:[^\s'"`;&|()]*\/)?(?:automator|lsappinfo|osascript|osacompile|shortcuts)(?=$|[\s'"`;&|()])/
  if (forbiddenExecutable.test(inspected)) return true

  // `open` is macOS LaunchServices: every invocation may activate an app. Do
  // not limit this to -a/-b, because `open file` also launches a GUI handler.
  // Requiring a shell-command boundary avoids matching values such as
  // `git log --grep=open`.
  return /(?:^|[;&|()\n]\s*|\b(?:command|exec|nohup|env|xcrun)\s+)(?:[^\s;&|()]+\/)?open(?:\s|$)/.test(inspected)
    || /(?:^|[\s'"`])(?:\/[^\s'"`]+\/)?open\s+(?:-[abefnrtw]|--application|--bundle-identifier)(?:\s|=|$)/.test(inspected)
    || /\.app\/contents\/macos\//.test(inspected)
}

function classifyNetworkRead(call: ToolCall): RiskClassification {
  const rawUrl = stringArgument(call.arguments, 'url') ?? ''
  try {
    const url = new URL(rawUrl)
    if (url.username || url.password || url.search) {
      return {
        riskLevel: 'external_side_effect',
        reason: 'The URL contains credentials or query data that will be sent off-device.',
        ruleId: 'network.read-with-outgoing-data',
        reversible: true,
        idempotent: true,
        sendsDataOffDevice: true,
      }
    }
  } catch {
    return {
      riskLevel: 'external_side_effect',
      reason: 'The URL could not be verified as a plain public read target.',
      ruleId: 'network.unverified-url',
      reversible: true,
      idempotent: true,
      sendsDataOffDevice: true,
    }
  }
  return {
    riskLevel: 'readonly',
    reason: 'Operation retrieves a public URL without credentials or query data.',
    ruleId: 'network.readonly-fetch',
    reversible: true,
    idempotent: true,
    sendsDataOffDevice: true,
  }
}

function classifyNetworkSearch(): RiskClassification {
  return {
    riskLevel: 'external_side_effect',
    reason: 'The search query will be sent to an external search service.',
    ruleId: 'network.search-with-outgoing-query',
    reversible: true,
    idempotent: true,
    sendsDataOffDevice: true,
  }
}

function classifyShell(call: ToolCall): RiskClassification {
  const command = stringArgument(call.arguments, 'command', 'cmd') ?? ''
  const lower = command.toLowerCase()

  if (isSafeReadOnlyShellCommand(command)) {
    return {
      riskLevel: 'readonly',
      reason: 'Command is in the strict read-only shell allowlist.',
      ruleId: 'shell.readonly-allowlist',
      reversible: true,
      idempotent: true,
      sendsDataOffDevice: false,
    }
  }

  if (/\b(?:rm|rmdir|unlink|sudo|dd\s+if=|mkfs|diskutil\s+erase|shutdown|reboot)\b/.test(lower)) {
    return {
      riskLevel: 'high_risk_irreversible',
      reason: 'Command may irreversibly delete data or modify the operating system.',
      ruleId: 'shell.destructive',
      reversible: false,
      idempotent: false,
      sendsDataOffDevice: false,
    }
  }

  if (/\b(?:curl|wget|ssh|scp|rsync|git\s+push|npm\s+publish|pnpm\s+publish)\b/.test(lower)) {
    return {
      riskLevel: 'external_side_effect',
      reason: 'Command communicates with an external system or publishes data.',
      ruleId: 'shell.external',
      reversible: false,
      idempotent: false,
      sendsDataOffDevice: true,
    }
  }

  return {
    riskLevel: 'reversible_write',
    reason: 'Command is not proven read-only and may modify the workspace.',
    ruleId: 'shell.unknown-write',
    reversible: true,
    idempotent: false,
    sendsDataOffDevice: false,
  }
}

export function isValidationShellCommand(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed || /[;&|><`\n\r]|\$\(|\$\{/.test(trimmed) || isForbiddenMacAutomationCommand(trimmed)) return false
  return /^(?:(?:corepack\s+)?(?:pnpm|npm|yarn|bun)\s+(?:(?:run|exec)\s+)?(?:test|lint|typecheck|check|build)\b|(?:vitest|jest|pytest|eslint|xcodebuild|tsc\s+--noEmit|cargo\s+(?:test|check|build)|go\s+test|swift\s+test|git\s+diff\s+--check)\b)/i.test(trimmed)
}

/** Classifies a tool request without considering user grants. */
export function classifyToolRisk(call: ToolCall, descriptor: ToolDescriptor): RiskClassification {
  const name = call.toolName.toLowerCase()
  const action = normalizedAction(call)
  const annotations = descriptor.annotations

  if (annotations?.destructiveHint) {
    return {
      riskLevel: 'high_risk_irreversible',
      reason: 'The tool declares this operation destructive.',
      ruleId: 'annotation.destructive',
      reversible: false,
      idempotent: annotations.idempotentHint ?? false,
      sendsDataOffDevice: annotations.sendsDataOffDeviceHint ?? descriptor.source === 'mcp',
    }
  }

  if (name.includes('shell') || name === 'exec' || name.endsWith('.command')) return classifyShell(call)

  if (name === 'web.search') return classifyNetworkSearch()

  if (name === 'web.fetch' || name === 'web.read' || name === 'http.get') return classifyNetworkRead(call)

  if (
    name.startsWith('task.') ||
    name === 'memory.propose' ||
    name === 'agent.delegate' ||
    name === 'skill.read'
  ) {
    return {
      riskLevel: 'readonly',
      reason: 'Operation only updates ephemeral local task state.',
      ruleId: 'internal.ephemeral-state',
      reversible: true,
      idempotent: true,
      sendsDataOffDevice: false,
    }
  }

  if (descriptor.source === 'chrome' || name.startsWith('browser.') || name.startsWith('chrome.')) {
    if (READONLY_BROWSER_ACTIONS.has(action)) {
      return {
        riskLevel: 'readonly',
        reason: 'Browser action only observes or navigates an explicitly granted tab.',
        ruleId: 'browser.readonly',
        reversible: true,
        idempotent: true,
        sendsDataOffDevice: action === 'navigate',
      }
    }
    if (HIGH_RISK_ACTIONS.has(action)) {
      return {
        riskLevel: 'high_risk_irreversible',
        reason: 'Browser action can commit a transaction, send, publish, or delete data.',
        ruleId: 'browser.commit',
        reversible: false,
        idempotent: false,
        sendsDataOffDevice: true,
      }
    }
    return {
      riskLevel: 'external_side_effect',
      reason: EXTERNAL_ACTIONS.has(action)
        ? 'Browser action transfers or changes data outside the device.'
        : 'Browser interaction is not guaranteed to be observation-only.',
      ruleId: 'browser.interactive',
      reversible: false,
      idempotent: false,
      sendsDataOffDevice: true,
    }
  }

  if (name.includes('file') || name.startsWith('fs.') || descriptor.source === 'builtin') {
    if (READONLY_FILE_ACTIONS.has(action)) {
      return {
        riskLevel: 'readonly',
        reason: 'Filesystem operation is observation-only.',
        ruleId: 'filesystem.readonly',
        reversible: true,
        idempotent: true,
        sendsDataOffDevice: false,
      }
    }
    if (action === 'delete' || action === 'remove' || action === 'unlink') {
      return {
        riskLevel: 'high_risk_irreversible',
        reason: 'Filesystem deletion is not assumed recoverable.',
        ruleId: 'filesystem.delete',
        reversible: false,
        idempotent: false,
        sendsDataOffDevice: false,
      }
    }
    if (REVERSIBLE_FILE_ACTIONS.has(action)) {
      return {
        riskLevel: 'reversible_write',
        reason: 'Filesystem operation modifies local state and requires a snapshot.',
        ruleId: 'filesystem.write',
        reversible: true,
        idempotent: action === 'write' || action === 'mkdir',
        sendsDataOffDevice: false,
      }
    }
  }

  if (annotations?.readOnlyHint) {
    return {
      riskLevel: 'readonly',
      reason: 'Tool declares an observation-only operation.',
      ruleId: 'annotation.readonly',
      reversible: true,
      idempotent: annotations.idempotentHint ?? true,
      sendsDataOffDevice: annotations.sendsDataOffDeviceHint ?? false,
    }
  }

  if (annotations?.externalSideEffectHint || descriptor.source === 'mcp') {
    return {
      riskLevel: 'external_side_effect',
      reason: 'External tool is not declared read-only.',
      ruleId: 'external.default-side-effect',
      reversible: false,
      idempotent: annotations?.idempotentHint ?? false,
      sendsDataOffDevice: annotations?.sendsDataOffDeviceHint ?? true,
    }
  }

  return {
    riskLevel: 'reversible_write',
    reason: 'Unknown operation is conservatively treated as a local write.',
    ruleId: 'default.conservative-write',
    reversible: true,
    idempotent: annotations?.idempotentHint ?? false,
    sendsDataOffDevice: annotations?.sendsDataOffDeviceHint ?? false,
  }
}

function canonicalize(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key] as JsonValue)}`)
    .join(',')}}`
}

/** Stable index key; exact grant checks still compare canonical arguments. */
export function fingerprintArguments(value: JsonValue): string {
  const input = canonicalize(value)
  let hash = 0xcbf29ce484222325n
  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index))
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return `fnv1a64:${hash.toString(16).padStart(16, '0')}`
}

export function grantCovers(
  grant: ApprovalGrant,
  call: ToolCall,
  classification: RiskClassification,
  now = new Date(),
): boolean {
  if (grant.revokedAt || grant.toolName !== call.toolName) return false
  if (grant.expiresAt && Date.parse(grant.expiresAt) <= now.getTime()) return false
  if (grant.scope !== 'persistent_rule' && grant.runId !== call.runId) return false
  if (classification.riskLevel === 'high_risk_irreversible' && grant.scope !== 'once') return false

  const expected = canonicalize(call.arguments)
  if (grant.approvedArguments !== undefined && canonicalize(grant.approvedArguments) !== expected) return false
  if (grant.argumentFingerprint !== undefined && grant.argumentFingerprint !== fingerprintArguments(call.arguments)) return false

  // A once grant is bound to exact arguments; run/persistent grants may cover
  // future arguments only when explicitly stored without an argument binding.
  return grant.scope !== 'once' || grant.approvedArguments !== undefined || grant.argumentFingerprint !== undefined
}

export function evaluateToolPolicy(input: PolicyEvaluationInput): PolicyDecision {
  const classification = classifyToolRisk(input.call, input.descriptor)
  const toolName = input.call.toolName.toLowerCase()
  if ((toolName.includes('shell') || toolName === 'exec' || toolName.endsWith('.command'))
    && isForbiddenMacAutomationCommand(stringArgument(input.call.arguments, 'command', 'cmd') ?? '')) {
    return {
      effect: 'deny',
      riskLevel: 'high_risk_irreversible',
      reason: 'Shell-based macOS GUI and application automation is outside this product boundary.',
      ruleId: 'shell.macos-app-automation-denied',
      reversible: false,
      idempotent: false,
      sendsDataOffDevice: false,
    }
  }
  if (input.targetAuthorized === false) {
    return {
      effect: 'deny',
      riskLevel: classification.riskLevel,
      reason: 'Target is outside the authorized workspace roots.',
      ruleId: 'path.outside-authorized-roots',
      reversible: classification.reversible,
      idempotent: classification.idempotent,
      sendsDataOffDevice: classification.sendsDataOffDevice,
    }
  }

  if (classification.riskLevel === 'readonly') {
    return { effect: 'allow', ...classification }
  }

  const grant = input.grants?.find((candidate) => grantCovers(candidate, input.call, classification, input.now))
  if (grant) return { effect: 'allow', ...classification, matchedGrantId: grant.id }

  return { effect: 'require_approval', ...classification }
}

/**
 * Applies the user-selected convenience level after deterministic risk
 * classification. Denials, destructive actions and mutating external actions
 * are never relaxed; public search is the one explicit outbound-read exception.
 */
export function evaluateToolPolicyForMode(
  input: PolicyEvaluationInput,
  mode: PermissionMode,
): PolicyDecision {
  const decision = evaluateToolPolicy(input)
  if (decision.effect !== 'require_approval' || mode === 'cautious') return decision

  const command = stringArgument(input.call.arguments, 'command', 'cmd') ?? ''
  const balancedAutomatic = decision.ruleId === 'filesystem.write'
    || decision.ruleId === 'network.search-with-outgoing-query'
    || (decision.ruleId === 'shell.unknown-write' && isValidationShellCommand(command))

  if (balancedAutomatic) return { ...decision, effect: 'allow', ruleId: `${decision.ruleId}.permission-${mode}` }
  if (mode === 'autonomous' && decision.riskLevel === 'reversible_write' && !decision.sendsDataOffDevice) {
    return { ...decision, effect: 'allow', ruleId: `${decision.ruleId}.permission-autonomous` }
  }
  return decision
}

export interface ApprovalRequestInput {
  id: string
  call: ToolCall
  decision: PolicyDecision
  title?: string
  target?: string
  sendsData?: string[]
  now?: Date
  expiresAt?: Date
}

export function createApprovalRequest(input: ApprovalRequestInput): ApprovalRequest {
  const now = input.now ?? new Date()
  const request: ApprovalRequest = {
    id: input.id,
    runId: input.call.runId,
    toolCallId: input.call.id,
    toolName: input.call.toolName,
    riskLevel: input.decision.riskLevel,
    title: input.title ?? `Allow ${input.call.toolName}?`,
    reason: input.decision.reason,
    target: input.target ?? stringArgument(input.call.arguments, 'path', 'url', 'target', 'command') ?? input.call.toolName,
    arguments: input.call.arguments,
    sendsData: input.sendsData ?? [],
    reversible: input.decision.reversible,
    status: 'pending',
    createdAt: now.toISOString(),
  }
  if (input.expiresAt) request.expiresAt = input.expiresAt.toISOString()
  return request
}
