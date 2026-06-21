import { CanActivate, ExecutionContext, Inject, Injectable, HttpException, Optional } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { createSecretKey } from 'node:crypto'
import { jwtVerify } from 'jose'
import { TOKEN_VALIDATOR, TokenValidator, TokenClaims } from '../tokens/token.types.js'
import type { RealmAuthProfile } from '../../security/realm-config.service.js'
import type { AppRequest } from '../../types/app-request.js'
import { detectAuthScheme } from '../utils/auth-scheme.js'
import { REALM_DEFAULT_AUDIENCE, REQUIRED_AUDIENCE_KEY } from '../decorators/audience.decorator.js'
import { REQUIRED_SCOPES_KEY } from '../decorators/scopes.decorator.js'
import { SERVICE_ACCESS_POLICY, type ServiceAccessPolicy } from '../policies/service-access.policy.js'
import { SCOPE_BYPASS_POLICY, type ScopeBypassPolicy } from '../policies/scope-bypass.policy.js'
import { pool } from '../../db/index.js'
import type { DatSessionClaims } from '../../features/dat/types/session.js'
import { ALLOW_MISSING_REALM_KEY } from '../decorators/allow-missing-realm.decorator.js'
import { RealmConfigService } from '../../security/realm-config.service.js'

@Injectable()
export class TokenClaimsGuard implements CanActivate {
  constructor(
    @Inject(TOKEN_VALIDATOR) private readonly validator: TokenValidator,
    @Inject(Reflector) private readonly reflector: Reflector,
    @Optional() @Inject(SERVICE_ACCESS_POLICY) private readonly serviceAccessPolicy?: ServiceAccessPolicy,
    @Optional() @Inject(SCOPE_BYPASS_POLICY) private readonly scopeBypassPolicy?: ScopeBypassPolicy,
    @Optional() @Inject(RealmConfigService) private readonly realmConfig?: RealmConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AppRequest>()
    const audienceMeta = this.reflector.getAllAndOverride<string | undefined>(REQUIRED_AUDIENCE_KEY, [
      context.getHandler(),
      context.getClass(),
    ])
    const requiredScopes = this.reflector.getAllAndOverride<string[]>(REQUIRED_SCOPES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]) || []
    const scheme = req.ctx?.authScheme ?? detectAuthScheme(req.headers?.authorization as string | undefined)
    if (scheme === 'service') {
      return true
    }
    const auth = (req.headers?.authorization as string | undefined) || ''
    const token = auth.toLowerCase().startsWith('bearer ') ? auth.split(' ', 2)[1] : undefined
    if (!token) throw new HttpException('missing_token', 401)
    const allowMissingRealm = this.reflector.getAllAndOverride<boolean>(ALLOW_MISSING_REALM_KEY, [
      context.getHandler(),
      context.getClass(),
    ]) === true
    const realmId = req.ctx?.realmId || (req.headers?.['x-realm-id'] as string | undefined)?.trim()
    if (!realmId && !allowMissingRealm) throw new HttpException('missing_realm', 400)
    const realmAuth = await this.resolveAuthProfile(realmId, req)
    const resolvedAudience = this.resolveAudience(audienceMeta, realmAuth)

    let claims: TokenClaims
    if (req.ctx?.claimsVerified && req.ctx?.claims) {
      claims = req.ctx.claims
    } else {
      try {
        claims = await this.validator.verify(token, { realmId, authProfile: realmAuth, audience: resolvedAudience })
      } catch {
        if (!realmId) throw new HttpException('invalid_token', 401)
        const datClaims = await this.tryVerifyDatSessionToken(token)
        if (!datClaims) {
          throw new HttpException('invalid_token', 401)
        }
        this.applyDatClaimsToContext(req, datClaims, realmId)
        this.checkDatScopes(req, requiredScopes, datClaims)
        return true
      }
      req.ctx = req.ctx || {}
      req.ctx.claimsVerified = true
    }

    this.applyClaimsToContext(req, claims)
    await this.checkScopes(req, requiredScopes, claims, realmAuth)
    await this.maybeAllowServiceAccess(req)
    this.maybeApplyRealmAdmin(req)
    return true
  }

  private async resolveAuthProfile(
    realmId: string | undefined,
    req: AppRequest,
  ): Promise<RealmAuthProfile | null | undefined> {
    if (req.ctx?.realmConfig?.auth) return req.ctx.realmConfig.auth
    if (realmId && this.realmConfig) {
      try {
        return await this.realmConfig.getAuthProfile(realmId)
      } catch {
        return undefined
      }
    }
    if (this.realmConfig) {
      try {
        return await this.realmConfig.getAuthProfile(undefined)
      } catch {
        return undefined
      }
    }
    return undefined
  }

  private async tryVerifyDatSessionToken(token: string): Promise<DatSessionClaims | null> {
    const configured = (process.env.VLUNA_DAT_TOKEN_SIGNING_KEY || process.env.BILLING_MASTER_KEY || '').trim()
    const env = String(process.env.NODE_ENV || '').toLowerCase()
    if (!configured && env === 'production') {
      return null
    }
    const signingKey = createSecretKey(Buffer.from(configured || 'dev-only-vluna-dat-secret', 'utf8'))
    const issuer = (process.env.VLUNA_DAT_TOKEN_ISSUER || '').trim() || 'vluna.dat'
    const audience = (process.env.VLUNA_DAT_TOKEN_AUDIENCE || '').trim() || 'vluna.dat'
    try {
      const verified = await jwtVerify(token, signingKey, {
        issuer,
        audience,
        algorithms: ['HS256'],
      })
      const claims = verified.payload as unknown as DatSessionClaims
      if (claims.tu !== 'dat' && claims.token_use !== 'dat') return null
      const revoked = await pool.query('select 1 from dat_revoked_jtis where jti = $1 limit 1', [claims.jti])
      if (Number(revoked.rowCount || 0) > 0) return null
      return claims
      } catch {
      return null
    }
  }

  private applyDatClaimsToContext(req: AppRequest, claims: DatSessionClaims, realmId: string): void {
    const allowedRealms = Array.isArray(claims.allowed_realms) ? claims.allowed_realms.map((value) => String(value || '').trim()).filter(Boolean) : []
    if (!allowedRealms.includes(realmId)) {
      throw new HttpException('realm_mismatch', 403)
    }
    if (claims.binding_type === 'realm') {
      const selectedRealm = String(claims.selected_realm || '').trim() || allowedRealms[0]
      if (selectedRealm && selectedRealm !== realmId) {
        throw new HttpException('realm_mismatch', 403)
      }
    }
    req.ctx = req.ctx || {}
    req.ctx.authScheme = 'bearer'
    req.ctx.claimsVerified = true
    req.ctx.claims = claims as unknown as TokenClaims
    req.ctx.sub = claims.subject_id
    req.ctx.userId = claims.subject_id
    req.ctx.datSession = claims
    req.ctx.datAccessAllowed = true
    req.ctx.serviceAccessAllowed = true
    req.ctx.principal = { id: claims.subject_id, type: claims.subject_type }
    req.ctx.serviceAuthBinding = {
      principalId: claims.subject_id,
      userId: claims.subject_id,
      billingAccountId: req.ctx.serviceAuthBinding?.billingAccountId,
      billingUserId: req.ctx.serviceAuthBinding?.billingUserId,
    }
    const realmAdminHeader =
      (req.headers?.['x-realm-admin'] as string | undefined) ||
      (req.headers?.['X-Realm-Admin'] as string | undefined)
    req.ctx.isRealmAdmin = String(realmAdminHeader || '').toLowerCase() === 'true'
  }

  private checkDatScopes(req: AppRequest, requiredScopes: string[], claims: DatSessionClaims): void {
    void req
    void requiredScopes
    void claims
    return
  }

  private resolveAudience(metaAudience: string | undefined, profile: RealmAuthProfile | null | undefined): string | undefined {
    if (!metaAudience || metaAudience === REALM_DEFAULT_AUDIENCE) {
      return profile?.issuers?.[0]?.audiences?.[0]
    }
    return metaAudience
  }

  private applyClaimsToContext(req: AppRequest, claims: TokenClaims): void {
    const sub = claims && typeof claims.sub === 'string' ? claims.sub : ''
    req.ctx = req.ctx || {}
    req.ctx.authScheme = 'bearer'
    if (sub) { req.ctx.sub = sub; req.ctx.userId = sub }
    try { req.ctx.versionToken = claims?.v } catch {}
    req.ctx.claims = claims
    this.applyPlatformTokenContext(req.ctx, claims)
  }

  private async maybeAllowServiceAccess(req: AppRequest): Promise<void> {
    if (req.ctx?.serviceAccessAllowed) return
    if (!this.serviceAccessPolicy) return
    try {
      const allowed = await this.serviceAccessPolicy.allowBearerServiceAccess(req)
      if (allowed) {
        req.ctx = req.ctx || {}
        req.ctx.serviceAccessAllowed = true
      }
    } catch {
      // ignore policy failures to avoid breaking non-cloud flows
    }
  }

  private maybeApplyRealmAdmin(req: AppRequest): void {
    if (!req.ctx?.serviceAccessAllowed) return
    const header =
      (req.headers?.['x-realm-admin'] as string | undefined) ||
      (req.headers?.['X-Realm-Admin'] as string | undefined)
    if (String(header || '').toLowerCase() === 'true') {
      req.ctx = req.ctx || {}
      req.ctx.isRealmAdmin = true
    }
  }

  private applyPlatformTokenContext(ctx: AppRequest['ctx'], claims: TokenClaims): void {
    if (!claims || typeof claims !== 'object') return
    const payload = claims as Record<string, unknown>
    const tokenUseRaw = payload.token_use || payload.tu
    const tokenUse = typeof tokenUseRaw === 'string' ? tokenUseRaw.toLowerCase() : undefined
    if (tokenUse !== 'platform' && tokenUse !== 'plt' && tokenUse !== 'vluna' && tokenUse !== 'apt') return
    const realmId = String(payload.realm_id || '').trim()
    if (realmId) {
      if (ctx.realmId && ctx.realmId !== realmId) {
        throw new HttpException('realm_mismatch', 403)
      }
      ctx.realmId = realmId
    }

    const principalId = String(payload.billing_principal_id || payload.principal_id || '').trim()
    if (principalId) {
      ctx.principal = { id: principalId, type: 'platform' }
    }
    const businessUserId = String(payload.business_user_id || payload.user_id || payload.sub || '').trim()
    if (businessUserId) {
      ctx.businessUserId = businessUserId
      ctx.userId = businessUserId
    }
    const billingAccountId = String(payload.billing_account_id || '').trim()
    if (billingAccountId) ctx.billingAccountId = billingAccountId
    const billingUserId = String(payload.billing_user_id || '').trim()
    if (billingUserId) ctx.billingUserId = billingUserId
    const scopesRaw = payload.plt_scopes || payload.apt_scopes
    const scopes = Array.isArray(scopesRaw) ? scopesRaw.map((val) => String(val || '')).filter(Boolean) : []
    const versionRaw = Number(payload.tv || 1)
    const issuedBy = typeof payload.ib === 'string' ? String(payload.ib) : undefined
    ctx.platformToken = { scopes, version: Number.isFinite(versionRaw) ? versionRaw : 1, issuedBy }
  }

  private async checkScopes(req: AppRequest, required: string[], claims: TokenClaims, profile?: RealmAuthProfile | null): Promise<void> {
    if (!required || required.length === 0) return
    if (this.scopeBypassPolicy && await this.scopeBypassPolicy.allowCanonicalScopes(req, required, profile)) {
      return
    }
    const mappings = this.resolveScopeMappings(required, profile)
    if (Object.keys(mappings).length === 0) return
    const provided = new Set<string>()
    for (const key of this.resolveScopeKeys(profile)) {
      for (const value of this.extractScopeValues(claims, key)) {
        provided.add(value)
      }
      if (provided.size > 0) break
    }
    for (const canonicalScope of required) {
      const acceptedScopes = mappings[canonicalScope] ?? [canonicalScope]
      if (!acceptedScopes.some((scope) => provided.has(scope))) {
        throw new HttpException('insufficient_scope', 403)
      }
    }
  }

  private resolveScopeMappings(required: string[], profile?: RealmAuthProfile | null): Record<string, string[]> {
    const configured = profile?.scopeMappings
    if (!configured || Object.keys(configured).length === 0) {
      return {}
    }
    const output: Record<string, string[]> = {}
    for (const canonicalScope of required) {
      const mapped = configured[canonicalScope]
      output[canonicalScope] = Array.isArray(mapped) && mapped.length > 0 ? mapped : [canonicalScope]
    }
    return output
  }

  private resolveScopeKeys(profile?: RealmAuthProfile | null): string[] {
    const keys: string[] = []
    const configured = profile?.scopeClaim?.trim()
    if (configured) keys.push(configured)
    if (!keys.includes('scope')) keys.push('scope')
    return keys
  }

  private extractScopeValues(claims: TokenClaims, key: string): string[] {
    if (!claims || !key) return []
    const raw = claims[key]
    if (!raw) return []
    if (Array.isArray(raw)) {
      return raw.map((value) => String(value || '').trim()).filter(Boolean)
    }
    const text = String(raw || '').trim()
    if (!text) return []
    return text.split(/\s+/).filter(Boolean)
  }
}
