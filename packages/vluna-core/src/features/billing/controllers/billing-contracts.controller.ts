import { Body, Controller, Get, HttpException, Inject, Param, Post, Query, Req, Res, UseGuards, UseInterceptors } from '@nestjs/common'
import type { FastifyReply } from 'fastify'
import { RealmGuard } from '../../../auth/guards/realm.guard.js'
import { AuthRequiredGuard } from '../../../auth/guards/auth-required.guard.js'
import { RequireServiceAuthGuard } from '../../../auth/guards/require-service-auth.guard.js'
import { ServiceAuthGuard } from '../../../auth/guards/service-auth.guard.js'
import { ServiceAccountGuard } from '../../../auth/guards/service-account.guard.js'
import { TokenClaimsGuard } from '../../../auth/guards/token-claims.guard.js'
import { RealmMembershipGuard } from '../../../auth/guards/realm-membership.guard.js'
import { PrincipalGuard } from '../../../auth/guards/principal.guard.js'
import { PrincipalBillingAccountGuard } from '../../../auth/guards/principal-billing-account.guard.js'
import { IdempotencyInterceptor } from '../../../support/idempotency.interceptor.js'
import { Audit } from '../../../support/audit/audit.decorator.js'
import type { AppRequest } from '../../../types/app-request.js'
import type { operations as BillingOps } from '../../../contracts/billing-mgt.js'
import { JsonRequestBody, JsonResponse, QueryParams } from '../../../contracts/openapi-helpers.js'
import { okEnvelope } from '../../../common/envelope.js'
import { Scopes } from '../../../auth/decorators/scopes.decorator.js'
import { BILLING_SCOPES } from '../../../auth/constants/scopes.constants.js'
import { BillingContractsService } from '../services/billing-contracts.service.js'

// OpenAPI mapping: tag=Contracts
// Paths:
// - GET  /contracts                 (operationId: listBillingContracts)
// - POST /contracts                 (operationId: upsertBillingContract)
// - GET  /contracts/{contract_id}   (operationId: getBillingContract)
// - POST /contracts/{contract_id}   (operationId: updateBillingContract)
// - GET  /contracts/{contract_id}/terms  (operationId: listContractTerms)
// - POST /contracts/{contract_id}/terms  (operationId: upsertContractTerm)

type ListContractsQuery = QueryParams<BillingOps, 'listBillingContracts'>
type ListContracts200 = JsonResponse<BillingOps, 'listBillingContracts', 200>
type UpsertContractBody = JsonRequestBody<BillingOps, 'upsertBillingContract'>
type UpsertContract201 = JsonResponse<BillingOps, 'upsertBillingContract', 201>
type UpsertContract200 = JsonResponse<BillingOps, 'upsertBillingContract', 200>
type GetContract200 = JsonResponse<BillingOps, 'getBillingContract', 200>
type UpdateContractBody = JsonRequestBody<BillingOps, 'updateBillingContract'>
type UpdateContract200 = JsonResponse<BillingOps, 'updateBillingContract', 200>
type ListTermsQuery = QueryParams<BillingOps, 'listContractTerms'>
type ListTerms200 = JsonResponse<BillingOps, 'listContractTerms', 200>
type UpsertTermBody = JsonRequestBody<BillingOps, 'upsertContractTerm'>
type UpsertTerm201 = JsonResponse<BillingOps, 'upsertContractTerm', 201>
type UpsertTerm200 = JsonResponse<BillingOps, 'upsertContractTerm', 200>

// Relaxed UUID shape check (accepts nil UUID and other "pretty" UUIDs).
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function parseUuid(value: string, name: string): string {
  const trimmed = String(value || '').trim()
  if (!trimmed || !UUID_RE.test(trimmed)) {
    throw new HttpException({ code: 'VALIDATION.INVALID_INPUT', message: `invalid ${name}` }, 422)
  }
  return trimmed
}

@Controller()
@UseGuards(
  RealmGuard,
  AuthRequiredGuard,
  ServiceAuthGuard,
  ServiceAccountGuard,
  TokenClaimsGuard,
  RealmMembershipGuard,
  PrincipalGuard,
  PrincipalBillingAccountGuard,
)
export class BillingContractsController {
  constructor(@Inject(BillingContractsService) private readonly contractsService: BillingContractsService) {}

  @Get('contracts')
  @Scopes(BILLING_SCOPES.READ_ALL)
  async listBillingContracts(@Req() req: AppRequest, @Query() query: ListContractsQuery): Promise<ListContracts200> {
    const data = await this.contractsService.listBillingContracts(req, (query ?? {}) as Record<string, unknown>)
    return okEnvelope(data) as ListContracts200
  }

  @Post('contracts')
  @Scopes(BILLING_SCOPES.WRITE)
  @UseGuards(RequireServiceAuthGuard)
  @UseInterceptors(IdempotencyInterceptor)
  @Audit({
    action: ({ reply, error }) => {
      if (error) return 'billing_contract.upsert'
      return reply.statusCode === 201 ? 'billing_contract.create' : 'billing_contract.update'
    },
    operationId: 'upsertBillingContract',
    targetType: 'billing_contract',
    targetIdFrom: 'response.data.contract_id',
  })
  async upsertBillingContract(
    @Req() req: AppRequest,
    @Res() res: FastifyReply,
    @Body() body: UpsertContractBody,
  ): Promise<UpsertContract201 | UpsertContract200> {
    const { created, contract } = await this.contractsService.upsertBillingContract(req, body)
    const payload = okEnvelope(contract) as UpsertContract201
    const status = created ? 201 : 200
    try { await res.status(status).send(payload) } catch {}
    return payload
  }

  @Get('contracts/:contract_id')
  @Scopes(BILLING_SCOPES.READ_ALL)
  async getBillingContract(@Req() req: AppRequest, @Param('contract_id') contractIdParam: string): Promise<GetContract200> {
    const contractId = parseUuid(contractIdParam, 'contract_id')
    const data = await this.contractsService.getBillingContract(req, contractId)
    return okEnvelope(data) as GetContract200
  }

  @Post('contracts/:contract_id')
  @Scopes(BILLING_SCOPES.WRITE)
  @UseGuards(RequireServiceAuthGuard)
  @UseInterceptors(IdempotencyInterceptor)
  @Audit({
    action: 'billing_contract.update',
    operationId: 'updateBillingContract',
    targetType: 'billing_contract',
    targetIdFrom: 'params.contract_id',
  })
  async updateBillingContract(
    @Req() req: AppRequest,
    @Param('contract_id') contractIdParam: string,
    @Body() body: UpdateContractBody,
  ): Promise<UpdateContract200> {
    const contractId = parseUuid(contractIdParam, 'contract_id')
    const data = await this.contractsService.updateBillingContract(req, contractId, body ?? {})
    return okEnvelope(data) as UpdateContract200
  }

  @Get('contracts/:contract_id/terms')
  @Scopes(BILLING_SCOPES.READ_ALL)
  async listContractTerms(
    @Req() req: AppRequest,
    @Param('contract_id') contractIdParam: string,
    @Query() query: ListTermsQuery,
  ): Promise<ListTerms200> {
    const contractId = parseUuid(contractIdParam, 'contract_id')
    const data = await this.contractsService.listContractTerms(req, contractId, (query ?? {}) as Record<string, unknown>)
    return okEnvelope(data) as ListTerms200
  }

  @Post('contracts/:contract_id/terms')
  @Scopes(BILLING_SCOPES.WRITE)
  @UseGuards(RequireServiceAuthGuard)
  @UseInterceptors(IdempotencyInterceptor)
  @Audit({
    action: ({ reply, error }) => {
      if (error) return 'billing_contract_term.upsert'
      return reply.statusCode === 201 ? 'billing_contract_term.create' : 'billing_contract_term.update'
    },
    operationId: 'upsertContractTerm',
    targetType: 'billing_contract_term',
    targetIdFrom: ({ req, responseBody }) => {
      const params = (req.params ?? {}) as Record<string, unknown>
      const contractId = typeof params.contract_id === 'string' ? params.contract_id.trim() : ''
      const response = responseBody as { data?: { term_id?: unknown; contract_term_id?: unknown } } | undefined
      const termIdCandidate = response?.data?.term_id ?? response?.data?.contract_term_id
      const termId = typeof termIdCandidate === 'string' ? termIdCandidate.trim() : ''
      if (contractId && termId) return `${contractId}:${termId}`
      return termId || contractId || undefined
    },
  })
  async upsertContractTerm(
    @Req() req: AppRequest,
    @Res() res: FastifyReply,
    @Param('contract_id') contractIdParam: string,
    @Body() body: UpsertTermBody,
  ): Promise<UpsertTerm201 | UpsertTerm200> {
    const contractId = parseUuid(contractIdParam, 'contract_id')
    const { created, term } = await this.contractsService.upsertContractTerm(req, contractId, body)
    const payload = okEnvelope(term) as UpsertTerm201
    const status = created ? 201 : 200
    try { await res.status(status).send(payload) } catch {}
    return payload
  }
}
