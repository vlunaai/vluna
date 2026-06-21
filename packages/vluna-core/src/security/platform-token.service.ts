import { Inject, Injectable } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { SignJWT, decodeProtectedHeader, jwtVerify } from 'jose'
import type { TokenClaims } from '../auth/tokens/token.types.js'
import { ServiceApiKeyService } from './service-api-key.service.js'
import type { TokenVerifyOptions } from '../auth/tokens/token.types.js'

export interface IssuePlatformTokenParams {
  realmId: string
  principalId: string
  userId: string
  billingAccountId: string
  billingUserId: string
  ttlSeconds: number
  platformScopes: string[]
  billingScopes: string[]
  audience?: string
  nonce?: string
  traits?: Record<string, unknown>
  issuedByServiceKeyId?: string
}

export interface PlatformTokenIssueResult {
  accessToken: string
  expiresAt: Date
  expiresIn: number
  claims: PlatformTokenClaims
}

export interface PlatformTokenClaims extends TokenClaims {
  realm_id: string
  billing_account_id: string
  billing_user_id: string
  billing_principal_id: string
  business_user_id: string
  plt_scopes: string[]
  plt_traits?: Record<string, unknown>
  tu: 'plt'
  token_use?: 'platform'
  tv: number
  ib?: string
  nonce?: string
}

type PlatformTokenPayload = Pick<PlatformTokenClaims,
  'scope' |
  'realm_id' |
  'billing_account_id' |
  'billing_user_id' |
  'billing_principal_id' |
  'business_user_id' |
  'plt_scopes' |
  'tu' |
  'token_use' |
  'tv' |
  'plt_traits' |
  'ib' |
  'nonce'
>

export class PlatformTokenError extends Error {
  constructor(public code: 'NOT_PLATFORM_TOKEN' | 'INVALID_PLATFORM_TOKEN', message: string, public status = 401) {
    super(message)
    this.name = 'PlatformTokenError'
  }
}

@Injectable()
export class PlatformTokenService {
  private readonly defaultAudience =
    (process.env.VLUNA_PLATFORM_TOKEN_AUDIENCE || '').trim() || 'oss.vluna.ai'
  private readonly issuerBase = (process.env.VLUNA_PLATFORM_TOKEN_ISSUER || process.env.VLUNA_PUBLIC_URL || 'https://api.vluna.ai').replace(/\/$/, '')

  constructor(@Inject(ServiceApiKeyService) private readonly serviceApiKeyService: ServiceApiKeyService) {}

  async issue(params: IssuePlatformTokenParams): Promise<PlatformTokenIssueResult> {
    const secretEntry = this.serviceApiKeyService.getPlatformTokenSecret(params.realmId)
    const ttl = this.clampTtl(params.ttlSeconds)
    const issuedAt = Math.floor(Date.now() / 1000)
    const exp = issuedAt + ttl
    const jti = randomUUID()
    const audience = (params.audience || this.defaultAudience).trim() || this.defaultAudience

    const platformScopes = Array.from(new Set(params.platformScopes.filter(Boolean)))
    const billingScopeText = this.buildBillingScopeClaim(params.billingScopes)
    const traits = this.sanitizeTraits(params.traits)

    const payload: PlatformTokenPayload = {
      scope: billingScopeText,
      realm_id: params.realmId,
      billing_account_id: params.billingAccountId,
      billing_user_id: params.billingUserId,
      billing_principal_id: params.principalId,
      business_user_id: params.userId,
      plt_scopes: platformScopes,
      tu: 'plt',
      token_use: 'platform',
      tv: secretEntry.version,
    }
    if (traits) payload.plt_traits = traits
    if (params.nonce) payload.nonce = params.nonce
    if (params.issuedByServiceKeyId) payload.ib = params.issuedByServiceKeyId

    const issuer = this.buildIssuer(params.realmId)
    const subject = this.buildSubject(params)

    const signer = new SignJWT(payload)
      .setProtectedHeader({ alg: 'HS256', kid: secretEntry.keyId, typ: 'JWT' })
      .setIssuedAt(issuedAt)
      .setExpirationTime(exp)
      .setAudience(audience)
      .setIssuer(issuer)
      .setSubject(subject)
      .setJti(jti)

    const accessToken = await signer.sign(secretEntry.secret)
    const claims: PlatformTokenClaims = {
      ...payload,
      aud: audience,
      iss: issuer,
      sub: subject,
      exp,
      iat: issuedAt,
      jti,
    }
    return {
      accessToken,
      expiresAt: new Date(exp * 1000),
      expiresIn: ttl,
      claims,
    }
  }

  async verify(token: string, _options?: TokenVerifyOptions): Promise<PlatformTokenClaims> {
    const header = this.safeDecodeHeader(token)
    const realmInfo = this.parseRealmFromKid(header?.kid)
    if (!realmInfo) {
      throw new PlatformTokenError('NOT_PLATFORM_TOKEN', 'token kid not recognized as platform token', 401)
    }
    const secretEntry = this.serviceApiKeyService.getPlatformTokenSecret(realmInfo.realmId, {
      flavor: realmInfo.flavor,
      version: realmInfo.version,
    })
    const issuer = this.buildIssuer(realmInfo.realmId)
    try {
      const verified = await jwtVerify(token, secretEntry.secret, {
        issuer,
        audience: _options?.audience || this.defaultAudience,
        algorithms: ['HS256'],
      })
      const payload = verified.payload as PlatformTokenClaims
      const tokenUse = (payload as TokenClaims)?.tu || (payload as TokenClaims)?.token_use
      const normalizedUse = typeof tokenUse === 'string' ? tokenUse.toLowerCase() : undefined
      if (normalizedUse !== 'plt' && normalizedUse !== 'platform') {
        throw new PlatformTokenError('NOT_PLATFORM_TOKEN', 'token_use mismatch', 401)
      }
      return payload
    } catch (err) {
      if (err instanceof PlatformTokenError) throw err
      throw new PlatformTokenError('INVALID_PLATFORM_TOKEN', (err as Error)?.message || 'invalid platform token', 401)
    }
  }

  private safeDecodeHeader(token: string) {
    try {
      return decodeProtectedHeader(token)
    } catch {
      return null
    }
  }

  private parseRealmFromKid(kid?: string): { realmId: string; version: number; flavor: 'plt' | 'apt' } | null {
    if (!kid || typeof kid !== 'string') return null
    const match = kid.match(/^(plt|apt):v(\d+):realm:(.+)$/)
    if (!match) return null
    const flavor = match[1].toLowerCase() === 'apt' ? 'apt' : 'plt'
    return { realmId: match[3], version: Number(match[2]), flavor }
  }

  private buildIssuer(realmId: string): string {
    if (!this.issuerBase) return `urn:vluna:realm:${realmId}`
    return `${this.issuerBase}/realms/${realmId}`
  }

  private buildSubject(params: IssuePlatformTokenParams): string {
    return params.userId
  }

  private clampTtl(value: number): number {
    const min = 60
    const max = 3600
    const incoming = Number.isFinite(value) ? Math.floor(value) : NaN
    if (!Number.isFinite(incoming) || incoming <= 0) return 900
    return Math.min(Math.max(incoming, min), max)
  }

  private buildBillingScopeClaim(scopes: string[]): string {
    const set = new Set(scopes.filter(Boolean))
    if (!set.size) set.add('billing:read')
    return Array.from(set).join(' ')
  }

  private sanitizeTraits(input?: Record<string, unknown>): Record<string, unknown> | undefined {
    if (!input || typeof input !== 'object') return undefined
    const out: Record<string, unknown> = {}
    const entries = Object.entries(input).slice(0, 20)
    for (const [key, value] of entries) {
      if (typeof key !== 'string' || key.length === 0) continue
      if (value === undefined) continue
      if (typeof value === 'function') continue
      out[key] = value
    }
    return Object.keys(out).length ? out : undefined
  }
}
