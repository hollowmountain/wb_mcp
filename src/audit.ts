import { db, now } from './db/index.js';
import { logger } from './logger.js';

export type AuditOutcome = 'ok' | 'denied' | 'error';

/**
 * Единый журнал всех действий, которые видны клиентам или меняют состояние.
 * Пишем и в SQLite (для разбора инцидентов), и в stdout (для сбора логов).
 */
export function audit(entry: {
    actor: string;
    action: string;
    target?: string;
    detail?: unknown;
    outcome: AuditOutcome;
}): void {
    const detail = entry.detail === undefined ? null : JSON.stringify(entry.detail);
    db.prepare('INSERT INTO audit (ts, actor, action, target, detail, outcome) VALUES (?, ?, ?, ?, ?, ?)').run(
        now(),
        entry.actor,
        entry.action,
        entry.target ?? null,
        detail,
        entry.outcome
    );
    logger.info({ audit: true, ...entry }, `audit ${entry.action} ${entry.outcome}`);
}

export function recentAudit(limit = 50): Array<Record<string, unknown>> {
    return db.prepare('SELECT ts, actor, action, target, detail, outcome FROM audit ORDER BY ts DESC LIMIT ?').all(limit) as Array<
        Record<string, unknown>
    >;
}
