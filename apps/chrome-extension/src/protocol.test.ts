import { describe, expect, it } from 'vitest'
import { parseBridgeRequest, ProtocolError } from './protocol'

describe('Chrome bridge protocol', () => {
  it('accepts a known request and defaults params', () => {
    expect(parseBridgeRequest({ requestId: 'req-1', command: 'tabs.list' })).toEqual({
      requestId: 'req-1',
      command: 'tabs.list',
      params: {},
    })
  })

  it('rejects unknown commands', () => {
    expect(() => parseBridgeRequest({ requestId: 'req-1', command: 'cookies.export' })).toThrow(ProtocolError)
  })

  it('rejects non-object params', () => {
    expect(() => parseBridgeRequest({ requestId: 'req-1', command: 'bind', params: [] })).toThrow(
      'params must be an object',
    )
  })
})
