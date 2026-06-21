import type { TokenClaims } from '../auth/tokens/token.types.js'
import type { ManagementUser } from './user.types.js'
import type { Kysely } from 'kysely'
import type { Database } from './database.js'
import type { RealmAuthProfile } from '../security/realm-config.service.js'
import type { McpSessionClaims } from '../features/mcp/types/session.js'
import type { DatBootstrapPrincipal } from '../auth/policies/dat-authorization.policy.js'
import type { DatSessionClaims } from '../features/dat/types/session.js'
export type RequestContext = {
  authScheme?: 'service' | 'bearer'
  // Trace identifiers
  traceId?: string
  // Plane markers
  plane?: string
  isAdminPlane?: boolean
  // Subject and identities
  sub?: string
  userId?: string
  // Realm / tenant markers
  realmId?: string
  realmConfig?: {
    realmId: string
    paymentProvider: string
    auth?: RealmAuthProfile | null
    billingDefaultsPeriod?: Record<string, unknown> | null
    realmAccessAllowlist?: string[]
  }
  // JWT claims for the current request
  claims?: TokenClaims
  // Marker for pre-verified claims (e.g., via external policy)
  claimsVerified?: boolean
  // Normalized principal for billing/session mapping
  principal?: { id: string; type?: string }
  // Allow bearer tokens to act as service access (edition-specific policy)
  serviceAccessAllowed?: boolean
  // User profile fetched from IdP (management API)
  user?: ManagementUser
  // Derived billing account identifier (server-side mapping)
  billingAccountId?: string
  // Derived runtime billing user identifier (server-side mapping)
  billingUserId?: string
  // External business user identifier supplied by API/SDK callers.
  businessUserId?: string
  // Realm-level admin (trusted guards only)
  isRealmAdmin?: boolean
  billingAccount?: {
    billingAccountId: string
    principalId?: string
    realmId: string
    metadata?: Record<string, unknown>
  }
  billingUser?: {
    billingUserId: string
    billingAccountId: string
    businessUserId: string
    realmId: string
    status?: 'active' | 'disabled' | 'deleted'
    metadata?: Record<string, unknown>
  }
  // Version markers for permissions change detection
  versionToken?: string
  versionUser?: string
  // Idempotency key for write operations (if present)
  idempotencyKey?: string
  // Request-scoped DB transaction handle (Kysely)
  db?: Kysely<Database>
  // Service API key metadata when authenticated via TAP service signatures
  serviceApiKey?: {
    keyId: string
    status: string
    envTag: string
    scopes: string[]
    allowedRealms: string[]
    allowedAccounts: string[]
    signature: {
      timestampISO: string
      nonce: string
      algorithm: 'HMAC-SHA256'
    }
    canonicalRequest: string
  }
  serviceAuthBinding?: {
    principalId?: string
    userId?: string
    billingAccountId?: string
    billingUserId?: string
  }
  platformToken?: {
    scopes: string[]
    version: number
    issuedBy?: string
  }
  // MCP session token claims used by mcp-prefixed management APIs.
  mcpSession?: McpSessionClaims
  // DAT bootstrap token principal for /dat/session/* issue/revoke/introspect flows.
  datBootstrap?: DatBootstrapPrincipal
  // DAT session issue auth mode (bootstrap for OSS, oauth for Cloud remote ingress).
  datAuthMode?: 'bootstrap' | 'oauth'
  // DAT access token claims for future management access enforcement.
  datSession?: DatSessionClaims
  // Marker for DAT bearer access accepted by policy.
  datAccessAllowed?: boolean
}
