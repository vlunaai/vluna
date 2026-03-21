import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { FastifyReply } from 'fastify'
import { catchError, from, map, mergeMap, Observable, throwError } from 'rxjs'
import type { AppRequest } from '../../types/app-request.js'
import { isAuditEnabled } from '../../config/audit.js'
import { AUDIT_METADATA_KEY } from './audit.constants.js'
import { redactAuditValue } from './audit.redaction.js'
import {
  resolveAuditAction,
  resolveAuditActor,
  resolveAuditErrorCode,
  resolveAuditHttpStatus,
  resolveAuditRouteTemplate,
  resolveAuditScope,
  resolveAuditStatus,
  resolveAuditTargetId,
} from './audit.resolver.js'
import type { AuditOptions, AuditValueResolverContext } from './audit.types.js'
import { AuditWriter } from './audit.writer.js'

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly auditWriter: AuditWriter,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!isAuditEnabled()) {
      return next.handle()
    }
    if (context.getType() !== 'http') {
      return next.handle()
    }

    const options = this.reflector.getAllAndOverride<AuditOptions | undefined>(AUDIT_METADATA_KEY, [
      context.getHandler(),
      context.getClass(),
    ]) ?? resolveAuditMetadataFallback(context)
    if (!options || options.disable) {
      return next.handle()
    }

    const req = context.switchToHttp().getRequest<AppRequest>()
    const reply = context.switchToHttp().getResponse<FastifyReply>()

    return next.handle().pipe(
      mergeMap((responseBody) =>
        from(this.safeWriteAudit(options, req, reply, { req, reply, responseBody })).pipe(map(() => responseBody)),
      ),
      catchError((error) =>
        from(this.safeWriteAudit(options, req, reply, { req, reply, error })).pipe(
          mergeMap(() => throwError(() => error)),
        ),
      ),
    )
  }

  private async safeWriteAudit(
    options: AuditOptions,
    req: AppRequest,
    reply: FastifyReply,
    resolverContext: AuditValueResolverContext,
  ) {
    try {
      await this.writeAudit(options, req, reply, resolverContext)
    } catch (error) {
      console.warn('[audit] interceptor write failed', error)
    }
  }

  private async writeAudit(
    options: AuditOptions,
    req: AppRequest,
    reply: FastifyReply,
    resolverContext: AuditValueResolverContext,
  ) {
    const action = resolveAuditAction(options.action, resolverContext)
    if (!action) return

    const httpStatus = resolveAuditHttpStatus(reply, resolverContext.error)
    const status = resolveAuditStatus(options, resolverContext, httpStatus)
    const actor = resolveAuditActor(req)
    const scope = resolveAuditScope(req)
    const routeTemplate = resolveAuditRouteTemplate(req)
    const explicitRedactions = options.redact ?? []

    await this.auditWriter.write(
      {
        scopeType: scope.scopeType,
        realmId: scope.realmId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        actorDisplay: actor.actorDisplay,
        authScheme: req.ctx?.authScheme,
        action,
        targetType: options.targetType,
        targetId: resolveAuditTargetId(options, resolverContext),
        operationId: options.operationId,
        method: String(req.method || 'UNKNOWN').toUpperCase(),
        path: resolveRequestPath(req),
        routeTemplate,
        status,
        httpStatus,
        errorCode: resolveAuditErrorCode(resolverContext.error, resolverContext.responseBody),
        traceId: req.ctx?.traceId,
        paramsJson: redactAuditValue(req.params, filterRedactions(explicitRedactions, 'params')),
        queryJson: redactAuditValue(req.query, filterRedactions(explicitRedactions, 'query')),
        bodyJsonRedacted: redactAuditValue(req.body, filterRedactions(explicitRedactions, 'body')),
        metadata: {
          plane: req.ctx?.plane ?? null,
          billing_account_id: req.ctx?.billingAccountId ?? null,
          is_realm_admin: req.ctx?.isRealmAdmin === true,
          request_source: 'http',
        },
      },
      req.ctx?.db,
    )
  }
}

function resolveAuditMetadataFallback(context: ExecutionContext): AuditOptions | undefined {
  const handler = context.getHandler()
  const classRef = context.getClass()
  const direct = Reflect.getMetadata(AUDIT_METADATA_KEY, handler) as AuditOptions | undefined
  if (direct) return direct

  const handlerName = typeof handler?.name === 'string' ? handler.name : ''
  if (!handlerName || !classRef?.prototype) return undefined
  return Reflect.getMetadata(AUDIT_METADATA_KEY, classRef.prototype[handlerName]) as AuditOptions | undefined
}

function filterRedactions(paths: string[], prefix: 'params' | 'query' | 'body'): string[] {
  return paths
    .map((path) => String(path || '').trim())
    .filter((path) => path.startsWith(`${prefix}.`))
    .map((path) => path.slice(prefix.length + 1))
}

function resolveRequestPath(req: AppRequest): string {
  return String(
    (req as unknown as { originalUrl?: string }).originalUrl ??
      (req as unknown as { url?: string }).url ??
      '',
  )
}
