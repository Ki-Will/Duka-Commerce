import { uuid, now } from '../db/index.js';
import type { AppCtx } from '../context.js';

export interface NotifyInput {
  type: string;
  recipient: string; // user id
  subject: string;
  body: string;
  channel?: 'inapp' | 'sms' | 'email';
}

/**
 * FR-NOT-01: notification events for order/payment/fulfillment changes.
 * FR-NOT-04 / NOT-006: content must not expose unnecessary sensitive data —
 * callers pass only minimal, non-sensitive summaries.
 */
export function notify(ctx: AppCtx, input: NotifyInput): string {
  const id = uuid();
  ctx.db
    .prepare(
      `INSERT INTO notifications (id, type, channel, recipient, subject, body, status, attempts, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?)`
    )
    .run(id, input.type, input.channel ?? 'inapp', input.recipient, input.subject, input.body, now());
  return id;
}

/**
 * Simulated provider delivery pass. Notifications are secondary (BR-14):
 * failure never touches commercial state — callers simply catch the result.
 */
export function flushNotifications(
  ctx: AppCtx,
  opts: { providerDown?: boolean } = {}
): { sent: number; failed: number } {
  const rows = ctx.db
    .prepare(`SELECT id, attempts FROM notifications WHERE status = 'pending' ORDER BY created_at`)
    .all() as { id: string; attempts: number }[];
  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    if (opts.providerDown) {
      ctx.db
        .prepare(`UPDATE notifications SET status = 'failed', attempts = attempts + 1 WHERE id = ?`)
        .run(row.id);
      failed++;
    } else {
      ctx.db
        .prepare(`UPDATE notifications SET status = 'sent', attempts = attempts + 1, sent_at = ? WHERE id = ?`)
        .run(now(), row.id);
      sent++;
    }
  }
  return { sent, failed };
}

/** FR-NOT-02: retryable delivery — failed messages return to pending. */
export function retryNotifications(ctx: AppCtx): number {
  const res = ctx.db
    .prepare(`UPDATE notifications SET status = 'pending' WHERE status = 'failed' AND attempts < 5`)
    .run();
  return Number(res.changes ?? 0);
}

export function notificationsFor(ctx: AppCtx, userId: string) {
  return ctx.db
    .prepare('SELECT * FROM notifications WHERE recipient = ? ORDER BY created_at DESC LIMIT 100')
    .all(userId);
}
