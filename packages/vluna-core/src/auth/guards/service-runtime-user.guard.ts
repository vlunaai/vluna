import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common'
import type { AppRequest } from '../../types/app-request.js'
import { pool } from '../../db/index.js'
import { ensureBillingAccount, ensureBillingUser } from '../../security/principal/billing-account.resolver.js'
import type {
  BillingAccountResolution,
  BillingUserResolution,
} from '../../security/principal/billing-account.resolver.js'

@Injectable()
export class ServiceRuntimeUserGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AppRequest>()
    if (!req) {
      throw new HttpException({ code: 'AUTH.INVALID_REQUEST', message: 'request unavailable' }, 500)
    }
    req.ctx = req.ctx || {}

    const realmId = String(req.ctx.realmId || this.getHeader(req.headers, 'x-realm-id') || '').trim()
    if (!realmId) {
      throw new HttpException({ code: 'AUTH.MISSING_REALM', message: 'realm_id missing in context' }, 400)
    }

    const binding = req.ctx.serviceAuthBinding || {}
    const principalId = String(binding.principalId || req.ctx.principal?.id || this.getHeader(req.headers, 'x-principal-id') || '').trim()
    const userId = String(binding.userId || req.ctx.businessUserId || this.getHeader(req.headers, 'x-user-id') || req.ctx.userId || '').trim()
    const providedBillingAccountId = String(binding.billingAccountId || req.ctx.billingAccountId || this.getHeader(req.headers, 'x-billing-account-id') || '').trim()
    const providedBillingUserId = String(binding.billingUserId || req.ctx.billingUserId || this.getHeader(req.headers, 'x-billing-user-id') || '').trim()
    const isPlatformToken = req.ctx.platformToken !== undefined

    if (!isPlatformToken && (!principalId || !userId)) {
      throw new HttpException({ code: 'AUTH.MISSING_RUNTIME_BINDINGS', message: 'x-principal-id and x-user-id are required' }, 401)
    }

    const account = await this.resolveAccount({
      realmId,
      principalId,
      billingAccountId: providedBillingAccountId,
      ctx: req.ctx,
    })
    this.assertServiceKeyAllowsAccount(req, account.billingAccountId)
    const billingUser = await this.resolveBillingUser({
      realmId,
      billingAccountId: account.billingAccountId,
      billingUserId: providedBillingUserId,
      userId,
      ctx: req.ctx,
      autoCreate: !isPlatformToken || Boolean(userId),
    })

    if (billingUser.status && billingUser.status !== 'active') {
      throw new HttpException({ code: 'AUTH.BILLING_USER_DISABLED', message: 'billing user is not active' }, 403)
    }

    req.ctx.realmId = realmId
    req.ctx.principal = { id: account.billingPrincipalId || principalId, type: 'platform' }
    req.ctx.businessUserId = billingUser.businessUserId
    req.ctx.userId = billingUser.businessUserId
    req.ctx.billingAccountId = account.billingAccountId
    req.ctx.billingAccount = account
    req.ctx.billingUserId = billingUser.billingUserId
    req.ctx.billingUser = billingUser
    return true
  }

  private assertServiceKeyAllowsAccount(req: AppRequest, billingAccountId: string): void {
    const allowedAccounts = req.ctx?.serviceApiKey?.allowedAccounts ?? []
    if (allowedAccounts.length > 0 && !allowedAccounts.includes(billingAccountId)) {
      throw new HttpException({ code: 'AUTH.SERVICE_KEY_ACCOUNT_FORBIDDEN', message: 'Service API key not authorized for billing account' }, 403)
    }
  }

  private async resolveAccount(params: {
    realmId: string
    principalId: string
    billingAccountId: string
    ctx?: Record<string, unknown>
  }): Promise<BillingAccountResolution> {
    if (params.principalId) {
      const account = await ensureBillingAccount({
        realmId: params.realmId,
        principalId: params.principalId,
        autoCreate: true,
        ctx: params.ctx,
      })
      if (!account) {
        throw new HttpException({ code: 'AUTH.BILLING_ACCOUNT_NOT_FOUND', message: 'billing account not found' }, 404)
      }
      if (params.billingAccountId && account.billingAccountId !== params.billingAccountId) {
        throw new HttpException({ code: 'AUTH.BILLING_ACCOUNT_MISMATCH', message: 'billing account does not match principal' }, 403)
      }
      return account
    }

    if (!params.billingAccountId) {
      throw new HttpException({ code: 'AUTH.MISSING_BILLING_ACCOUNT', message: 'billing_account_id missing' }, 401)
    }

    const result = await pool.query(
      `
      select billing_account_id, realm_id, billing_principal_id, metadata
      from billing_accounts
      where realm_id = $1
        and billing_account_id = $2
      limit 1
      `,
      [params.realmId, params.billingAccountId],
    )
    const row = result.rows[0]
    if (!row?.billing_account_id) {
      throw new HttpException({ code: 'AUTH.BILLING_ACCOUNT_NOT_FOUND', message: 'billing account not found' }, 404)
    }
    return {
      realmId: params.realmId,
      billingAccountId: String(row.billing_account_id),
      billingPrincipalId: String(row.billing_principal_id),
      metadata: (row.metadata as Record<string, unknown> | null) ?? undefined,
    }
  }

  private async resolveBillingUser(params: {
    realmId: string
    billingAccountId: string
    billingUserId: string
    userId: string
    autoCreate: boolean
    ctx?: Record<string, unknown>
  }): Promise<BillingUserResolution> {
    if (params.userId) {
      const billingUser = await ensureBillingUser({
        realmId: params.realmId,
        billingAccountId: params.billingAccountId,
        userId: params.userId,
        autoCreate: params.autoCreate,
        ctx: params.ctx,
      })
      if (!billingUser) {
        throw new HttpException({ code: 'AUTH.BILLING_USER_NOT_FOUND', message: 'billing user not found' }, 404)
      }
      if (params.billingUserId && billingUser.billingUserId !== params.billingUserId) {
        throw new HttpException({ code: 'AUTH.BILLING_USER_MISMATCH', message: 'billing user does not match user id' }, 403)
      }
      return billingUser
    }

    if (!params.billingUserId) {
      throw new HttpException({ code: 'AUTH.MISSING_BILLING_USER', message: 'billing_user_id missing' }, 401)
    }

    const result = await pool.query(
      `
      select billing_user_id, realm_id, billing_account_id, business_user_id, status, metadata
      from billing_users
      where realm_id = $1
        and billing_account_id = $2
        and billing_user_id = $3
      limit 1
      `,
      [params.realmId, params.billingAccountId, params.billingUserId],
    )
    const row = result.rows[0]
    if (!row?.billing_user_id) {
      throw new HttpException({ code: 'AUTH.BILLING_USER_NOT_FOUND', message: 'billing user not found' }, 404)
    }
    return {
      realmId: params.realmId,
      billingUserId: String(row.billing_user_id),
      billingAccountId: String(row.billing_account_id),
      businessUserId: String(row.business_user_id),
      status: row.status as BillingUserResolution['status'],
      metadata: (row.metadata as Record<string, unknown> | null) ?? undefined,
    }
  }

  private getHeader(headers: AppRequest['headers'], name: string): string | undefined {
    const raw = headers?.[name.toLowerCase() as keyof AppRequest['headers']] ?? headers?.[name as keyof AppRequest['headers']]
    if (typeof raw === 'string') return raw.trim()
    if (Array.isArray(raw)) return raw.join(',').trim()
    return undefined
  }
}
