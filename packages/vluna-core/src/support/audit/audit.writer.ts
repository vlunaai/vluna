import { Injectable } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import type { Kysely } from 'kysely'
import { isAuditEnabled } from '../../config/audit.js'
import { db } from '../../db/index.js'
import type { Database } from '../../types/database.js'
import type { AuditLogInsert } from './audit.types.js'

@Injectable()
export class AuditWriter {
  async write(entry: AuditLogInsert, trx?: Kysely<Database>) {
    if (!isAuditEnabled()) return
    const database = trx ?? db()
    try {
      await database
        .insertInto('audit_logs')
        .values({
          audit_id: randomUUID(),
          occurred_at: new Date(),
          scope_type: entry.scopeType,
          realm_id: entry.realmId ?? null,
          actor_type: entry.actorType,
          actor_id: entry.actorId ?? null,
          actor_display: entry.actorDisplay ?? null,
          auth_scheme: entry.authScheme ?? null,
          action: entry.action,
          target_type: entry.targetType ?? null,
          target_id: entry.targetId ?? null,
          operation_id: entry.operationId ?? null,
          method: entry.method,
          path: entry.path,
          route_template: entry.routeTemplate ?? null,
          status: entry.status,
          http_status: entry.httpStatus,
          error_code: entry.errorCode ?? null,
          trace_id: entry.traceId ?? null,
          params_json: entry.paramsJson ?? null,
          query_json: entry.queryJson ?? null,
          body_json_redacted: entry.bodyJsonRedacted ?? null,
          metadata: entry.metadata ?? {},
        })
        .execute()
    } catch (error) {
      console.warn('[audit] write failed', error)
    }
  }
}
