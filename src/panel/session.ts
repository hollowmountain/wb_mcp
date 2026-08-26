import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';

import { audit } from '../audit.js';
import { config, isAllowedEmail, roleForEmail, type Role } from '../config.js';
import { db, newId, now } from '../db/index.js';
import { cabinetScopeOf } from '../auth/provider.js';
import { identity } from '../auth/identity/index.js';
import type { VerifiedIdentity } from '../auth/identity/types.js';
import { deniedPage, errorPage } from '../auth/pages.js';

const COOKIE_NAME = 'mcpwb_panel';
const SESSION_TTL_SECONDS = 12 * 60 * 60;

export interface PanelSession {
    email: string;
    role: Role;
    /** Кабинеты, открытые этому человеку. null — все. */
    cabinets: string[] | null;
}

function sign(payload: string): string {
    return createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
}

function equal(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
}

/** Кука вида `email|срок|подпись`. Подпись на SESSION_SECRET, подделать нельзя. */
function issueCookie(res: Response, email: string): void {
    const expires = now() + SESSION_TTL_SECONDS;
    const payload = `${Buffer.from(email).toString('base64url')}|${expires}`;
    const value = `${payload}|${sign(payload)}`;

    res.cookie(COOKIE_NAME, value, {
        httpOnly: true,
        secure: config.publicUrl.protocol === 'https:',
        sameSite: 'lax',
        maxAge: SESSION_TTL_SECONDS * 1000,
        path: '/'
    });
}

export function readSession(req: Request): PanelSession | null {
    const raw = req.cookies?.[COOKIE_NAME];
    if (typeof raw !== 'string') return null;

    const parts = raw.split('|');
    if (parts.length !== 3) return null;
    const [encoded, expires, signature] = parts as [string, string, string];

    if (!equal(sign(`${encoded}|${expires}`), signature)) return null;
    if (Number(expires) < now()) return null;

    const email = Buffer.from(encoded, 'base64url').toString('utf8');
    // Право доступа проверяем на каждом запросе: увольнение действует сразу.
    if (!isAllowedEmail(email)) return null;

    return { email, role: roleForEmail(email), cabinets: cabinetScopeOf(email) };
}

export function clearSession(res: Response): void {
    res.clearCookie(COOKIE_NAME, { path: '/' });
}

// ─── Вход ────────────────────────────────────────────────────────────────────

interface PendingRow {
    id: string;
    purpose: string;
    created_at: number;
}

/**
 * Заводит заявку на вход в панель. Используем ту же таблицу, что и OAuth,
 * помечая назначение: провайдер личности у них общий.
 */
export function beginPanelLogin(res: Response): void {
    const pendingId = newId(24);
    db.prepare(
        `INSERT INTO pending_auth (id, purpose, client_id, redirect_uri, client_state, code_challenge, scopes, resource, created_at)
         VALUES (?, 'panel', 'panel', '/panel', NULL, 'panel', '', NULL, ?)`
    ).run(pendingId, now());

    void identity.begin(pendingId, res);
}

export function purposeOfPending(pendingId: string): string | null {
    const row = db.prepare('SELECT purpose FROM pending_auth WHERE id = ?').get(pendingId) as
        | Pick<PendingRow, 'purpose'>
        | undefined;
    return row?.purpose ?? null;
}

export async function completePanelLogin(
    pendingId: string,
    verified: VerifiedIdentity,
    res: Response
): Promise<void> {
    const row = db.prepare('SELECT id, purpose, created_at FROM pending_auth WHERE id = ?').get(pendingId) as
        | PendingRow
        | undefined;

    if (!row) {
        res.status(400).send(errorPage('Сессия входа истекла', 'Откройте панель заново.'));
        return;
    }
    db.prepare('DELETE FROM pending_auth WHERE id = ?').run(pendingId);

    if (row.created_at < now() - 900) {
        res.status(400).send(errorPage('Сессия входа истекла', 'С момента начала входа прошло больше 15 минут.'));
        return;
    }

    const email = verified.email.toLowerCase();
    if (!isAllowedEmail(email)) {
        audit({ actor: email, action: 'panel.login', outcome: 'denied' });
        res.status(403).send(deniedPage(email));
        return;
    }

    const timestamp = now();
    const scope = verified.cabinets && verified.cabinets.length > 0 ? verified.cabinets.join(',') : null;
    db.prepare(
        `INSERT INTO users (email, name, cabinets, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET last_seen = excluded.last_seen,
                                          name = COALESCE(excluded.name, users.name),
                                          cabinets = excluded.cabinets`
    ).run(email, verified.name ?? null, scope, timestamp, timestamp);

    audit({ actor: email, action: 'panel.login', outcome: 'ok' });
    issueCookie(res, email);
    res.redirect('/panel');
}
