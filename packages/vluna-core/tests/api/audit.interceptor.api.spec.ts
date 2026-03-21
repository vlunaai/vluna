import 'reflect-metadata'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpException } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { FastifyReply } from 'fastify'
import type { AppRequest } from '../../src/types/app-request.js'
import type { AuditOptions, AuditValueResolverContext } from '../../src/support/audit/audit.types.js'
import { AuditInterceptor } from '../../src/support/audit/audit.interceptor.js'

describe('AuditInterceptor', () => {
  const writeSpy = vi.fn(async () => undefined)
  const reflector = new Reflector()
  const interceptor = new AuditInterceptor(reflector, { write: writeSpy } as never)

  const prevAuditEnabled = process.env.VLUNA_AUDIT_ENABLED

  beforeEach(() => {
    process.env.VLUNA_AUDIT_ENABLED = 'true'
  })

  afterAll(() => {
    if (prevAuditEnabled === undefined) {
      delete process.env.VLUNA_AUDIT_ENABLED
      return
    }
    process.env.VLUNA_AUDIT_ENABLED = prevAuditEnabled
  })

  it('writes success audit rows with redacted body', async () => {
    writeSpy.mockClear()
    const request = createRequest({
      method: 'POST',
      body: { feature_id: 'feat_1', secret: 'super-secret', display_name: 'A' },
    })
    const reply = createReply(201)
    const options: AuditOptions = {
      action: 'feature.update',
      operationId: 'updateFeature',
      targetType: 'feature',
      targetIdFrom: 'body.feature_id',
      redact: ['body.secret'],
    }
    const resolverContext: AuditValueResolverContext = {
      req: request,
      reply,
      responseBody: { ok: true, code: 'OK', data: { feature_id: 'feat_1' } },
    }

    await (interceptor as unknown as { writeAudit: (options: AuditOptions, req: AppRequest, reply: FastifyReply, ctx: AuditValueResolverContext) => Promise<void> })
      .writeAudit(options, request, reply, resolverContext)

    expect(writeSpy).toHaveBeenCalledTimes(1)
    expect(writeSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        scopeType: 'realm',
        realmId: 'realm_a',
        actorType: 'service_key',
        actorId: 'pk_test',
        action: 'feature.update',
        targetType: 'feature',
        targetId: 'feat_1',
        operationId: 'updateFeature',
        status: 'success',
        httpStatus: 201,
        bodyJsonRedacted: {
          feature_id: 'feat_1',
          secret: '[REDACTED]',
          display_name: 'A',
        },
      }),
      undefined,
    )
  })

  it('writes failure audit rows from HttpException', async () => {
    writeSpy.mockClear()
    const request = createRequest({
      method: 'GET',
      query: { feature_id: 'feat_2' },
    })
    const reply = createReply(403)
    const error = new HttpException({ code: 'AUTH.UNAUTHORIZED_REALM', message: 'forbidden' }, 403)
    const options: AuditOptions = {
      action: 'feature.update',
      operationId: 'updateFeature',
      targetType: 'feature',
      targetIdFrom: 'query.feature_id',
    }

    await (interceptor as unknown as { writeAudit: (options: AuditOptions, req: AppRequest, reply: FastifyReply, ctx: AuditValueResolverContext) => Promise<void> })
      .writeAudit(options, request, reply, { req: request, reply, error })
    expect(writeSpy).toHaveBeenCalledTimes(1)
    expect(writeSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: 'feature.update',
        targetId: 'feat_2',
        status: 'failure',
        httpStatus: 403,
        errorCode: 'AUTH.UNAUTHORIZED_REALM',
      }),
      undefined,
    )
  })

  it('records reveal success only when plaintext is returned', async () => {
    writeSpy.mockClear()
    const successRequest = createRequest({
      method: 'GET',
      query: { token_id: 'dbt_1' },
    })
    const successReply = createReply(200)
    const options: AuditOptions = {
      action: 'dat_bootstrap_token.reveal',
      operationId: 'revealDatBootstrapToken',
      targetType: 'dat_bootstrap_token',
      targetIdFrom: 'query.token_id',
      successEvaluator: ({ responseBody }) => {
        const response = responseBody as { data?: { token?: unknown } } | undefined
        return typeof response?.data?.token === 'string' && response.data.token.length > 0
      },
    }

    await (interceptor as unknown as { writeAudit: (options: AuditOptions, req: AppRequest, reply: FastifyReply, ctx: AuditValueResolverContext) => Promise<void> })
      .writeAudit(options, successRequest, successReply, {
        req: successRequest,
        reply: successReply,
        responseBody: { ok: true, code: 'OK', data: { token_id: 'dbt_1', token: 'secret-value' } },
      })
    expect(writeSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: 'dat_bootstrap_token.reveal',
        targetId: 'dbt_1',
        status: 'success',
      }),
      undefined,
    )

    writeSpy.mockClear()
    const failureRequest = createRequest({
      method: 'GET',
      query: { token_id: 'dbt_1' },
    })
    const failureReply = createReply(200)
    await (interceptor as unknown as { writeAudit: (options: AuditOptions, req: AppRequest, reply: FastifyReply, ctx: AuditValueResolverContext) => Promise<void> })
      .writeAudit(options, failureRequest, failureReply, {
        req: failureRequest,
        reply: failureReply,
        responseBody: { ok: true, code: 'OK', data: { token_id: 'dbt_1', token_masked: 'datb_***' } },
      })
    expect(writeSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: 'dat_bootstrap_token.reveal',
        targetId: 'dbt_1',
        status: 'failure',
      }),
      undefined,
    )
  })
})

function createRequest(input: {
  method: string
  body?: Record<string, unknown>
  query?: Record<string, unknown>
}): AppRequest {
  return {
    method: input.method,
    url: '/mgt/v1/test',
    params: {},
    query: input.query ?? {},
    body: input.body ?? {},
    ctx: {
      traceId: 'trace-123',
      realmId: 'realm_a',
      authScheme: 'service',
      plane: 'control',
      serviceApiKey: {
        keyId: 'pk_test',
        status: 'active',
        envTag: 'test',
        scopes: [],
        allowedRealms: ['realm_a'],
        allowedAccounts: [],
        signature: {
          timestampISO: new Date().toISOString(),
          nonce: 'n1',
          algorithm: 'HMAC-SHA256',
        },
        canonicalRequest: 'canonical',
      },
    },
  } as unknown as AppRequest
}

function createReply(statusCode: number): FastifyReply {
  return { statusCode } as FastifyReply
}
