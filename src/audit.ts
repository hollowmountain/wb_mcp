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
    cabinet?: string;
    target?: string;
    detail?: unknown;
    outcome: AuditOutcome;
}): void {
    const detail = entry.detail === undefined ? null : JSON.stringify(entry.detail);
    db.prepare('INSERT INTO audit (ts, cabinet, actor, action, target, detail, outcome) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        now(),
        entry.cabinet ?? null,
        entry.actor,
        entry.action,
        entry.target ?? null,
        detail,
        entry.outcome
    );
    logger.info({ audit: true, ...entry }, `audit ${entry.action} ${entry.outcome}`);
}

export function recentAudit(limit = 50): Array<Record<string, unknown>> {
    return db
        .prepare('SELECT ts, cabinet, actor, action, target, detail, outcome FROM audit ORDER BY ts DESC LIMIT ?')
        .all(limit) as Array<
        Record<string, unknown>
    >;
}


/**
 * Журнал не должен расти вечно. Держим неделю — ровно то окно, которое
 * показывает панель. При тысяче вызовов в день это чуть больше мегабайта,
 * и объём перестаёт расти совсем.
 *
 * Срок короткий сознательно: чем меньше живёт запись о том, кто что смотрел,
 * тем меньше поводов ею злоупотребить. Если понадобится разбирать давний
 * случай — срок недолго и увеличить.
 */
export function pruneAudit(days = 7): number {
    const cutoff = now() - days * 24 * 60 * 60;
    const res = db.prepare('DELETE FROM audit WHERE ts < ?').run(cutoff);
    const removed = Number(res.changes ?? 0);
    if (removed > 0) logger.info({ removed, days }, 'старые записи журнала удалены');
    return removed;
}


export interface ToolUsageRow {
    actor: string;
    tool: string;
    calls: number;
    denied: number;
    errors: number;
    avgMs: number;
    lastTs: number;
}

/**
 * Чем пользовались за последние дни. Ради этого запись вызовов и заводилась:
 * по журналу отправок видно только тех, кто отвечает покупателям, а человек,
 * который весь день читает отчёты, выглядел бездельником.
 */
export function toolUsage(days = 7, actor?: string): ToolUsageRow[] {
    const since = now() - days * 24 * 60 * 60;
    const rows = db
        .prepare(
            `SELECT actor, action, outcome, detail, ts FROM audit
             WHERE ts >= ? AND action LIKE 'tool.%' ${actor ? 'AND actor = ?' : ''}`
        )
        .all(...(actor ? [since, actor] : [since])) as Array<{
        actor: string;
        action: string;
        outcome: string;
        detail: string | null;
        ts: number;
    }>;

    const acc = new Map<string, ToolUsageRow & { totalMs: number }>();
    for (const r of rows) {
        const tool = r.action.slice('tool.'.length);
        const key = `${r.actor}\u0000${tool}`;
        const cur = acc.get(key) ?? {
            actor: r.actor, tool, calls: 0, denied: 0, errors: 0, avgMs: 0, lastTs: 0, totalMs: 0
        };
        cur.calls += 1;
        if (r.outcome === 'denied') cur.denied += 1;
        if (r.outcome === 'error') cur.errors += 1;
        if (r.ts > cur.lastTs) cur.lastTs = r.ts;
        try {
            const ms = r.detail ? (JSON.parse(r.detail) as { ms?: number }).ms : undefined;
            if (typeof ms === 'number') cur.totalMs += ms;
        } catch {
            /* деталь не разобралась — не беда, считаем без неё */
        }
        acc.set(key, cur);
    }
    return [...acc.values()]
        .map(v => ({ ...v, avgMs: v.calls > 0 ? Math.round(v.totalMs / v.calls) : 0 }))
        .sort((x, y) => y.calls - x.calls);
}
