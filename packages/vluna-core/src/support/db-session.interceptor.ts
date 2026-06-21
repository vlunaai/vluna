import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common'
import { from, lastValueFrom, Observable } from 'rxjs'
import type { AppRequest } from '../types/app-request.js'
import { db, setRlsSession } from '../db/index.js'
import type { Kysely } from 'kysely'
import type { Database } from '../types/database.js'

@Injectable()
export class DbSessionInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<AppRequest>()
    // Defer until guards populate ctx.realmId / ctx.billingAccountId
    return from(
      db()
        .transaction()
        .execute(async (trx: Kysely<Database>) => {
          try {
            await setRlsSession(trx, {
              realmId: req?.ctx?.realmId,
              billingAccountId: req?.ctx?.billingAccountId,
              billingUserId: req?.ctx?.billingUserId,
              isRealmAdmin: req?.ctx?.isRealmAdmin === true,
            })
          } catch {}
          req.ctx = req.ctx || {}
          req.ctx.db = trx
          const out = await lastValueFrom(next.handle())
          return out
        }),
    )
  }
}
