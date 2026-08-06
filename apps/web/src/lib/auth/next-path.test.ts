import { describe, expect, it } from 'vitest'
import { DEFAULT_POST_AUTH_PATH, sanitizeNextPath } from './next-path'

// `?next=` reaches sanitizeNextPath straight from the OAuth callback's
// query string, so every case here is attacker-supplied input.
describe('sanitizeNextPath', () => {
  it('keeps an ordinary relative path', () => {
    expect(sanitizeNextPath('/welcome')).toBe('/welcome')
  })

  it('keeps a path with a query string and hash', () => {
    expect(sanitizeNextPath('/join/abc?ref=1#top')).toBe('/join/abc?ref=1#top')
  })

  it.each([null, undefined, ''])('falls back when next is %s', (value) => {
    expect(sanitizeNextPath(value)).toBe(DEFAULT_POST_AUTH_PATH)
  })

  it('rejects an absolute URL', () => {
    expect(sanitizeNextPath('https://evil.example/steal')).toBe(
      DEFAULT_POST_AUTH_PATH,
    )
  })

  it('rejects a protocol-relative URL', () => {
    // The case a plain startsWith('/') check lets through.
    expect(sanitizeNextPath('//evil.example')).toBe(DEFAULT_POST_AUTH_PATH)
  })

  it('rejects the backslash variant browsers normalise to //', () => {
    expect(sanitizeNextPath('/\\evil.example')).toBe(DEFAULT_POST_AUTH_PATH)
  })

  it('rejects a bare hostname', () => {
    expect(sanitizeNextPath('evil.example')).toBe(DEFAULT_POST_AUTH_PATH)
  })

  it('honours a caller-supplied fallback', () => {
    expect(sanitizeNextPath('//evil.example', '/welcome')).toBe('/welcome')
  })
})
