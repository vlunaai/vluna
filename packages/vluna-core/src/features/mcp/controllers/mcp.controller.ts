import { Body, Controller, Get, HttpException, Inject, Post, Req, UseGuards } from '@nestjs/common'
import { okEnvelope } from '../../../common/envelope.js'
import { AuthRequiredGuard } from '../../../auth/guards/auth-required.guard.js'
import { ServiceAuthGuard } from '../../../auth/guards/service-auth.guard.js'
import { TokenClaimsGuard } from '../../../auth/guards/token-claims.guard.js'
import {
  MCP_AUTHORIZATION_POLICY,
  type IssueMcpSessionParams,
  type McpAuthorizationPolicy,
  type McpScope,
} from '../../../auth/policies/mcp-authorization.policy.js'
import type { AppRequest } from '../../../types/app-request.js'
import { McpSessionTokenService } from '../services/mcp-session-token.service.js'
import { McpSessionGuard } from '../services/mcp-session.guard.js'
import { Audit } from '../../../support/audit/audit.decorator.js'

type IssueSessionBody = {
  requested_scopes?: string[]
  requested_realm_id?: string
  requested_org_id?: string
  requested_binding?: 'realm' | 'org'
  ttl_sec?: number
}

type SelectRealmBody = {
  realm_id: string
}

@Controller('mcp')
export class McpController {
  constructor(
    @Inject(MCP_AUTHORIZATION_POLICY) private readonly policy: McpAuthorizationPolicy,
    private readonly tokenService: McpSessionTokenService,
  ) {}

  @Post('session:issue')
  @UseGuards(AuthRequiredGuard, ServiceAuthGuard, TokenClaimsGuard)
  @Audit({
    action: 'mcp_session.issue',
    operationId: 'issueMcpSession',
    targetType: 'mcp_session',
    targetIdFrom: ({ responseBody }) => {
      const response = responseBody as { data?: { subject_id?: unknown; selected_realm?: unknown } } | undefined
      const subjectId = typeof response?.data?.subject_id === 'string' ? response.data.subject_id.trim() : ''
      const selectedRealm = typeof response?.data?.selected_realm === 'string' ? response.data.selected_realm.trim() : ''
      return subjectId || selectedRealm || undefined
    },
    responseRedact: ['data.mcp_session_token'],
  })
  async issueSession(@Req() req: AppRequest, @Body() body: IssueSessionBody) {
    const params: IssueMcpSessionParams = {
      req,
      requested_scopes: normalizeScopes(body?.requested_scopes),
      requested_realm_id: toOptionalString(body?.requested_realm_id),
      requested_org_id: toOptionalString(body?.requested_org_id),
      requested_binding: body?.requested_binding === 'org' ? 'org' : 'realm',
      requested_ttl_sec: Number(body?.ttl_sec) || undefined,
    }
    const grant = await this.policy.issueSession(params)
    const issued = await this.tokenService.issue(grant)
    return okEnvelope({
      mcp_session_token: issued.token,
      token_type: 'Bearer',
      expires_at: issued.expires_at,
      expires_in: issued.expires_in,
      granted_scopes: grant.granted_scopes,
      allowed_realms: grant.allowed_realms,
      selected_realm: grant.default_realm ?? null,
      binding_type: grant.binding_type,
      subject_type: grant.subject_type,
      subject_id: grant.subject_id,
      organization_id: grant.organization_id ?? null,
    })
  }

  @Get('realms')
  @UseGuards(McpSessionGuard)
  async listRealms(@Req() req: AppRequest) {
    const claims = req.ctx?.mcpSession
    if (!claims) throw new HttpException({ code: 'AUTH.INVALID_TOKEN', message: 'missing mcp session' }, 401)
    const realms = await this.policy.listRealmsForSession(req, claims)
    return okEnvelope({
      items: realms,
      selected_realm: claims.selected_realm ?? null,
      binding_type: claims.binding_type,
    })
  }

  @Post('context:select-realm')
  @UseGuards(McpSessionGuard)
  async selectRealm(@Req() req: AppRequest, @Body() body: SelectRealmBody) {
    const claims = req.ctx?.mcpSession
    if (!claims) throw new HttpException({ code: 'AUTH.INVALID_TOKEN', message: 'missing mcp session' }, 401)
    const realmId = String(body?.realm_id || '').trim()
    if (!realmId) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'realm_id is required' }, 422)
    }
    if (!claims.allowed_realms.includes(realmId)) {
      throw new HttpException({ code: 'AUTH.UNAUTHORIZED_REALM', message: 'realm not allowed in this session' }, 403)
    }
    const issued = await this.tokenService.selectRealm(claims, realmId)
    return okEnvelope({
      mcp_session_token: issued.token,
      token_type: 'Bearer',
      expires_at: issued.expires_at,
      expires_in: issued.expires_in,
      selected_realm: realmId,
    })
  }

  @Get('feature-families')
  @UseGuards(McpSessionGuard)
  async getFeatureFamilies(@Req() req: AppRequest) {
    const claims = req.ctx?.mcpSession
    if (!claims) throw new HttpException({ code: 'AUTH.INVALID_TOKEN', message: 'missing mcp session' }, 401)
    const feature_families = {
      edition: claims.edition,
      scopes: claims.granted_scopes,
      enabled_surfaces: ['billing', 'mgt', 'gate', 'ops', 'internal'],
      selected_realm: claims.selected_realm ?? null,
    }
    return okEnvelope(feature_families)
  }
}

function normalizeScopes(input?: string[]): McpScope[] {
  if (!Array.isArray(input) || input.length === 0) {
    return ['mcp:read', 'mcp:write']
  }
  const normalized = new Set<McpScope>()
  for (const value of input) {
    if (value === 'mcp:read' || value === 'mcp:write') normalized.add(value)
  }
  if (!normalized.size) {
    normalized.add('mcp:read')
  }
  return Array.from(normalized)
}

function toOptionalString(value: unknown): string | undefined {
  const text = String(value || '').trim()
  return text || undefined
}
