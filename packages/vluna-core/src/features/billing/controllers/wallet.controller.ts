import { Body, Controller, Get, Inject, Post, Query, Req, UseGuards, UseInterceptors } from '@nestjs/common'
import { RealmGuard } from '../../../auth/guards/realm.guard.js'
import { TokenClaimsGuard } from '../../../auth/guards/token-claims.guard.js'
import { Scopes } from '../../../auth/decorators/scopes.decorator.js'
import { BILLING_SCOPES } from '../../../auth/constants/scopes.constants.js'
import { PrincipalGuard } from '../../../auth/guards/principal.guard.js'
import { ServiceRuntimeUserGuard } from '../../../auth/guards/service-runtime-user.guard.js'
import type { AppRequest } from '../../../types/app-request.js'
import {
  WalletService,
  type GetBalance200,
  type GetBalanceQuery,
  type WalletAdjustment200,
  type WalletAdjustmentBody,
  type WalletConsume200,
  type WalletConsumeBody,
} from '../services/wallet.service.js'
import { AuthRequiredGuard } from '../../../auth/guards/auth-required.guard.js'
import { ServiceAuthGuard } from '../../../auth/guards/service-auth.guard.js'
import { IdempotencyInterceptor } from '../../../support/idempotency.interceptor.js'
import { RealmMembershipGuard } from '../../../auth/guards/realm-membership.guard.js'

abstract class WalletControllerBase {
  constructor(@Inject(WalletService) protected readonly walletService: WalletService) {}

  protected async handleGetWalletBalance(req: AppRequest, q: GetBalanceQuery): Promise<GetBalance200> {
    return this.walletService.getWalletBalance(req, q)
  }

  protected async handleConsume(req: AppRequest, body: WalletConsumeBody): Promise<WalletConsume200> {
    return this.walletService.consume(req, body)
  }

  protected async handleAdjustment(req: AppRequest, body: WalletAdjustmentBody): Promise<WalletAdjustment200> {
    return this.walletService.adjust(req, body)
  }
}

@Controller('wallet')
@UseGuards(RealmGuard, TokenClaimsGuard, RealmMembershipGuard, PrincipalGuard, ServiceRuntimeUserGuard)
export class WalletController extends WalletControllerBase {
  @Get('balance')
  @Scopes(BILLING_SCOPES.READ_ALL)
  async getWalletBalance(@Req() req: AppRequest, @Query() q: GetBalanceQuery): Promise<GetBalance200> {
    return this.handleGetWalletBalance(req, q)
  }
}

@Controller('wallet')
@UseGuards(RealmGuard, AuthRequiredGuard, ServiceAuthGuard, TokenClaimsGuard, RealmMembershipGuard, PrincipalGuard, ServiceRuntimeUserGuard)
export class WalletServiceController extends WalletControllerBase {
  @Get('balance')
  async getWalletBalance(@Req() req: AppRequest, @Query() q: GetBalanceQuery): Promise<GetBalance200> {
    return this.handleGetWalletBalance(req, q)
  }

  @Post('consume')
  @UseInterceptors(IdempotencyInterceptor)
  async consume(@Req() req: AppRequest, @Body() body: WalletConsumeBody): Promise<WalletConsume200> {
    return this.handleConsume(req, body)
  }

  @Post('adjustments')
  @UseInterceptors(IdempotencyInterceptor)
  async adjust(@Req() req: AppRequest, @Body() body: WalletAdjustmentBody): Promise<WalletAdjustment200> {
    return this.handleAdjustment(req, body)
  }
}
