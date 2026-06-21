import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common'
import { RealmGuard } from '../../../auth/guards/realm.guard.js'
import { TokenClaimsGuard } from '../../../auth/guards/token-claims.guard.js'
import type { AppRequest } from '../../../types/app-request.js'
import type { operations as BillingOps } from '../../../contracts/billing.js'
import { JsonResponse, QueryParams } from '../../../contracts/openapi-helpers.js'
import { OptionalPrincipalGuard } from '../../../auth/guards/optional-principal.guard.js'
import { OptionalBillingAccountGuard } from '../../../auth/guards/optional-billing-account.guard.js'
import { AuthRequiredGuard } from '../../../auth/guards/auth-required.guard.js'
import { ServiceAuthGuard } from '../../../auth/guards/service-auth.guard.js'
import { ServiceAccountGuard } from '../../../auth/guards/service-account.guard.js'
import { RealmMembershipGuard } from '../../../auth/guards/realm-membership.guard.js'
import { CatalogApiService } from '../services/catalog-api.service.js'

// OpenAPI mapping: tag=Catalog
// Paths:
// - GET /catalog/products (operationId: listCatalogProducts)
// - GET /catalog/prices   (operationId: listCatalogPrices)

type ListProductsQuery = QueryParams<BillingOps, 'listCatalogProducts'>
type ListProducts200 = JsonResponse<BillingOps, 'listCatalogProducts', 200>
type ListPricesQuery = QueryParams<BillingOps, 'listCatalogPrices'>
type ListPrices200 = JsonResponse<BillingOps, 'listCatalogPrices', 200>

@Controller('catalog')
@UseGuards(RealmGuard, TokenClaimsGuard, RealmMembershipGuard, OptionalPrincipalGuard, OptionalBillingAccountGuard)
export class CatalogPublicController {
  constructor(private readonly catalogApi: CatalogApiService) {}

  @Get('products')
  async listCatalogProducts(@Req() req: AppRequest, @Query() q: ListProductsQuery): Promise<ListProducts200> {
    return this.catalogApi.listCatalogProducts({
      realmId: req?.ctx?.realmId || '',
      billingAccountId: req?.ctx?.billingAccountId || '',
      db: req?.ctx?.db,
      query: q,
    })
  }

  @Get('prices')
  async listCatalogPrices(@Req() req: AppRequest, @Query() q: ListPricesQuery): Promise<ListPrices200> {
    return this.catalogApi.listCatalogPrices({
      realmId: req?.ctx?.realmId || '',
      billingAccountId: req?.ctx?.billingAccountId || '',
      db: req?.ctx?.db,
      query: q,
    })
  }
}

@Controller('catalog')
@UseGuards(RealmGuard, AuthRequiredGuard, ServiceAuthGuard, TokenClaimsGuard, RealmMembershipGuard, ServiceAccountGuard, OptionalPrincipalGuard, OptionalBillingAccountGuard)
export class CatalogServiceController {
  constructor(private readonly catalogApi: CatalogApiService) {}

  @Get('products')
  async listCatalogProducts(@Req() req: AppRequest, @Query() q: ListProductsQuery): Promise<ListProducts200> {
    return this.catalogApi.listCatalogProducts({
      realmId: req?.ctx?.realmId || '',
      billingAccountId: req?.ctx?.billingAccountId || '',
      db: req?.ctx?.db,
      query: q,
    })
  }

  @Get('prices')
  async listCatalogPrices(@Req() req: AppRequest, @Query() q: ListPricesQuery): Promise<ListPrices200> {
    return this.catalogApi.listCatalogPrices({
      realmId: req?.ctx?.realmId || '',
      billingAccountId: req?.ctx?.billingAccountId || '',
      db: req?.ctx?.db,
      query: q,
    })
  }
}
