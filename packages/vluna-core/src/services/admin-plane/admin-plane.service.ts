export const ADMIN_PLANE_SERVICE = Symbol('ADMIN_PLANE_SERVICE')

export type RealmSlotAuthorizeInput = {
  runtimeRealmId: string
  billingAccountId?: string
  principalId: string
  userId: string
  requestId?: string
  labels?: Record<string, unknown>
}

export type RealmSlotAuthorizeResult = {
  leaseToken: string
}

export type RealmSlotCommitInput = {
  runtimeRealmId: string
  billingAccountId?: string
  principalId: string
  userId: string
  leaseToken: string
  quantityMinor?: string
  requestId?: string
  labels?: Record<string, unknown>
}

export type RealmSlotCancelInput = {
  runtimeRealmId: string
  billingAccountId?: string
  principalId: string
  userId: string
  leaseToken: string
  requestId?: string
  labels?: Record<string, unknown>
}

export type RealmSlotRevokeInput = {
  runtimeRealmId: string
  billingAccountId?: string
  principalId: string
  userId: string
  requestId?: string
}

export interface AdminPlaneService {
  authorizeRealmSlot(input: RealmSlotAuthorizeInput): Promise<RealmSlotAuthorizeResult>
  commitRealmSlot(input: RealmSlotCommitInput): Promise<void>
  cancelRealmSlot(input: RealmSlotCancelInput): Promise<void>
  revokeRealmSlot(input: RealmSlotRevokeInput): Promise<void>
}
