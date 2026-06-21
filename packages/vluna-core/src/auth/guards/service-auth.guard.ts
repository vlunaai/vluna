import { CanActivate, ExecutionContext, HttpException, Inject, Injectable } from '@nestjs/common'
import { ServiceApiKeyService } from '../../security/service-api-key.service.js'
import { parseAuthorizationHeader, verifyServiceRequest } from '../../security/service-request.verifier.js'
import type { DerivedServiceApiKey } from '../../security/service-api-key.helpers.js'
import type { AppRequest } from '../../types/app-request.js'
import { detectAuthScheme } from '../utils/auth-scheme.js'

@Injectable()
export class ServiceAuthGuard implements CanActivate {
  constructor(@Inject(ServiceApiKeyService) private readonly serviceApiKeyService: ServiceApiKeyService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AppRequest>()
    if (!req) {
      throw new HttpException({ code: 'AUTH.INVALID_REQUEST', message: 'request unavailable' }, 500)
    }

    const scheme = req.ctx?.authScheme ?? detectAuthScheme(req.headers?.authorization as string | undefined)
    if (scheme !== 'service') {
      return true
    }

    const extendedReq = req as AppRequestWithRaw

    const headers = (req.headers || {}) as Record<string, string | string[] | undefined>
    const authHeaderRaw = this.getHeader(headers, 'authorization')
    if (!authHeaderRaw) {
      throw new HttpException({ code: 'AUTH.MISSING_SERVICE_SIGNATURE', message: 'Authorization header missing' }, 401)
    }
    req.ctx = req.ctx || {}
    req.ctx.authScheme = 'service'

    const parsedAuth = parseAuthorizationHeader(authHeaderRaw)
    if (!parsedAuth) {
      throw new HttpException({ code: 'AUTH.INVALID_SERVICE_SIGNATURE', message: 'Authorization header malformed' }, 401)
    }

    const apiKey = await this.resolveApiKey(parsedAuth.keyId)
    this.validateKeyConstraints(apiKey, headers)

    const verificationResult = verifyServiceRequest({
      request: {
        method: req.method,
        originalUrl: extendedReq.originalUrl ?? extendedReq.raw?.originalUrl ?? extendedReq.url,
        url: extendedReq.url,
        headers,
        rawBody: normalizeRawBody(extendedReq.rawBody ?? extendedReq.raw?.body),
      },
      secret: apiKey.secret,
      expectedKeyId: apiKey.keyId,
    })

    if (!verificationResult.ok) {
      const message = verificationResult.message || 'service signature verification failed'
      throw new HttpException({ code: 'AUTH.INVALID_SERVICE_SIGNATURE', message }, 401)
    }

    req.ctx.serviceApiKey = {
      keyId: apiKey.keyId,
      envTag: apiKey.envTag,
      status: apiKey.status,
      scopes: apiKey.scopes,
      allowedRealms: apiKey.allowedRealms,
      allowedAccounts: apiKey.allowedAccounts,
      signature: {
        timestampISO: verificationResult.parsed.timestampISO,
        nonce: verificationResult.parsed.nonce,
        algorithm: verificationResult.parsed.algorithm,
      },
      canonicalRequest: verificationResult.canonical,
    }

    const realmId = (verificationResult.verified.realmId || this.getHeader(headers, 'x-realm-id') || '').trim()
    if (!realmId) {
      throw new HttpException({ code: 'AUTH.MISSING_REALM', message: 'realm_id missing in request' }, 400)
    }
    if (apiKey.allowedRealms.length > 0 && !apiKey.allowedRealms.includes(realmId)) {
      throw new HttpException({ code: 'AUTH.UNAUTHORIZED_REALM', message: 'realm_id not allowed in this api key' }, 400)
    }

    const principalId = (verificationResult.verified.principalId || this.getHeader(headers, 'x-principal-id') || '').trim()
    const userId = (verificationResult.verified.userId || this.getHeader(headers, 'x-user-id') || '').trim()
    const billingAccountId = (verificationResult.verified.billingAccountId || this.getHeader(headers, 'x-billing-account-id') || '').trim()
    const billingUserId = (verificationResult.verified.billingUserId || this.getHeader(headers, 'x-billing-user-id') || '').trim()

    req.ctx.realmId = realmId
    req.ctx.serviceAuthBinding = {
      principalId: principalId || undefined,
      userId: userId || undefined,
      billingAccountId: billingAccountId || undefined,
      billingUserId: billingUserId || undefined,
    }
    req.ctx.isRealmAdmin = this.getHeader(headers, 'x-realm-admin')?.trim().toLowerCase() === 'true'

    return true
  }

  private async resolveApiKey(keyId: string): Promise<DerivedServiceApiKey> {
    let key = this.serviceApiKeyService.getKey(keyId)
    if (key) return key
    try {
      await this.serviceApiKeyService.loadSecrets()
    } catch {
      throw new HttpException({ code: 'AUTH.SERVICE_KEY_LOAD_FAILED', message: 'Failed to refresh service API keys' }, 500)
    }
    key = this.serviceApiKeyService.getKey(keyId)
    if (!key) {
      throw new HttpException({ code: 'AUTH.SERVICE_KEY_NOT_FOUND', message: 'Service API key not recognized' }, 401)
    }
    return key
  }

  private validateKeyConstraints(key: DerivedServiceApiKey, headers: Record<string, string | string[] | undefined>): void {
    if (key.status !== 'active') {
      throw new HttpException({ code: 'AUTH.SERVICE_KEY_DISABLED', message: 'Service API key is not active' }, 403)
    }

    const now = Date.now()
    if (key.expiresAt && key.expiresAt.getTime() <= now) {
      throw new HttpException({ code: 'AUTH.SERVICE_KEY_EXPIRED', message: 'Service API key has expired' }, 403)
    }

    const realmId = this.getHeader(headers, 'x-realm-id')
    if (key.allowedRealms.length > 0 && (!realmId || !key.allowedRealms.includes(realmId))) {
      throw new HttpException({ code: 'AUTH.SERVICE_KEY_REALM_FORBIDDEN', message: 'Service API key not authorized for realm' }, 403)
    }

    const accountId = this.getHeader(headers, 'x-billing-account-id')
    if (key.allowedAccounts.length > 0 && accountId && !key.allowedAccounts.includes(accountId)) {
      throw new HttpException({ code: 'AUTH.SERVICE_KEY_ACCOUNT_FORBIDDEN', message: 'Service API key not authorized for billing account' }, 403)
    }
  }

  private getHeader(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
    const value = headers[name.toLowerCase()] ?? headers[name]
    if (typeof value === 'string') return value
    if (Array.isArray(value)) return value.join(',')
    return undefined
  }
}

type AppRequestWithRaw = AppRequest & {
  originalUrl?: string
  raw?: {
    originalUrl?: string
    body?: unknown
  }
  rawBody?: unknown
}

function normalizeRawBody(value: unknown): string | Buffer | null | undefined {
  if (typeof value === 'string') return value
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return value
  return undefined
}
