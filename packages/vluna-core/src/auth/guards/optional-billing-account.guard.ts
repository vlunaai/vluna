import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common'
import type { AppRequest } from '../../types/app-request.js'
import { detectAuthScheme } from '../utils/auth-scheme.js'
import { ensureBillingAccount } from '../../security/principal/billing-account.resolver.js'

@Injectable()
export class OptionalBillingAccountGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AppRequest>()
    req.ctx = req.ctx || {}

    if (req.ctx.billingAccountId) {
      return true
    }

    const scheme = req.ctx.authScheme ?? detectAuthScheme(req.headers?.authorization as string | undefined)
    if (scheme && scheme !== 'bearer') {
      return true
    }

    const realmId = String(req?.ctx?.realmId || '').trim()
    const principal = req?.ctx?.principal
    if (!realmId || !principal?.id) {
      return true
    }
    const resolution = await ensureBillingAccount({ realmId, principalId: principal.id, autoCreate: false, ctx: req.ctx })

    if (resolution?.billingAccountId) {
      req.ctx.billingAccountId = resolution.billingAccountId
      req.ctx.billingAccount = resolution
    }

    return true
  }
}
