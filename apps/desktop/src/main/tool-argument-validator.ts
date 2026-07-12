type JsonSchema = Record<string, unknown>

export class InvalidToolArgumentsError extends Error {
  readonly code = 'INVALID_TOOL_ARGUMENTS'
  readonly issues: string[]

  constructor(toolId: string, issues: string[]) {
    super(`工具 ${toolId} 的参数无效：${issues.join('；')}`)
    this.name = 'InvalidToolArgumentsError'
    this.issues = issues
  }
}

function kindOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function validate(schema: JsonSchema, value: unknown, path: string, issues: string[]): void {
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    issues.push(`${path} 必须是 ${schema.enum.map(String).join('、')} 之一`)
    return
  }
  if ('const' in schema && !Object.is(schema.const, value)) {
    issues.push(`${path} 必须等于 ${String(schema.const)}`)
    return
  }

  if (Array.isArray(schema.anyOf)) {
    const valid = schema.anyOf.some((candidate) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false
      const branchIssues: string[] = []
      validate(candidate as JsonSchema, value, path, branchIssues)
      return branchIssues.length === 0
    })
    if (!valid) issues.push(`${path} 不符合任何允许的参数形式`)
    return
  }

  const expected = schema.type
  if (typeof expected === 'string') {
    const actual = kindOf(value)
    const matches = expected === 'integer'
      ? typeof value === 'number' && Number.isInteger(value)
      : expected === 'number'
        ? typeof value === 'number' && Number.isFinite(value)
        : actual === expected
    if (!matches) {
      issues.push(`${path} 应为 ${expected}，实际为 ${actual}`)
      return
    }
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) issues.push(`${path} 长度不能小于 ${schema.minLength}`)
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) issues.push(`${path} 长度不能大于 ${schema.maxLength}`)
    if (typeof schema.pattern === 'string') {
      try { if (!new RegExp(schema.pattern).test(value)) issues.push(`${path} 格式无效`) } catch { issues.push(`${path} 的 schema pattern 无效`) }
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) issues.push(`${path} 不能小于 ${schema.minimum}`)
    if (typeof schema.maximum === 'number' && value > schema.maximum) issues.push(`${path} 不能大于 ${schema.maximum}`)
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) issues.push(`${path} 至少需要 ${schema.minItems} 项`)
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) issues.push(`${path} 最多允许 ${schema.maxItems} 项`)
    if (schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
      value.forEach((item, index) => validate(schema.items as JsonSchema, item, `${path}[${index}]`, issues))
    }
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const objectValue = value as Record<string, unknown>
    const properties = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
      ? schema.properties as Record<string, unknown>
      : {}
    const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === 'string') : []
    for (const key of required) if (!(key in objectValue)) issues.push(`${path}.${key} 为必填项`)
    for (const [key, child] of Object.entries(objectValue)) {
      const childSchema = properties[key]
      if (childSchema && typeof childSchema === 'object' && !Array.isArray(childSchema)) {
        validate(childSchema as JsonSchema, child, `${path}.${key}`, issues)
      } else if (schema.additionalProperties === false) {
        issues.push(`${path}.${key} 不是允许的参数`)
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object' && !Array.isArray(schema.additionalProperties)) {
        validate(schema.additionalProperties as JsonSchema, child, `${path}.${key}`, issues)
      }
    }
  }
}

/** Validate model- or user-edited arguments at the broker trust boundary. */
export function assertToolArguments(toolId: string, schema: Record<string, unknown>, value: unknown): asserts value is Record<string, unknown> {
  const issues: string[] = []
  validate(schema, value, '$', issues)
  if (issues.length > 0) throw new InvalidToolArgumentsError(toolId, issues.slice(0, 20))
}
