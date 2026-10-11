import { uuid, now, j, type SqlParam } from '../db/index.js';
import type { AppCtx } from '../context.js';
import type { Role } from '../domain/permissions.js';

export interface AuditInput {
  actorId?: string | null;
  actorRole?: Role | string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  detail?: Record<string, unknown>;
  traceId?: string | null;
}

/** FR-AUD-01/02, SEC-12: immutable audit records for sensitive/commercial actions. */
export function audit(ctx: AppCtx, input: AuditInput): void {
  ctx.db
    .prepare(
      `INSERT INTO audit_events (id, actor_id, actor_role, action, entity, entity_id, detail, trace_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      uuid(),
      input.actorId ?? null,
      input.actorRole ?? null,
      input.action,
      input.entity,
      input.entityId ?? null,
      j(input.detail ?? {}),
      input.traceId ?? null,
      now()
    );
}

export function listAudit(
  ctx: AppCtx,
  filter: { entity?: string; entityId?: string; limit?: number } = {}
) {
  const clauses: string[] = [];
  const params: SqlParam[] = [];
  if (filter.entity) {
    clauses.push('entity = ?');
    params.push(filter.entity);
  }
  if (filter.entityId) {
    clauses.push('entity_id = ?');
    params.push(filter.entityId);
  }
  const limit = Math.min(filter.limit ?? 100, 500);
  const sql = `SELECT * FROM audit_events ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''}
               ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);
  return ctx.db.prepare(sql).all(...params);
}
