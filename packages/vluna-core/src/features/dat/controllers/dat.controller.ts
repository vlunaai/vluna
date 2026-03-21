import { Body, Controller, Get, HttpException, Inject, Param, Post, Req, UseGuards } from '@nestjs/common'
import { decodeJwt } from 'jose'
import { unknownRealmHttpException } from '../../../common/errors.js'
import { okEnvelope } from '../../../common/envelope.js'
import { AuthRequiredGuard } from '../../../auth/guards/auth-required.guard.js'
import { ServiceAuthGuard } from '../../../auth/guards/service-auth.guard.js'
import { TokenClaimsGuard } from '../../../auth/guards/token-claims.guard.js'
import { RealmMembershipGuard } from '../../../auth/guards/realm-membership.guard.js'
import {
  DAT_AUTHORIZATION_POLICY,
  type DatAuthorizationPolicy,
  type DatSessionGrant,
  type DatScope,
} from '../../../auth/policies/dat-authorization.policy.js'
import type { AppRequest } from '../../../types/app-request.js'
import { DatBootstrapGuard } from '../guards/dat-bootstrap.guard.js'
import { DatBootstrapAdminGuard } from '../guards/dat-bootstrap-admin.guard.js'
import { DatSessionIssueAuthGuard } from '../guards/dat-session-issue-auth.guard.js'
import { DatSessionIssueRateLimitGuard } from '../guards/dat-session-issue-rate-limit.guard.js'
import { DatBootstrapManagementService } from '../services/dat-bootstrap-management.service.js'
import { DatTokenService } from '../services/dat-token.service.js'
import { RealmGuard } from '../../../auth/guards/realm.guard.js'
import { OptionalRealmGuard } from '../../../auth/guards/optional-realm.guard.js'
import { RealmConfigService } from '../../../security/realm-config.service.js'
import { pool } from '../../../db/index.js'
import { Audit } from '../../../support/audit/audit.decorator.js'

type IssueSessionBody = {
  requested_scopes?: string[]
  requested_realm_id?: string
  requested_org_id?: string
  requested_binding?: 'realm' | 'org'
  ttl_sec?: number
}

type RevokeBody = {
  jti?: string
  access_token?: string
  reason?: string
}

type IntrospectBody = {
  access_token: string
}

type CreateBootstrapBody = {
  subject_id?: string
  organization_id?: string
  allowed_realms?: string[]
  granted_scopes?: string[]
  issued_by?: string
  expires_at?: string
}

@Controller('dat')
export class DatController {
  constructor(
    @Inject(DAT_AUTHORIZATION_POLICY) private readonly policy: DatAuthorizationPolicy,
    private readonly bootstrapManagement: DatBootstrapManagementService,
    private readonly datTokenService: DatTokenService,
    private readonly realmConfig: RealmConfigService,
  ) {}

  @Post('session/issue')
  @UseGuards(OptionalRealmGuard, AuthRequiredGuard, DatSessionIssueAuthGuard, DatSessionIssueRateLimitGuard)
  @Audit({
    action: 'dat_session.issue',
    operationId: 'issueDatSession',
    targetType: 'dat_session',
    targetIdFrom: 'response.data.jti',
    responseRedact: ['data.access_token'],
  })
  async issueSession(@Req() req: AppRequest, @Body() body: IssueSessionBody) {
    const requested_scopes = normalizeScopes(body?.requested_scopes)
    const requested_realm_id = toOptionalString(body?.requested_realm_id)
    const requested_org_id = toOptionalString(body?.requested_org_id)
    const requested_binding = body?.requested_binding === 'org' ? 'org' : 'realm'
    const requested_ttl_sec = Number(body?.ttl_sec) || undefined

    const grant = await this.resolveSessionGrant(req, {
      requested_scopes,
      requested_realm_id,
      requested_org_id,
      requested_binding,
      requested_ttl_sec,
    })
    const finalizedGrant = await this.applyActiveRealmConstraints(grant, requested_realm_id)
    const issued = await this.datTokenService.issue(finalizedGrant)
    return okEnvelope({
      access_token: issued.token,
      token_type: 'Bearer',
      expires_at: issued.expires_at,
      expires_in: issued.expires_in,
      subject_type: finalizedGrant.subject_type,
      subject_id: finalizedGrant.subject_id,
      organization_id: finalizedGrant.organization_id ?? null,
      binding_type: finalizedGrant.binding_type,
      allowed_realms: finalizedGrant.allowed_realms,
      selected_realm: finalizedGrant.default_realm ?? null,
      granted_scopes: finalizedGrant.granted_scopes,
      jti: issued.jti,
    })
  }

  private async resolveSessionGrant(
    req: AppRequest,
    params: {
      requested_scopes: DatScope[]
      requested_realm_id?: string
      requested_org_id?: string
      requested_binding: 'realm' | 'org'
      requested_ttl_sec?: number
    },
  ): Promise<DatSessionGrant> {
    const bootstrap = req.ctx?.datBootstrap
    if (bootstrap) {
      return this.policy.issueSession({
        req,
        bootstrap,
        ...params,
      })
    }
    if (this.policy.issueSessionFromBearer) {
      return this.policy.issueSessionFromBearer({
        req,
        ...params,
      })
    }
    throw new HttpException({ code: 'AUTH.INVALID_BOOTSTRAP_TOKEN', message: 'bootstrap token required' }, 401)
  }

  private async applyActiveRealmConstraints(grant: DatSessionGrant, requestedRealmId?: string): Promise<DatSessionGrant> {
    const dedupAllowed = Array.from(new Set((grant.allowed_realms || []).map((realm) => String(realm || '').trim()).filter(Boolean)))
    if (!dedupAllowed.length) {
      throw new HttpException({ code: 'AUTH.UNAUTHORIZED_REALM', message: 'bootstrap token has no allowed realms' }, 403)
    }

    const activeAllowed: string[] = []
    for (const realmId of dedupAllowed) {
      const status = await this.readRealmStatus(realmId)
      if (status === 'active') activeAllowed.push(realmId)
    }
    if (!activeAllowed.length) {
      throw new HttpException({ code: 'AUTH.UNAUTHORIZED_REALM', message: 'no active allowed realms' }, 403)
    }

    const requested = String(requestedRealmId || '').trim()
    if (requested) {
      const status = await this.readRealmStatus(requested)
      if (status === 'unknown') throw unknownRealmHttpException(requested)
      if (status === 'deleted') throw unknownRealmHttpException(requested)
      if (status !== 'active') throw new HttpException('realm_inactive', 403)
      if (!activeAllowed.includes(requested)) {
        throw new HttpException({ code: 'AUTH.UNAUTHORIZED_REALM', message: 'requested realm not allowed' }, 403)
      }
    }

    const preferred = String(grant.default_realm || '').trim()
    const selected = requested || (preferred && activeAllowed.includes(preferred) ? preferred : activeAllowed[0])
    return {
      ...grant,
      allowed_realms: activeAllowed,
      default_realm: selected,
    }
  }

  private async readRealmStatus(realmId: string): Promise<'active' | 'suspended' | 'deleted' | 'unknown'> {
    try {
      return await this.realmConfig.getRealmStatus(realmId)
    } catch (err) {
      if ((err as { code?: string }).code === 'realm_not_found') return 'unknown'
      throw err
    }
  }

  @Post('session/revoke')
  @UseGuards(AuthRequiredGuard, DatBootstrapGuard)
  @Audit({
    action: 'dat_session.revoke',
    operationId: 'revokeDatSession',
    targetType: 'dat_session',
    targetIdFrom: ({ req, responseBody }) => {
      const body = req.body as RevokeBody | undefined
      if (typeof body?.jti === 'string' && body.jti.trim()) return body.jti.trim()
      const response = responseBody as { data?: { jti?: unknown } } | undefined
      if (typeof response?.data?.jti === 'string' && response.data.jti.trim()) return response.data.jti.trim()
      return undefined
    },
    redact: ['body.access_token'],
  })
  async revokeSession(@Req() req: AppRequest, @Body() body: RevokeBody) {
    const bootstrap = req.ctx?.datBootstrap
    if (!bootstrap) {
      throw new HttpException({ code: 'AUTH.INVALID_BOOTSTRAP_TOKEN', message: 'bootstrap context missing' }, 401)
    }
    const resolvedJti = resolveJti(body?.jti, body?.access_token)
    if (!resolvedJti) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'jti or access_token is required' }, 422)
    }
    await this.datTokenService.revoke(resolvedJti, {
      subject_id: bootstrap.subject_id,
      organization_id: bootstrap.organization_id,
      reason: toOptionalString(body?.reason),
    })
    return okEnvelope({ revoked: true, jti: resolvedJti })
  }

  @Post('session/introspect')
  @UseGuards(AuthRequiredGuard, DatBootstrapGuard)
  async introspectSession(@Body() body: IntrospectBody) {
    const token = toOptionalString(body?.access_token)
    if (!token) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'access_token is required' }, 422)
    }
    try {
      const claims = await this.datTokenService.verify(token)
      return okEnvelope({
        valid: true,
        token_use: claims.tu,
        jti: claims.jti,
        subject_type: claims.subject_type,
        subject_id: claims.subject_id,
        organization_id: claims.organization_id ?? null,
        binding_type: claims.binding_type,
        granted_scopes: claims.granted_scopes,
        allowed_realms: claims.allowed_realms,
        selected_realm: claims.selected_realm ?? null,
        exp: claims.exp,
        expires_at: new Date(claims.exp * 1000).toISOString(),
      })
    } catch {
      const fallback = parseJwtPayload(token)
      return okEnvelope({
        valid: false,
        token_use: fallback?.tu ?? fallback?.token_use ?? null,
        jti: fallback?.jti ?? null,
      })
    }
  }

  @Post('/bootstrap-tokens')
  @UseGuards(RealmGuard, AuthRequiredGuard, ServiceAuthGuard, TokenClaimsGuard, RealmMembershipGuard, DatBootstrapAdminGuard)
  @Audit({
    action: 'dat_bootstrap_token.create',
    operationId: 'createDatBootstrapToken',
    targetType: 'dat_bootstrap_token',
    targetIdFrom: 'response.data.token_id',
  })
  async createBootstrapToken(@Req() req: AppRequest, @Body() body: CreateBootstrapBody) {
    const realmId = String(req.ctx?.realmId || '').trim()
    const allowUnscopedRealms = isCloudEdition()
    const subjectFromClaims = String(req.ctx?.sub || '').trim()
    const subjectId = allowUnscopedRealms
      ? subjectFromClaims
      : String(body?.subject_id || subjectFromClaims || '').trim()
    if (!subjectId) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'subject_id is required' }, 422)
    }

    const allowedRealmsInput = Array.isArray(body?.allowed_realms) ? body.allowed_realms : []
    const requestedAllowedRealms = allowedRealmsInput.length
      ? allowedRealmsInput.map((value) => String(value || '').trim()).filter(Boolean)
      : (allowUnscopedRealms ? [] : [realmId])
    if (requestedAllowedRealms.length > 0) {
      const grantableRealms = await resolveGrantableRealms(req, realmId)
      const unauthorizedRealm = requestedAllowedRealms.find((candidate) => !grantableRealms.includes(candidate))
      if (unauthorizedRealm) {
        throw new HttpException(
          { code: 'AUTH.UNAUTHORIZED_REALM', message: `allowed_realm ${unauthorizedRealm} is outside caller scope` },
          403,
        )
      }
    }
    const allowedRealms = Array.from(new Set(requestedAllowedRealms))
    const grantedScopes = normalizeScopes(body?.granted_scopes)
    const created = await this.bootstrapManagement.create({
      realm_id: realmId,
      subject_id: subjectId,
      organization_id: allowUnscopedRealms
        ? toOptionalString((req.ctx?.claims as Record<string, unknown> | undefined)?.organization_id)
        : toOptionalString(body?.organization_id),
      allowed_realms: allowedRealms,
      granted_scopes: grantedScopes,
      issued_by: toOptionalString(body?.issued_by),
      expires_at: toOptionalString(body?.expires_at),
    }, {
      requireAllowedRealms: !allowUnscopedRealms,
      requireCurrentRealmIncluded: true,
    })
    return okEnvelope(created)
  }

  @Get('/bootstrap-tokens')
  @UseGuards(RealmGuard, AuthRequiredGuard, ServiceAuthGuard, TokenClaimsGuard, RealmMembershipGuard, DatBootstrapAdminGuard)
  async listBootstrapTokens(@Req() req: AppRequest) {
    const realmId = String(req.ctx?.realmId || '').trim()
    const items = isCloudEdition()
      ? await this.bootstrapManagement.listForSubject(resolveCloudBootstrapOwner(req))
      : await this.bootstrapManagement.listForRealm(realmId)
    return okEnvelope({ items })
  }

  @Get('/bootstrap-tokens/:token_id/reveal')
  @UseGuards(RealmGuard, AuthRequiredGuard, ServiceAuthGuard, TokenClaimsGuard, RealmMembershipGuard, DatBootstrapAdminGuard)
  @Audit({
    action: 'dat_bootstrap_token.reveal',
    operationId: 'revealDatBootstrapToken',
    targetType: 'dat_bootstrap_token',
    targetIdFrom: 'params.token_id',
    captureResponse: true,
    responseMask: ['data.token'],
    successEvaluator: ({ responseBody }) => {
      const response = responseBody as { data?: { token?: unknown } } | undefined
      return typeof response?.data?.token === 'string' && response.data.token.trim().length > 0
    },
  })
  async revealBootstrapToken(@Req() req: AppRequest, @Param('token_id') tokenId: string) {
    const realmId = String(req.ctx?.realmId || '').trim()
    const data = isCloudEdition()
      ? await this.bootstrapManagement.revealForSubject(resolveCloudBootstrapOwner(req), tokenId)
      : await this.bootstrapManagement.revealForRealm(realmId, tokenId)
    return okEnvelope(data)
  }

  @Post('/bootstrap-tokens/:token_id/revoke')
  @UseGuards(RealmGuard, AuthRequiredGuard, ServiceAuthGuard, TokenClaimsGuard, RealmMembershipGuard, DatBootstrapAdminGuard)
  @Audit({
    action: 'dat_bootstrap_token.revoke',
    operationId: 'revokeDatBootstrapToken',
    targetType: 'dat_bootstrap_token',
    targetIdFrom: 'params.token_id',
  })
  async revokeBootstrapToken(@Req() req: AppRequest, @Param('token_id') tokenId: string) {
    const realmId = String(req.ctx?.realmId || '').trim()
    const revoked = isCloudEdition()
      ? await this.bootstrapManagement.revokeForSubject(resolveCloudBootstrapOwner(req), tokenId)
      : await this.bootstrapManagement.revokeForRealm(realmId, tokenId)
    return okEnvelope({ revoked, token_id: tokenId })
  }
}

function normalizeScopes(input?: string[]): DatScope[] {
  if (!Array.isArray(input) || input.length === 0) {
    return ['mcp:read']
  }
  const normalized = new Set<DatScope>()
  for (const value of input) {
    if (value === 'mcp:read' || value === 'mcp:write') normalized.add(value)
  }
  if (!normalized.size) normalized.add('mcp:read')
  return Array.from(normalized)
}

function toOptionalString(value: unknown): string | undefined {
  const text = String(value || '').trim()
  return text || undefined
}

function resolveJti(jti?: string, accessToken?: string): string | undefined {
  const normalizedJti = toOptionalString(jti)
  if (normalizedJti) return normalizedJti
  const payload = parseJwtPayload(accessToken)
  if (!payload || typeof payload.jti !== 'string') return undefined
  return payload.jti.trim() || undefined
}

function parseJwtPayload(token: unknown): Record<string, unknown> | undefined {
  const normalized = toOptionalString(token)
  if (!normalized) return undefined
  try {
    return decodeJwt(normalized) as Record<string, unknown>
  } catch {
    return undefined
  }
}

async function resolveGrantableRealms(req: AppRequest, realmId: string): Promise<string[]> {
  const fromServiceKey = req.ctx?.serviceApiKey?.allowedRealms
  if (Array.isArray(fromServiceKey) && fromServiceKey.length > 0) {
    return Array.from(new Set(fromServiceKey.map((value) => String(value || '').trim()).filter(Boolean)))
  }

  const fromDatSession = req.ctx?.datSession?.allowed_realms
  if (Array.isArray(fromDatSession) && fromDatSession.length > 0) {
    return Array.from(new Set(fromDatSession.map((value) => String(value || '').trim()).filter(Boolean)))
  }

  const claims = req.ctx?.claims as Record<string, unknown> | undefined
  const organizationId = String(claims?.organization_id || '').trim()
  if (organizationId && String(process.env.VLUNA_EDITION || '').toLowerCase() === 'cloud') {
    const result = await pool.query<{ realm_id: string }>(
      `
      select m.realm_id
      from cloud_realm_members m
      join realms r on r.realm_id = m.realm_id
      where m.kind = 'organization'
        and m.subject_id = $1
        and r.status = 'active'
      order by m.realm_id asc
      `,
      [organizationId],
    )
    const realms = result.rows.map((row) => String(row.realm_id || '').trim()).filter(Boolean)
    if (realms.length > 0) return Array.from(new Set(realms))
  }

  return realmId ? [realmId] : []
}

function resolveCloudBootstrapOwner(req: AppRequest): string {
  const subjectId = String(req.ctx?.sub || req.ctx?.claims?.sub || '').trim()
  if (!subjectId) {
    throw new HttpException({ code: 'AUTH.MISSING_SUBJECT', message: 'subject missing' }, 401)
  }
  return subjectId
}

function isCloudEdition(): boolean {
  return String(process.env.VLUNA_EDITION || '').toLowerCase() === 'cloud'
}
