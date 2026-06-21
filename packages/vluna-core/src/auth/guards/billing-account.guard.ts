import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common'
import type { AppRequest } from '../../types/app-request.js'
import { RequestContext } from '../../types/request-context.js'
import { detectAuthScheme } from '../utils/auth-scheme.js'
import { ensureBillingAccount } from '../../security/principal/billing-account.resolver.js'

@Injectable()
export class BillingAccountGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AppRequest>()
    req.ctx = req.ctx || ({} as RequestContext)

    if (req.ctx.billingAccountId) {
      return true
    }
    const claimsBillingAccount = this.extractBillingAccountFromClaims(req)
    if (claimsBillingAccount) {
      req.ctx.billingAccountId = claimsBillingAccount
      return true
    }

    const scheme = req.ctx.authScheme ?? detectAuthScheme(req.headers?.authorization as string | undefined)
    if (scheme && scheme !== 'bearer') {
      return true
    }

    const realmId = String(req?.ctx?.realmId || '').trim()
    const principal = req?.ctx?.principal
    if (!realmId) throw new HttpException('missing_realm', 400)
    if (!principal?.id) throw new HttpException('missing_principal', 401)
    const resolution = await ensureBillingAccount({ realmId, principalId: principal.id, ctx: req.ctx })
    if (!resolution) {
      throw new HttpException('billing_account_not_found', 404)
    }
    req.ctx.billingAccountId = resolution.billingAccountId
    req.ctx.billingAccount = resolution
    return true
  }

  private extractBillingAccountFromClaims(req: AppRequest): string | null {
    const claims = req?.ctx?.claims
    if (!claims || typeof claims !== 'object') return null
    const payload = claims as Record<string, unknown>
    const tokenUse = typeof payload.token_use === 'string' ? payload.token_use.toLowerCase() : typeof payload.tu === 'string' ? payload.tu.toLowerCase() : undefined
    if (tokenUse !== 'platform' && tokenUse !== 'plt' && tokenUse !== 'vluna' && tokenUse !== 'apt') return null
    const billingAccountId = String(payload.billing_account_id || '').trim()
    return billingAccountId || null
  }
}
