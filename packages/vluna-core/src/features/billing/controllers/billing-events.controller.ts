import { Body, Controller, HttpException, Inject, Post, Req, Res, UseGuards, UseInterceptors } from '@nestjs/common'
import type { FastifyReply } from 'fastify'
import { RealmGuard } from '../../../auth/guards/realm.guard.js'
import { IdempotencyInterceptor } from '../../../support/idempotency.interceptor.js'
import { okEnvelope } from '../../../common/envelope.js'
import { ServiceAuthGuard } from '../../../auth/guards/service-auth.guard.js'
import { ServiceRuntimeUserGuard } from '../../../auth/guards/service-runtime-user.guard.js'
import { AuthRequiredGuard } from '../../../auth/guards/auth-required.guard.js'
import { TokenClaimsGuard } from '../../../auth/guards/token-claims.guard.js'
import { RealmMembershipGuard } from '../../../auth/guards/realm-membership.guard.js'
import type { AppRequest } from '../../../types/app-request.js'
import type { operations as BillingOps, components as BillingComponents } from '../../../contracts/billing.js'
import { JsonRequestBody, JsonResponse } from '../../../contracts/openapi-helpers.js'
import { BillingEventsError, BillingEventsService, type BatchIngestItemInput } from '../services/billing-events.service.js'
import { EventToRatingsService } from '../services/event-to-ratings.service.js'

// OpenAPI mapping: tag=Events
// Paths:
// - POST /events        (operationId: recordBillingEvent)
// - POST /events/batch  (operationId: recordBillingEventBatch)

type BillingEventBody = JsonRequestBody<BillingOps, 'recordBillingEvent'>
type BillingEventEnvelope = JsonResponse<BillingOps, 'recordBillingEvent', 200>
type BatchBody = JsonRequestBody<BillingOps, 'recordBillingEventBatch'>
type Batch207 = JsonResponse<BillingOps, 'recordBillingEventBatch', 207>

@Controller()
@UseGuards(RealmGuard, AuthRequiredGuard, ServiceAuthGuard, TokenClaimsGuard, RealmMembershipGuard, ServiceRuntimeUserGuard)
export class BillingEventsController {
  constructor(@Inject(EventToRatingsService) private readonly eventToRatingsService: EventToRatingsService) {}

  // POST /events — 201 Created (or 200 on replay)
  @Post('events')
  @UseInterceptors(IdempotencyInterceptor)
  async recordBillingEvent(
    @Req() req: AppRequest,
    @Res() res: FastifyReply,
    @Body() body: BillingEventBody,
  ): Promise<BillingEventEnvelope> {
    const realmId = req.ctx?.realmId
    const ctxUser = req.ctx?.billingUserId
    const ctxAccount = req.ctx?.billingAccountId
    const db = req.ctx?.db
    if (!ctxUser || !ctxAccount) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'billing_user_id and billing_account_id are required' }, 422)
    }
    if (!db) {
      throw new HttpException({ code: 'SERVER.CONFIG', message: 'database unavailable' }, 500)
    }

    const { created, event } = await BillingEventsService.ingestEvent(db, realmId, {
      ...body,
      billing_user_id: ctxUser,
      billing_account_id: ctxAccount,
    }, body?.labels)

    if (created && realmId) {
      await this.eventToRatingsService.enqueueEvent(db, {
        realmId,
        billingUserId: ctxUser,
        billingAccountId: ctxAccount,
        eventId: String(event.event_id),
      })
      await this.eventToRatingsService.processSingleEventIfEnabledFromApi(db, {
        realmId,
        billingUserId: ctxUser,
        billingAccountId: ctxAccount,
        eventId: String(event.event_id),
      })
    }

    const payload = okEnvelope(event) as BillingEventEnvelope
    const status = created ? 201 : 200
    try {
      await res.status(status).send(payload)
    } catch {}
    return payload
  }

  // POST /events/batch — 207 Multi-Status
  @Post('events/batch')
  @UseInterceptors(IdempotencyInterceptor)
  async recordBillingEventBatch(
    @Req() req: AppRequest,
    @Res() res: FastifyReply,
    @Body() body: BatchBody,
  ): Promise<Batch207> {
    const realmId = req.ctx?.realmId
    const db = req.ctx?.db
    const incoming = Array.isArray(body?.events) ? body.events : []
    const results: BillingComponents['schemas']['BillingEventBatchItemResult'][] = []
    let acceptedCount = 0
    let failedCount = 0
    const pending: BatchIngestItemInput[] = []
    const ctxUser = req.ctx?.billingUserId
    const ctxAccount = req.ctx?.billingAccountId

    if (!ctxUser || !ctxAccount) {
      throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: 'billing_user_id and billing_account_id are required' }, 422)
    }
    if (!db) {
      throw new HttpException({ code: 'SERVER.CONFIG', message: 'database unavailable' }, 500)
    }

    for (let index = 0; index < incoming.length; index += 1) {
      const rawEvent = incoming[index] || ({} as BillingEventBody)
      pending.push({
        index,
        payload: { ...rawEvent, billing_user_id: ctxUser, billing_account_id: ctxAccount },
        labels: rawEvent?.labels,
      })
    }

    if (pending.length > 0) {
      try {
        const summary = await BillingEventsService.ingestEventsBatch(db, realmId, pending)
        results.push(...summary.results)
        acceptedCount += summary.acceptedCount
        failedCount += summary.failedCount

        if (realmId) {
          for (const item of summary.results) {
            if (item.status !== 'accepted' || !item.event_id) continue
            await this.eventToRatingsService.enqueueEvent(db, {
              realmId,
              billingUserId: ctxUser,
              billingAccountId: ctxAccount,
              eventId: String(item.event_id),
            })
          }
        }
      } catch (err) {
        if (err instanceof BillingEventsError) {
          for (const item of pending) {
            if (err.batchStatus === 'invalid' || err.batchStatus === 'failed') {
              failedCount += 1
            }
            results.push({
              index: item.index,
              status: err.batchStatus,
              error: { code: err.errorCode, message: err.message },
            })
          }
        } else {
          failedCount += pending.length
          for (const item of pending) {
            results.push({
              index: item.index,
              status: 'failed',
              error: { code: 'SERVER.UNEXPECTED', message: 'unexpected error' },
            })
          }
        }
      }
    }

    results.sort((a, b) => (a.index ?? 0) - (b.index ?? 0))

    const payload = okEnvelope({ results, accepted_count: acceptedCount, failed_count: failedCount }) as Batch207
    try {
      await res.status(207).send(payload)
    } catch {}
    return payload
  }
}
