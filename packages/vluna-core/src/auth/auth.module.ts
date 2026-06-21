import { Module } from '@nestjs/common'
import { TokensModule } from './tokens/tokens.module.js'
import { TokenClaimsGuard } from './guards/token-claims.guard.js'
import { RealmGuard } from './guards/realm.guard.js'
import { ProviderAccountGuard } from './guards/provider-account.guard.js'
import { PrincipalGuard } from './guards/principal.guard.js'
import { BillingAccountGuard } from './guards/billing-account.guard.js'
import { OptionalBillingAccountGuard } from './guards/optional-billing-account.guard.js'
import { ServiceAuthGuard } from './guards/service-auth.guard.js'
import { ServiceAccountGuard } from './guards/service-account.guard.js'
import { ServiceRuntimeUserGuard } from './guards/service-runtime-user.guard.js'
import { SecurityModule } from '../security/security.module.js'
import { AuthRequiredGuard } from './guards/auth-required.guard.js'
import { OptionalRealmGuard } from './guards/optional-realm.guard.js'
import { RealmMembershipGuard } from './guards/realm-membership.guard.js'

@Module({
  imports: [TokensModule, SecurityModule],
  providers: [AuthRequiredGuard, TokenClaimsGuard, RealmGuard, OptionalRealmGuard, ProviderAccountGuard, PrincipalGuard, BillingAccountGuard, OptionalBillingAccountGuard, RealmMembershipGuard, ServiceAuthGuard, ServiceAccountGuard, ServiceRuntimeUserGuard],
  // Export guards and the TokensModule so downstream modules have TOKEN_VALIDATOR in their injector
  exports: [AuthRequiredGuard, TokenClaimsGuard, RealmGuard, OptionalRealmGuard, ProviderAccountGuard, PrincipalGuard, BillingAccountGuard, OptionalBillingAccountGuard, RealmMembershipGuard, ServiceAuthGuard, ServiceAccountGuard, ServiceRuntimeUserGuard, TokensModule, SecurityModule],
})
export class AuthModule {}
