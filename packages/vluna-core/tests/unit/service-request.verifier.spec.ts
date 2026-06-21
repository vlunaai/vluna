import { describe, it, expect } from 'vitest'
import {
  buildCanonicalString,
  computeContentDigest,
  parseAuthorizationHeader,
  signServiceRequest,
  verifyServiceRequest,
  type MinimalIncomingRequest,
} from '../../src/security/service-request.verifier.js'

const SECRET = Buffer.from('super-secret')
const GOLDEN_DIGEST = 'sha-256=:QGLtr3UPuAdOfoPgyQKMlOMkaKi28WFHdDKO8EUVD5M=:'
const GOLDEN_SIG = 'ocEMbrstTPyyjUBiOnLr8oNM2Zj0vAhnyB/kc6bMkkc='
const baseHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'x-realm-id': 'realm1',
  'x-billing-account-id': 'ba1',
  'x-principal-id': 'principal1',
  'x-user-id': 'user1',
  'idempotency-key': 'idem-1',
}

function makeReq(body: object, opts?: Partial<MinimalIncomingRequest> & { ts?: string; nonce?: string; keyId?: string }) {
  const json = Buffer.from(JSON.stringify(body))
  const digest = computeContentDigest(json)
  const method = opts?.method ?? 'POST'
  const pathWithQuery = opts?.originalUrl ?? '/api/v1/resource?x=1'
  const ts = opts?.ts ?? '2025-01-01T00:00:00Z'
  const nonce = opts?.nonce ?? 'nonce-123'
  const keyId = opts?.keyId ?? 'svc-key'

  const sig = signServiceRequest({
    keyId,
    secret: SECRET,
    method,
    pathWithQuery,
    timestampISO: ts,
    nonce,
    contentDigest: digest,
    contentType: baseHeaders['content-type'],
    realmId: baseHeaders['x-realm-id'],
    billingAccountId: baseHeaders['x-billing-account-id'],
    principalId: baseHeaders['x-principal-id'],
    userId: baseHeaders['x-user-id'],
    idempotencyKey: baseHeaders['idempotency-key'],
  }) as string

  const headers = {
    ...baseHeaders,
    authorization: `SVC-AUTH keyId=${keyId},sig=${sig},ts=${ts},nonce=${nonce},alg=HMAC-SHA256`,
    'content-digest': digest,
  }

  const request: MinimalIncomingRequest = {
    method,
    originalUrl: pathWithQuery,
    headers,
    rawBody: json,
  }
  return { request, digest, sig, ts, nonce }
}

describe('service-request.verifier parseAuthorizationHeader', { tags: ['unit'] }, () => {
  it('parses valid header and rejects malformed', () => {
    const parsed = parseAuthorizationHeader('SVC-AUTH keyId=k,sig=s,ts=2025-01-01T00:00:00Z,nonce=n,alg=HMAC-SHA256')
    expect(parsed?.keyId).toBe('k')
    expect(parseAuthorizationHeader('Bearer token')).toBeNull()
  })
})

describe('service-request.verifier canonical + digest', { tags: ['unit'] }, () => {
  it('builds canonical string and content digest deterministically', () => {
    const digest = computeContentDigest(Buffer.from('hello'))
    expect(digest).toBe('sha-256=:LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=:')
    const canonical = buildCanonicalString({
      method: 'POST',
      pathWithQuery: '/p?q=1',
      timestampISO: '2025-01-01T00:00:00Z',
      nonce: 'n',
      contentDigest: digest,
      contentType: 'application/json',
      realmId: 'r',
      billingAccountId: 'b',
      principalId: 'p',
      userId: 'u',
      idempotencyKey: 'i',
    })
    expect(canonical.split('\n')).toHaveLength(12)
  })

  it('throws on unsupported algorithm', () => {
    expect(() =>
      buildCanonicalString({
        method: 'POST',
        pathWithQuery: '/p',
        timestampISO: 'ts',
        nonce: 'n',
        contentDigest: 'd',
        contentType: '',
        realmId: '',
        billingAccountId: '',
        principalId: '',
        userId: '',
        idempotencyKey: '',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        algorithm: 'HMAC-SHA1' as any,
      }),
    ).toThrow()
  })

  it('matches golden signature for known payload', () => {
    const body = Buffer.from(JSON.stringify({ ok: true }))
    const digest = computeContentDigest(body)
    expect(digest).toBe(GOLDEN_DIGEST)
    const canonical = buildCanonicalString({
      method: 'POST',
      pathWithQuery: '/api/v1/resource?x=1',
      timestampISO: '2025-01-01T00:00:00Z',
      nonce: 'nonce-123',
      contentDigest: digest,
      contentType: baseHeaders['content-type'],
      realmId: baseHeaders['x-realm-id'],
      billingAccountId: baseHeaders['x-billing-account-id'],
      principalId: baseHeaders['x-principal-id'],
      userId: baseHeaders['x-user-id'],
      idempotencyKey: baseHeaders['idempotency-key'],
    })
    const sig = signServiceRequest({
      keyId: 'svc-key',
      secret: SECRET,
      method: 'POST',
      pathWithQuery: '/api/v1/resource?x=1',
      timestampISO: '2025-01-01T00:00:00Z',
      nonce: 'nonce-123',
      contentDigest: digest,
      contentType: baseHeaders['content-type'],
      realmId: baseHeaders['x-realm-id'],
      billingAccountId: baseHeaders['x-billing-account-id'],
      principalId: baseHeaders['x-principal-id'],
      userId: baseHeaders['x-user-id'],
      idempotencyKey: baseHeaders['idempotency-key'],
    })
    expect(sig).toBe(GOLDEN_SIG)
    expect(canonical.split('\n')).toHaveLength(12)
  })
})

describe('service-request.verifier end-to-end verification', { tags: ['unit'] }, () => {
  it('accepts valid signed request', () => {
    const { request } = makeReq({ ok: true })
    const res = verifyServiceRequest({ request, secret: SECRET, expectedKeyId: 'svc-key' })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.verified.realmId).toBe('realm1')
      expect(res.verified.principalId).toBe('principal1')
      expect(res.verified.userId).toBe('user1')
      expect(res.canonical).toContain('content-digest')
    }
  })

  it('fails on signature mismatch', () => {
    const { request } = makeReq({ ok: true })
    const badSecret = Buffer.from('other')
    const res = verifyServiceRequest({ request, secret: badSecret, expectedKeyId: 'svc-key' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('signature_mismatch')
  })

  it('fails when content digest mismatches', () => {
    const { request } = makeReq({ ok: true })
    request.headers['content-digest'] = 'sha-256=:deadbeef:'
    const res = verifyServiceRequest({ request, secret: SECRET, expectedKeyId: 'svc-key' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('content_digest_mismatch')
  })

  it('fails when keyId mismatches', () => {
    const { request } = makeReq({ ok: true })
    const res = verifyServiceRequest({ request, secret: SECRET, expectedKeyId: 'other' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('key_mismatch')
  })

  it('fails when method missing', () => {
    const { request } = makeReq({ ok: true })
    request.method = undefined
    const res = verifyServiceRequest({ request, secret: SECRET, expectedKeyId: 'svc-key' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('missing_method')
  })
})
