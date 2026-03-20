// Canonical billing domain events
export const BILLING_USER_PROMOTED = 'billing.user.promoted'

export type BillingUserPromotedPayload = {
  userId: string
  realmId: string
  displayName?: string
  // optional marker fields for tracing/debug
  traceId?: string
  source?: string // e.g., 'stripe.checkout.session.completed'
}
