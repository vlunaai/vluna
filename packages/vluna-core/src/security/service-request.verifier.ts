import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

export type ServiceSignatureAlgorithm = 'HMAC-SHA256'

export interface SignParams {
  keyId: string
  secret: Buffer | string
  method: string
  pathWithQuery: string
  timestampISO: string
  nonce: string
  contentDigest: string
  contentType: string
  realmId: string
  principalId: string
  userId: string
  billingAccountId?: string
  billingUserId?: string
  idempotencyKey: string
  algorithm?: ServiceSignatureAlgorithm
  output?: 'base64' | 'buffer'
}

export interface ParsedAuthHeader {
  keyId: string
  signature: string
  timestampISO: string
  nonce: string
  algorithm: ServiceSignatureAlgorithm
}

export interface MinimalIncomingRequest {
  method?: string
  originalUrl?: string
  url?: string
  headers: Record<string, string | string[] | undefined>
  rawBody?: Buffer | string | null
}

export type VerifyFailureCode =
  | 'missing_method'
  | 'missing_url'
  | 'missing_authorization'
  | 'bad_authorization'
  | 'key_mismatch'
  | 'missing_content_digest'
  | 'content_digest_mismatch'
  | 'signature_mismatch'

export type VerifyServiceRequestResult =
  | { ok: true; parsed: ParsedAuthHeader; canonical: string, verified: { realmId?: string; billingAccountId?: string; billingUserId?: string; principalId?: string; userId?: string } }
  | {
      ok: false
      code: VerifyFailureCode
      message: string
      parsed?: ParsedAuthHeader
      expectedSignature?: string,
    }

export function parseAuthorizationHeader(header: string): ParsedAuthHeader | null {
  const match = header.match(/\s*SVC-AUTH\s+keyId=([^,]+),sig=([^,]+),ts=([^,]+),nonce=([^,]+),alg=(HMAC-SHA256)\s*/)
  if (!match) {
    return null
  }
  return {
    keyId: match[1],
    signature: match[2],
    timestampISO: match[3],
    nonce: match[4],
    algorithm: match[5] as ServiceSignatureAlgorithm,
  }
}

export function verifyServiceRequest(params: {
  request: MinimalIncomingRequest
  secret: Buffer | string
  expectedKeyId: string
}): VerifyServiceRequestResult {
  const method = params.request.method?.toUpperCase()
  if (!method) {
    return { ok: false, code: 'missing_method', message: 'HTTP method missing' }
  }

  const pathWithQuery = params.request.originalUrl && params.request.originalUrl.length > 0
    ? params.request.originalUrl
    : params.request.url || ''
  if (!pathWithQuery) {
    return { ok: false, code: 'missing_url', message: 'Request URL missing' }
  }

  const authorization = getHeader(params.request.headers, 'authorization')
  if (!authorization) {
    return { ok: false, code: 'missing_authorization', message: 'Authorization header missing' }
  }

  const parsed = parseAuthorizationHeader(authorization)
  if (!parsed) {
    return { ok: false, code: 'bad_authorization', message: 'Authorization header malformed' }
  }
  if (parsed.keyId !== params.expectedKeyId) {
    return { ok: false, code: 'key_mismatch', message: 'Authorization keyId does not match expected', parsed }
  }

  const contentDigestHeader = getHeader(params.request.headers, 'content-digest')
  if (!contentDigestHeader) {
    return { ok: false, code: 'missing_content_digest', message: 'Content-Digest header missing', parsed }
  }

  const bodyBuffer = normalizeBody(params.request.rawBody)
  const computedDigest = computeContentDigest(bodyBuffer)
  if (!timingSafeEqualStr(contentDigestHeader, computedDigest)) {
    return { ok: false, code: 'content_digest_mismatch', message: 'Content-Digest mismatch', parsed }
  }
  const contentType = getHeader(params.request.headers, 'content-type') || ''
  const realmId = getHeader(params.request.headers, 'x-realm-id') || ''
  const billingAccountId = getHeader(params.request.headers, 'x-billing-account-id') || ''
  const billingUserId = getHeader(params.request.headers, 'x-billing-user-id') || ''
  const principalId = getHeader(params.request.headers, 'x-principal-id') || ''
  const userId = getHeader(params.request.headers, 'x-user-id') || ''
  const idempotencyKey = getHeader(params.request.headers, 'idempotency-key') || ''

  const canonical = buildCanonicalString({
    method,
    pathWithQuery,
    timestampISO: parsed.timestampISO,
    nonce: parsed.nonce,
    contentDigest: contentDigestHeader,
    contentType: contentType || '',
    realmId: realmId || '',
    billingAccountId: billingAccountId || '',
    billingUserId: billingUserId || '',
    principalId: principalId || '',
    userId: userId || '',
    idempotencyKey: idempotencyKey || '',
    algorithm: parsed.algorithm,
  })

  const expectedSignature = signServiceRequest({
    keyId: parsed.keyId,
    secret: params.secret,
    method,
    pathWithQuery,
    timestampISO: parsed.timestampISO,
    nonce: parsed.nonce,
    contentDigest: contentDigestHeader,
    contentType: contentType || '',
    realmId: realmId || '',
    billingAccountId: billingAccountId || '',
    billingUserId: billingUserId || '',
    principalId: principalId || '',
    userId: userId || '',
    idempotencyKey: idempotencyKey || '',
    algorithm: parsed.algorithm,
    output: 'base64',
  })

  const signatureMatches = typeof expectedSignature === 'string'
    ? timingSafeEqualStr(parsed.signature, expectedSignature)
    : timingSafeEqual(Buffer.from(parsed.signature, 'base64'), expectedSignature)

  if (!signatureMatches) {
    return {
      ok: false,
      code: 'signature_mismatch',
      message: 'Signature mismatch',
      parsed,
      expectedSignature: typeof expectedSignature === 'string' ? expectedSignature : expectedSignature.toString('base64'),
    }
  }

  return {
    ok: true,
    parsed,
    canonical,
    verified: {
      realmId: realmId?.trim(),
      billingAccountId: billingAccountId?.trim(),
      billingUserId: billingUserId?.trim(),
      principalId: principalId?.trim(),
      userId: userId?.trim(),
    },
  }
}

export function signServiceRequest(params: SignParams): string | Buffer {
  const canonical = buildCanonicalString(params)
  const mac = createHmac('sha256', params.secret).update(canonical)
  const output = params.output ?? 'base64'
  return output === 'buffer' ? mac.digest() : mac.digest(output)
}

export function computeContentDigest(body: Buffer): string {
  const digest = createHash('sha256').update(body).digest('base64')
  return `sha-256=:${digest}:`
}

export function buildCanonicalString(params: {
  method: string
  pathWithQuery: string
  timestampISO: string
  nonce: string
  contentDigest: string
  contentType: string
  realmId: string
  billingAccountId?: string
  billingUserId?: string
  principalId: string
  userId: string
  idempotencyKey: string
  algorithm?: ServiceSignatureAlgorithm
}): string {
  const algorithm = params.algorithm ?? 'HMAC-SHA256'
  if (algorithm !== 'HMAC-SHA256') {
    throw new Error(`Unsupported algorithm: ${algorithm}`)
  }
  return [
    params.method.toUpperCase(),
    params.pathWithQuery,
    `ts:${params.timestampISO}`,
    `nonce:${params.nonce}`,
    `content-digest:${params.contentDigest}`,
    `content-type:${params.contentType}`,
    `x-realm-id:${params.realmId}`,
    `x-principal-id:${params.principalId}`,
    `x-user-id:${params.userId}`,
    `x-billing-account-id:${params.billingAccountId ?? ''}`,
    `x-billing-user-id:${params.billingUserId ?? ''}`,
    `idempotency-key:${params.idempotencyKey}`,
  ].join('\n')
}

function getHeader(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name.toLowerCase()] ?? headers[name]
  if (typeof value === 'string') {
    return value
  }
  if (Array.isArray(value)) {
    return value.join(',')
  }
  return undefined
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const A = Buffer.from(a)
  const B = Buffer.from(b)
  return A.length === B.length && timingSafeEqual(A, B)
}

function normalizeBody(body: Buffer | string | null | undefined): Buffer {
  if (Buffer.isBuffer(body)) {
    return body
  }
  if (typeof body === 'string') {
    return Buffer.from(body, 'utf8')
  }
  return Buffer.alloc(0)
}
