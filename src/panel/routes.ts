import { Router } from 'express';

import { toolUsage } from '../audit.js';
import { areasOf, config } from '../config.js';
import { db, kvGet, kvSet } from '../db/index.js';
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
import { getOzonSellerInfo, probeOzonAccess } from '../ozon/client.js';
import { renderPanel, type CabinetStatus, type OzonStatus, type PanelData } from './render.js';
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

/**
 * Состояние кабинетов Ozon. Каждое обращение — четыре запроса к Ozon, а панель
 * сама обновляется раз в две минуты, поэтому держим результат полчаса.
 */
const OZON_TTL_MS = 30 * 60 * 1000;

async function ozonStatuses(): Promise<OzonStatus[]> {
    if (config.ozon.length === 0) return [];

    const cached = kvGet('panel.ozon');
    if (cached) {
        try {
            const parsed = JSON.parse(cached) as { at: number; rows: OzonStatus[] };
            if (Date.now() - parsed.at < OZON_TTL_MS) return parsed.rows;
        } catch {
            // Повреждённый кэш не повод падать — соберём заново.
        }
    }

    const rows = await Promise.all(
        config.ozon.map(async (cab): Promise<OzonStatus> => {
            try {
                const [info, access] = await Promise.all([getOzonSellerInfo(cab), probeOzonAccess(cab)]);
                return {
                    slug: cab.slug,
                    company: info.company?.name ?? null,
                    legalName: info.company?.legal_name ?? null,
                    subscriptionType: info.subscription?.type ?? null,
                    isPremium: Boolean(info.subscription?.is_premium),
                    access,
                    error: null
                };
            } catch (e) {
                return {
                    slug: cab.slug,
                    company: null,
                    legalName: null,
                    subscriptionType: null,
                    isPremium: false,
                    access: null,
                    error: e instanceof Error ? e.message : String(e)
                };
            }
        })
    );
    kvSet('panel.ozon', JSON.stringify({ at: Date.now(), rows }));
    return rows;
}

export function panelRouter(): Router {
    const router = Router();

    router.get('/login', (req, res) => {
        // Уже вошёл — форма не нужна. Так кэшированная ссылка на вход
        // не выкидывает человека из панели, в которой он сидит.
        if (readSession(req)) {
            res.redirect('/panel');
            return;
        }
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

            const areasOfUser = (email: string): string => {
                const row = db.prepare('SELECT areas FROM users WHERE email = ?').get(email) as
                    | { areas: string | null }
                    | undefined;
                const list = areasOf(email, row?.areas);
                return row?.areas ? list.join(', ') : `${list.join(', ')} (по умолчанию)`;
            };

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

            // Очередь черновиков в разрезе кабинетов: видно, где накопилось.
            const perCabinet = (
                allowed === null
                    ? db
                          .prepare("SELECT cabinet, COUNT(*) AS n FROM drafts WHERE status = 'pending' GROUP BY cabinet")
                          .all()
                    : db
                          .prepare(
                              `SELECT cabinet, COUNT(*) AS n FROM drafts WHERE status = 'pending'
                               AND cabinet IN (${allowed.map(() => '?').join(',')}) GROUP BY cabinet`
                          )
                          .all(...allowed)
            ) as Array<{ cabinet: string; n: number }>;

            // Ozon показываем только администратору: это сведения об организации.
            const ozon = isAdmin ? await ozonStatuses().catch(() => []) : [];

            res.type('html').send(
                renderPanel({
                    session,
                    cabinets,
                    users: users.map(u => ({ ...u, role: roleLabel(u.email), scope: scopeOf(u.email), areas: areasOfUser(u.email) })),
                    isAdmin,
                    // Как и журнал: администратору по всем, остальным — только своё.
                    usage: toolUsage(7, isAdmin ? undefined : session.email),
                    audit,
                    drafts: { pending: byStatus('pending'), sent: byStatus('sent'), failed: byStatus('failed') },
                    draftsByCabinet: perCabinet
                        .map(r => ({ cabinet: r.cabinet, pending: r.n }))
                        .sort((a, b) => b.pending - a.pending),
                    ozon,
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
