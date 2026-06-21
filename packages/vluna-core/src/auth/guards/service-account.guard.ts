import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common'
import type { AppRequest } from '../../types/app-request.js'
import { pool } from '../../db/index.js'
import { detectAuthScheme } from '../utils/auth-scheme.js'
import { ensureBillingAccount } from '../../security/principal/billing-account.resolver.js'
import type { BillingAccountResolution } from '../../security/principal/billing-account.resolver.js'
import { resolvePrincipal } from '../../security/principal/principal.resolver.js'

@Injectable()
export class ServiceAccountGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AppRequest>()
    if (!req) {
      throw new HttpException({ code: 'AUTH.INVALID_REQUEST', message: 'request unavailable' }, 500)
    }

    const scheme = req.ctx?.authScheme ?? detectAuthScheme(req.headers?.authorization as string | undefined)
    const serviceAccessAllowed = scheme === 'service' || req.ctx?.serviceAccessAllowed
    if (!serviceAccessAllowed) {
      return true
    }

    const realmId = req.ctx?.realmId
    if (!realmId) {
      throw new HttpException({ code: 'AUTH.MISSING_REALM', message: 'realm_id missing in context' }, 400)
    }

    const binding = req.ctx?.serviceAuthBinding || {}
    let principalId = binding.principalId || this.getHeader(req.headers, 'x-principal-id')
    let billingAccountId = binding.billingAccountId || this.getHeader(req.headers, 'x-billing-account-id')

    if (!principalId && req.ctx?.serviceAccessAllowed && scheme !== 'service') {
      principalId = await this.resolvePrincipalFromClaims(req)
    }

    const resolved = await this.resolveBindings({ realmId, principalId, billingAccountId, ctx: req.ctx })
    this.assertServiceKeyAllowsAccount(req, resolved.billingAccountId)

    req.ctx.principal = { id: resolved.principalId }
    req.ctx.billingAccountId = resolved.billingAccountId
    if (resolved.account) req.ctx.billingAccount = resolved.account

    return true
  }

  private getHeader(headers: AppRequest['headers'], name: string): string | undefined {
    const raw = headers?.[name.toLowerCase() as keyof AppRequest['headers']] ?? headers?.[name as keyof AppRequest['headers']]
    if (typeof raw === 'string') return raw.trim()
    if (Array.isArray(raw)) return raw.join(',').trim()
    return undefined
  }

  private async resolvePrincipalFromClaims(req: AppRequest): Promise<string | undefined> {
    const claims = req?.ctx?.claims
    if (!claims) return undefined
    const realmId = String(req?.ctx?.realmId || '').trim() || undefined
    try {
      const principal = await resolvePrincipal({ realmId }, claims)
      return principal?.id ? String(principal.id) : undefined
    } catch {
      return undefined
    }
  }

  private assertServiceKeyAllowsAccount(req: AppRequest, billingAccountId: string): void {
    const allowedAccounts = req.ctx?.serviceApiKey?.allowedAccounts ?? []
    if (allowedAccounts.length > 0 && !allowedAccounts.includes(billingAccountId)) {
      throw new HttpException({ code: 'AUTH.SERVICE_KEY_ACCOUNT_FORBIDDEN', message: 'Service API key not authorized for billing account' }, 403)
    }
  }

  private async resolveBindings(params: {
    realmId: string
    principalId?: string
    billingAccountId?: string
    ctx?: Record<string, unknown>
  }): Promise<{ billingAccountId: string; principalId: string; account?: BillingAccountResolution }> {
    const reqCtx = params.ctx as { isRealmAdmin?: boolean; serviceAccessAllowed?: boolean }
    const realmId = params.realmId.trim()
    const principalId = params.principalId?.trim() || ''
    const billingAccountId = params.billingAccountId?.trim() || ''
    const allowCrossAccount = params.ctx && typeof params.ctx === 'object'
      ? (reqCtx.isRealmAdmin === true || reqCtx.serviceAccessAllowed === true)
      : false

    if (!principalId && !billingAccountId) {
      throw new HttpException({ code: 'AUTH.MISSING_SERVICE_BINDINGS', message: 'principal_id or billing_account_id required' }, 401)
    }

    const queries: Array<{ sql: string; params: unknown[] }> = []

    if (principalId && billingAccountId) {
      if (allowCrossAccount) {
        queries.push({
          sql: `select billing_account_id, billing_principal_id from billing_accounts where realm_id = $1 and billing_account_id = $2 limit 1`,
          params: [realmId, billingAccountId],
        })
      } else {
        queries.push({
          sql: `select billing_account_id, billing_principal_id from billing_accounts where realm_id = $1 and billing_account_id = $2 and billing_principal_id = $3 limit 1`,
          params: [realmId, billingAccountId, principalId],
        })
      }
    } else if (billingAccountId) {
      queries.push({
        sql: `select billing_account_id, billing_principal_id from billing_accounts where realm_id = $1 and billing_account_id = $2 limit 1`,
        params: [realmId, billingAccountId],
      })
    } else if (principalId) {
      const resolution = await ensureBillingAccount({ realmId, principalId: principalId, autoCreate: true, ctx: params.ctx })
      if (resolution) {
        return {
          billingAccountId: resolution.billingAccountId,
          principalId: principalId,
          account: resolution,
        }
      }
    }

    for (const query of queries) {
      const result = await pool.query(query.sql, query.params)
      const row = result?.rows?.[0]
      if (row?.billing_account_id && row?.billing_principal_id) {
        return {
          billingAccountId: String(row.billing_account_id),
          principalId: String(row.billing_principal_id),
        }
      }
    }

    throw new HttpException({ code: 'AUTH.SERVICE_BINDINGS_INVALID', message: 'Unable to resolve service binding for realm' }, 403)
  }
}
