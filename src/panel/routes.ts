import { Router } from 'express';

import { config } from '../config.js';
import { db } from '../db/index.js';
import { logger } from '../logger.js';
import type { Cabinet } from '../wb/cabinets.js';
import {
    countUnansweredFeedbacks,
    countUnansweredQuestions,
    getSellerInfo,
    listChats,
    type SellerInfo
} from '../wb/api.js';
import { WbApiError } from '../wb/client.js';
import { renderPanel, type CabinetStatus, type PanelData } from './render.js';
import { beginPanelLogin, clearSession, readSession } from './session.js';

/**
 * Данные о продавце меняются раз в год, а лимиты WB тратить жалко:
 * держим их в памяти процесса.
 */
const sellerCache = new Map<string, SellerInfo>();

async function sellerOf(cabinet: Cabinet): Promise<SellerInfo | null> {
    const cached = sellerCache.get(cabinet.slug);
    if (cached) return cached;
    try {
        const info = await getSellerInfo(cabinet);
        sellerCache.set(cabinet.slug, info);
        return info;
    } catch {
        return null;
    }
}

async function statusOf(cabinet: Cabinet): Promise<CabinetStatus> {
    const seller = await sellerOf(cabinet);
    try {
        const [feedbacks, questions] = await Promise.all([
            countUnansweredFeedbacks(cabinet),
            countUnansweredQuestions(cabinet)
        ]);

        let chats: number | null = null;
        try {
            chats = (await listChats(cabinet)).length;
        } catch {
            chats = null;
        }

        return {
            cabinet,
            seller,
            error: null,
            counts: {
                feedbacksUnanswered: feedbacks.countUnanswered,
                feedbacksToday: feedbacks.countUnansweredToday,
                questionsUnanswered: questions.countUnanswered,
                questionsToday: questions.countUnansweredToday,
                chats
            }
        };
    } catch (e) {
        return {
            cabinet,
            seller,
            counts: null,
            error: e instanceof WbApiError ? e.toUserMessage() : String(e)
        };
    }
}

export function panelRouter(): Router {
    const router = Router();

    router.get('/login', (_req, res) => {
        beginPanelLogin(res);
    });

    router.get('/logout', (_req, res) => {
        clearSession(res);
        res.redirect('/panel/login');
    });

    router.get('/', async (req, res) => {
        const session = readSession(req);
        if (!session) {
            res.redirect('/panel/login');
            return;
        }

        try {
            const visible = config.cabinets
                .all()
                .filter(c => session.cabinets === null || session.cabinets.includes(c.slug));
            const cabinets = await Promise.all(visible.map(statusOf));

            // Список сотрудников — сведения о всей организации. Их видит только
            // администратор; ограниченный сотрудник видит одну свою строку.
            const isAdmin = session.role === 'admin';
            const users = (
                isAdmin
                    ? db.prepare('SELECT email, name, last_seen FROM users ORDER BY last_seen DESC LIMIT 50').all()
                    : db.prepare('SELECT email, name, last_seen FROM users WHERE email = ?').all(session.email)
            ) as Array<{ email: string; name: string | null; last_seen: number }>;

            const scopeOf = (email: string): string => {
                const row = db.prepare('SELECT cabinets FROM users WHERE email = ?').get(email) as
                    | { cabinets: string | null }
                    | undefined;
                return row?.cabinets ? row.cabinets : 'все';
            };

            // Журнал: администратору целиком, остальным — только свои действия
            // и события своих кабинетов. Чужая активность не показывается.
            const allowed = session.cabinets;
            const audit = (
                isAdmin || allowed === null
                    ? db
                          .prepare('SELECT ts, cabinet, actor, action, target, outcome FROM audit ORDER BY ts DESC LIMIT 40')
                          .all()
                    : db
                          .prepare(
                              `SELECT ts, cabinet, actor, action, target, outcome FROM audit
                               WHERE actor = ? OR cabinet IN (${allowed.map(() => '?').join(',')})
                               ORDER BY ts DESC LIMIT 40`
                          )
                          .all(session.email, ...allowed)
            ) as PanelData['audit'];

            // Счётчики черновиков — тоже в пределах доступных кабинетов.
            const counts = (
                allowed === null
                    ? db.prepare('SELECT status, COUNT(*) AS n FROM drafts GROUP BY status').all()
                    : db
                          .prepare(
                              `SELECT status, COUNT(*) AS n FROM drafts
                               WHERE cabinet IN (${allowed.map(() => '?').join(',')}) GROUP BY status`
                          )
                          .all(...allowed)
            ) as Array<{ status: string; n: number }>;
            const byStatus = (s: string): number => counts.find(c => c.status === s)?.n ?? 0;

            res.type('html').send(
                renderPanel({
                    session,
                    cabinets,
                    users: users.map(u => ({ ...u, role: roleLabel(u.email), scope: scopeOf(u.email) })),
                    isAdmin,
                    audit,
                    drafts: { pending: byStatus('pending'), sent: byStatus('sent'), failed: byStatus('failed') },
                    generatedAt: Math.floor(Date.now() / 1000)
                })
            );
        } catch (e) {
            logger.error({ err: e }, 'panel render failed');
            res.status(500).type('text/plain').send('Не удалось собрать данные панели. Смотрите логи сервера.');
        }
    });

    return router;
}

function roleLabel(email: string): string {
    const e = email.toLowerCase();
    if (config.access.admins.includes(e)) return 'admin';
    if (config.access.responders.includes(e)) return 'responder';
    return 'reader';
}
