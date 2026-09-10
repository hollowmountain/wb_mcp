/**
 * Клиент Ozon Performance API — рекламные кампании.
 *
 * Это отдельная от Seller API служба: другой хост, другие ключи и другая
 * авторизация. Ключ продавца сюда не подходит вообще, а в Seller API реклама
 * закрыта — все метрики `adv_*` в /v1/analytics/data Ozon пометил deprecated
 * и молча выбрасывает. Поэтому рекламу можно взять только здесь.
 *
 * Пара client_id + client_secret выпускается в рекламном кабинете, меняется
 * на токен по OAuth2 client_credentials. Токен живёт 30 минут, поэтому держим
 * его в памяти и обновляем заранее.
 */

import type { OzonCabinet } from './client.js';

const BASE = 'https://api-performance.ozon.ru';

/** Обновляем за минуту до конца: запрос в пути не должен наткнуться на протухший токен. */
const EXPIRY_MARGIN_MS = 60_000;

export class OzonPerfError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly path: string
    ) {
        super(message);
        this.name = 'OzonPerfError';
    }
}

interface CachedToken {
    token: string;
    expiresAt: number;
}

const tokens = new Map<string, CachedToken>();

/** Есть ли у кабинета рекламные ключи. Без них инструменты по нему молчат. */
export const hasPerf = (cabinet: OzonCabinet): boolean => Boolean(cabinet.perf);

async function getToken(cabinet: OzonCabinet): Promise<string> {
    const perf = cabinet.perf;
    if (!perf) {
        throw new OzonPerfError(
            `Для кабинета «${cabinet.slug}» не заведены ключи рекламного кабинета`,
            0,
            '/api/client/token'
        );
    }

    const cached = tokens.get(cabinet.slug);
    if (cached && cached.expiresAt - EXPIRY_MARGIN_MS > Date.now()) return cached.token;

    const res = await fetch(BASE + '/api/client/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            client_id: perf.clientId,
            client_secret: perf.secret,
            grant_type: 'client_credentials'
        }),
        signal: AbortSignal.timeout(20_000)
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new OzonPerfError(text.slice(0, 200) || res.statusText, res.status, '/api/client/token');
    }

    const body = (await res.json()) as { access_token: string; expires_in: number };
    tokens.set(cabinet.slug, {
        token: body.access_token,
        expiresAt: Date.now() + body.expires_in * 1000
    });
    return body.access_token;
}

async function get<T>(cabinet: OzonCabinet, path: string, params?: Record<string, string>): Promise<T> {
    const token = await getToken(cabinet);
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);

    const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(60_000)
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new OzonPerfError(text.slice(0, 200) || res.statusText, res.status, path);
    }
    return (await res.json()) as T;
}

export interface OzonCampaign {
    id: string;
    title: string;
    state: string;
    advObjectType: string;
    placement: string[];
    dailyBudget: string;
    budget: string;
    fromDate: string;
    toDate: string;
}

export const listCampaigns = async (cabinet: OzonCabinet): Promise<OzonCampaign[]> =>
    (await get<{ list: OzonCampaign[] }>(cabinet, '/api/client/campaign')).list ?? [];

/** Строка дневного отчёта: одна кампания за один день. */
export interface OzonAdDay {
    id: string;
    title: string;
    date: string;
    views: string;
    clicks: string;
    moneySpent: string;
    orders: string;
    ordersMoney: string;
}

export const dailyStats = async (
    cabinet: OzonCabinet,
    dateFrom: string,
    dateTo: string
): Promise<OzonAdDay[]> =>
    (await get<{ rows: OzonAdDay[] }>(cabinet, '/api/client/statistics/daily/json', { dateFrom, dateTo }))
        .rows ?? [];

/**
 * Ozon отдаёт деньги строкой с запятой в роли разделителя — «477,31».
 * parseFloat на такой строке даёт 477, то есть тихо теряет копейки.
 */
export const num = (v: string | undefined): number => {
    if (!v) return 0;
    const parsed = Number(v.replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : 0;
};

export interface AdTotals {
    views: number;
    clicks: number;
    spent: number;
    orders: number;
    ordersMoney: number;
}

export interface AdCampaignRoll extends AdTotals {
    id: string;
    title: string;
}

/** Свёртка по кампаниям: за месяц дневных строк набегает больше тысячи. */
export function rollUpByCampaign(rows: OzonAdDay[]): { totals: AdTotals; campaigns: AdCampaignRoll[] } {
    const byId = new Map<string, AdCampaignRoll>();
    const totals: AdTotals = { views: 0, clicks: 0, spent: 0, orders: 0, ordersMoney: 0 };

    for (const r of rows) {
        const cur = byId.get(r.id) ?? { id: r.id, title: r.title, views: 0, clicks: 0, spent: 0, orders: 0, ordersMoney: 0 };
        cur.views += num(r.views);
        cur.clicks += num(r.clicks);
        cur.spent += num(r.moneySpent);
        cur.orders += num(r.orders);
        cur.ordersMoney += num(r.ordersMoney);
        byId.set(r.id, cur);

        totals.views += num(r.views);
        totals.clicks += num(r.clicks);
        totals.spent += num(r.moneySpent);
        totals.orders += num(r.orders);
        totals.ordersMoney += num(r.ordersMoney);
    }

    const campaigns = [...byId.values()].sort((a, b) => b.spent - a.spent);
    return { totals, campaigns };
}

/** ДРР — доля рекламных расходов в выручке от рекламы. Без выручки не определена. */
export const drr = (spent: number, ordersMoney: number): number | null =>
    ordersMoney > 0 ? Math.round((spent / ordersMoney) * 1000) / 10 : null;

/** CTR в процентах. Без показов не определён — нулём его называть нельзя. */
export const ctr = (clicks: number, views: number): number | null =>
    views > 0 ? Math.round((clicks / views) * 10000) / 100 : null;
