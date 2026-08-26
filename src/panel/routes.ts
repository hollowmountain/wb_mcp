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
            const cabinets = await Promise.all(config.cabinets.all().map(statusOf));

            const users = db
                .prepare('SELECT email, name, last_seen FROM users ORDER BY last_seen DESC LIMIT 50')
                .all() as Array<{ email: string; name: string | null; last_seen: number }>;

            const audit = db
                .prepare(
                    'SELECT ts, cabinet, actor, action, target, outcome FROM audit ORDER BY ts DESC LIMIT 40'
                )
                .all() as PanelData['audit'];

            const counts = db
                .prepare('SELECT status, COUNT(*) AS n FROM drafts GROUP BY status')
                .all() as Array<{ status: string; n: number }>;
            const byStatus = (s: string): number => counts.find(c => c.status === s)?.n ?? 0;

            res.type('html').send(
                renderPanel({
                    session,
                    cabinets,
                    users: users.map(u => ({ ...u, role: roleLabel(u.email) })),
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
