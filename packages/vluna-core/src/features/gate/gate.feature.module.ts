import { Module } from '@nestjs/common'
import { AuthModule } from '../../auth/auth.module.js'
import { GateController } from './controllers/gate.controller.js'
import { GatePolicyBundlesController } from './controllers/gate-policy-bundles.controller.js'
import { GatePoliciesController } from './controllers/gate-policies.controller.js'
import { GateService } from './services/gate.service.js'
import { BudgetService } from '../../services/budget.service.js'
import { LeaseService } from './services/lease.service.js'
import { PricingService } from './services/pricing.service.js'
import { QuotaService } from './services/quota.service.js'
import { SettlementService } from './services/settlement.service.js'
import { GateIdempotencyService } from './services/idempotency.service.js'
import { GrantBalanceService } from '../../services/grant-balance.service.js'
import { BillingPeriodService } from '../../services/billing-period.service.js'
import { GatePolicyBundlesService } from './services/gate-policy-bundles.service.js'
import { GatePoliciesService } from './services/gate-policies.service.js'

@Module({
  imports: [AuthModule],
  controllers: [GateController, GatePolicyBundlesController, GatePoliciesController],
  providers: [GateService, GatePolicyBundlesService, GatePoliciesService, BudgetService, LeaseService, PricingService, QuotaService, SettlementService, GateIdempotencyService, GrantBalanceService, BillingPeriodService],
  exports: [GateService, SettlementService],
})
export class GateFeatureModule {}
