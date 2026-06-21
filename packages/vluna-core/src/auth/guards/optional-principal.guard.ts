import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common'
import { resolvePrincipal } from '../../security/principal/principal.resolver.js'
import type { AppRequest } from '../../types/app-request.js'
import { detectAuthScheme } from '../utils/auth-scheme.js'

@Injectable()
export class OptionalPrincipalGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AppRequest>()
    req.ctx = req.ctx || {}
    if (req.ctx.principal?.id) {
      return true
    }
    const platformPrincipal = this.extractPlatformPrincipal(req)
    if (platformPrincipal) {
      req.ctx.principal = platformPrincipal
      return true
    }
    const scheme = req.ctx.authScheme ?? detectAuthScheme(req.headers?.authorization as string | undefined)
    if (scheme && scheme !== 'bearer') {
      return true
    }
    const claims = req?.ctx?.claims
    if (!claims) return true

    const realmId = String(req?.ctx?.realmId || req?.headers?.['x-realm-id'] || '') || undefined
    try {
      const principal = await resolvePrincipal({ realmId }, claims)
      req.ctx.principal = { id: principal.id, type: principal.type }
    } catch {
      // ignore failures; optional guard should not raise
    }

    return true
  }

  private extractPlatformPrincipal(req: AppRequest): { id: string; source?: string; type?: string } | null {
    const claims = req?.ctx?.claims
    if (!claims || typeof claims !== 'object') return null
    const payload = claims as Record<string, unknown>
    const tokenUse = typeof payload.tu === 'string' ? payload.tu.toLowerCase() : undefined
    if (tokenUse !== 'plt' && tokenUse !== 'apt' && tokenUse !== 'platform' && tokenUse !== 'vluna') return null
    const principalId = String(payload.billing_principal_id || payload.principal_id || '').trim()
    if (!principalId) return null
    return { id: principalId, type: 'platform' }
  }
}
