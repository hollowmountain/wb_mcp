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

import { deflateSync, inflateSync } from 'node:zlib';

import { db } from '../db/index.js';
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

    /** Текст для человека. Тело ответа Ozon в 4xx обычно само объясняет причину — роль ключа, подписку. */
    toUserMessage(): string {
        if (this.status === 429) return `Реклама Ozon ограничила частоту запросов (429) на ${this.path}. Повторите через минуту.`;
        if (this.status >= 500) return `Реклама Ozon сейчас не отвечает (${this.status}) на ${this.path} — сбой на их стороне. Попробуйте позже.`;
        // Так Ozon отвечает на снятый метод — это поломка коннектора, а не отказ.
        if (this.status === 404 && /page not found/i.test(this.message)) {
            return `Ozon больше не поддерживает метод ${this.path} — нужна правка коннектора, сообщите администратору.`;
        }
        if (this.status === 401) return 'Реклама Ozon не приняла ключ (401). Проверьте ключ Performance API.';
        // Статус 0 — не ответ Ozon, а наша проверка: нет ключей, отчёт не в том формате.
        if (this.status === 0) return `Реклама Ozon (${this.path}): ${this.message}`;
        return `Реклама Ozon отказала (${this.status}) на ${this.path}: ${this.message}`;
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

// ─── Расход по товарам ───────────────────────────────────────────────────────
//
// Seller API рекламу по товарам не раскладывает: в начислениях оплата за клик
// и за заказ приходят строками без SKU. Разбивку даёт только рекламный кабинет,
// и только отчётами-заданиями: запросили — получили UUID — ждём state = OK —
// скачиваем. Ozon строит одно задание за раз на кабинет, кампаний в задании
// не больше десяти, период не длиннее 62 дней.
//
// ВНИМАНИЕ: написано по документации Performance API (зеркало
// github.com/teliy/ozon-performance-api, docs/statistics.md, октябрь 2026),
// на живых ключах не проверено — локально ключей рекламного кабинета нет.
// Поэтому разбор отчёта нарочно придирчив: если Ozon пришлёт не то, что
// ожидается, инструмент скажет об этом, а не покажет нули. И итог по SKU
// всегда сверяется с расходом кампаний из дневной статистики.

/** Задание на отчёт: ответ на запуск. */
interface ReportTicket {
    UUID?: string;
}

interface ReportState {
    state?: string;
    error?: string;
    link?: string;
}

async function send(cabinet: OzonCabinet, method: 'GET' | 'POST', path: string, params?: Record<string, string>, body?: unknown): Promise<{ type: string; text: string }> {
    const token = await getToken(cabinet);
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
    const res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(60_000)
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) throw new OzonPerfError(text.slice(0, 200) || res.statusText, res.status, path);
    return { type: res.headers.get('content-type') ?? '', text };
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/** Сколько ждём одно задание. Ozon обычно строит отчёт за секунды, под нагрузкой — до минуты. */
const REPORT_WAIT_MS = 150_000;

/** Запустить отчёт, дождаться и скачать. 429 на запуске — Ozon ещё строит прошлое задание. */
async function runReport(cabinet: OzonCabinet, start: () => Promise<{ type: string; text: string }>): Promise<unknown> {
    let ticket: ReportTicket = {};
    for (let i = 0, wait = 3000; ; i++, wait *= 2) {
        try {
            ticket = JSON.parse((await start()).text) as ReportTicket;
            break;
        } catch (e) {
            if (!(e instanceof OzonPerfError && e.status === 429) || i >= 4) throw e;
            await sleep(wait);
        }
    }
    const uuid = ticket.UUID;
    if (!uuid) throw new OzonPerfError('Ozon не вернул номер задания на отчёт (UUID)', 0, '/api/client/statistics');

    const startedAt = Date.now();
    for (;;) {
        await sleep(3000);
        const st = JSON.parse((await send(cabinet, 'GET', `/api/client/statistics/${uuid}`)).text) as ReportState;
        if (st.state === 'OK') break;
        if (st.state === 'ERROR') throw new OzonPerfError(`Ozon не смог построить отчёт: ${st.error ?? 'без объяснения'}`, 0, '/api/client/statistics');
        if (Date.now() - startedAt > REPORT_WAIT_MS) {
            throw new OzonPerfError(`отчёт не готов за ${REPORT_WAIT_MS / 1000} с (состояние ${st.state ?? '?'}). Повторите позже.`, 0, '/api/client/statistics');
        }
    }
    const report = await send(cabinet, 'GET', '/api/client/statistics/report', { UUID: uuid });
    if (!/json/i.test(report.type) && !/^\s*[[{]/.test(report.text)) {
        throw new OzonPerfError(`Ozon прислал отчёт не в JSON (${report.type || 'тип не указан'}) — такой разбор не реализован`, 0, '/api/client/statistics/report');
    }
    return JSON.parse(report.text) as unknown;
}

/** Строка «товар в кампании» за период. */
export interface AdSkuRow {
    campaignId: string;
    sku: string;
    title: string;
    spent: number;
    clicks: number;
    orders: number;
    ordersMoney: number;
}

/** Деньги и счётчики в отчётах приходят то строкой с запятой, то числом. */
const numAny = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' ? num(v) : 0);

const pick = (row: Record<string, unknown>, names: string[]): unknown => {
    for (const n of names) if (row[n] !== undefined && row[n] !== null && row[n] !== '') return row[n];
    return undefined;
};

/** Поля расхода. «Стоимость» сюда не входит: это цена заказа, а не плата за рекламу. */
const SPENT_FIELDS = ['moneySpent', 'expense', 'spent', 'Расход, ₽, с НДС', 'расход, ₽', 'Расход, ₽'];
const SKU_FIELDS = ['sku', 'SKU', 'skuId'];

/**
 * Отчёт по кампаниям в JSON: { "<id кампании>": { title, report: { rows: [...] } } }.
 * Каждая строка — товар кампании за период (groupBy NO_GROUP_BY).
 */
export function parseCampaignSkuReport(raw: unknown): AdSkuRow[] {
    if (!raw || typeof raw !== 'object') throw new OzonPerfError('Пустой отчёт статистики', 0, '/api/client/statistics/report');
    const out: AdSkuRow[] = [];
    let recognized = 0;
    for (const [campaignId, v] of Object.entries(raw as Record<string, unknown>)) {
        const block = v as { report?: { rows?: unknown }; rows?: unknown } | null;
        const rows = block?.report?.rows ?? block?.rows;
        if (!Array.isArray(rows)) continue;
        recognized++;
        for (const r of rows as Array<Record<string, unknown>>) {
            const sku = pick(r, SKU_FIELDS);
            const spent = pick(r, SPENT_FIELDS);
            if (sku === undefined || spent === undefined) {
                throw new OzonPerfError(
                    `Строка отчёта без SKU или расхода — формат Ozon поменялся. Поля строки: ${Object.keys(r).join(', ')}`,
                    0,
                    '/api/client/statistics/report'
                );
            }
            out.push({
                campaignId,
                sku: String(sku),
                title: String(pick(r, ['title', 'name']) ?? ''),
                spent: numAny(spent),
                clicks: numAny(pick(r, ['clicks'])),
                orders: numAny(pick(r, ['orders'])),
                ordersMoney: numAny(pick(r, ['ordersMoney', 'revenue', 'sales']))
            });
        }
    }
    if (recognized === 0 && Object.keys(raw).length > 0) {
        throw new OzonPerfError(
            `Отчёт статистики не распознан: ожидались кампании с report.rows, пришли ключи ${Object.keys(raw).slice(0, 8).join(', ')}`,
            0,
            '/api/client/statistics/report'
        );
    }
    return out;
}

/**
 * Отчёт по заказам «оплаты за заказ»: строка — заказ, расход и SKU товара.
 * Плата за продвижение относится к продвигаемому товару, поэтому он важнее
 * SKU заказанного: у модели с вариантами они разные.
 */
export function parseOrdersReport(raw: unknown): AdSkuRow[] {
    const rows =
        Array.isArray(raw) ? raw : ((raw as { rows?: unknown; report?: { rows?: unknown } } | null)?.rows ?? (raw as { report?: { rows?: unknown } } | null)?.report?.rows);
    if (!Array.isArray(rows)) {
        throw new OzonPerfError(
            `Отчёт по заказам не распознан: пришли ключи ${raw && typeof raw === 'object' ? Object.keys(raw).slice(0, 8).join(', ') : typeof raw}`,
            0,
            '/api/client/statistic/orders/generate'
        );
    }
    return (rows as Array<Record<string, unknown>>).map(r => {
        const sku = pick(r, ['advSku', 'promotedSku', 'SKU продвигаемого товара', ...SKU_FIELDS]);
        const spent = pick(r, SPENT_FIELDS);
        if (sku === undefined || spent === undefined) {
            throw new OzonPerfError(
                `Строка отчёта по заказам без SKU или расхода. Поля строки: ${Object.keys(r).join(', ')}`,
                0,
                '/api/client/statistic/orders/generate'
            );
        }
        return {
            campaignId: 'search_promo',
            sku: String(sku),
            title: String(pick(r, ['title', 'name', 'наименование']) ?? ''),
            spent: numAny(spent),
            clicks: 0,
            orders: numAny(pick(r, ['quantity', 'количество'])) || 1,
            ordersMoney: numAny(pick(r, ['price', 'cost', 'стоимость, ₽']))
        };
    });
}

/** Отрезки не длиннее 62 дней — больше Ozon в один отчёт не берёт. */
function split62(from: string, to: string): Array<[string, string]> {
    const day = 86_400_000;
    const out: Array<[string, string]> = [];
    for (let s = Date.parse(`${from}T00:00:00Z`), stop = Date.parse(`${to}T00:00:00Z`); s <= stop; ) {
        const e = Math.min(s + 61 * day, stop);
        out.push([new Date(s).toISOString().slice(0, 10), new Date(e).toISOString().slice(0, 10)]);
        s = e + day;
    }
    return out;
}

/** Оплата за клик по товарам: отчёт по кампаниям пачками по 10. */
export async function clickSpendBySku(cabinet: OzonCabinet, campaignIds: string[], dateFrom: string, dateTo: string): Promise<AdSkuRow[]> {
    const out: AdSkuRow[] = [];
    for (const [from, to] of split62(dateFrom, dateTo)) {
        for (let i = 0; i < campaignIds.length; i += 10) {
            const batch = campaignIds.slice(i, i + 10);
            const raw = await runReport(cabinet, () =>
                send(cabinet, 'POST', '/api/client/statistics/json', undefined, { campaigns: batch, dateFrom: from, dateTo: to, groupBy: 'NO_GROUP_BY' })
            );
            out.push(...parseCampaignSkuReport(raw));
        }
    }
    return out;
}

/** Оплата за заказ по товарам: отчёт по заказам. Даты — по Москве, как группирует сам Ozon. */
export async function orderSpendBySku(cabinet: OzonCabinet, dateFrom: string, dateTo: string): Promise<AdSkuRow[]> {
    const out: AdSkuRow[] = [];
    for (const [from, to] of split62(dateFrom, dateTo)) {
        const raw = await runReport(cabinet, () =>
            send(cabinet, 'POST', '/api/client/statistic/orders/generate/json', undefined, {
                from: `${from}T00:00:00+03:00`,
                to: `${to}T23:59:59+03:00`
            })
        );
        out.push(...parseOrdersReport(raw));
    }
    return out;
}

export interface AdSkuLine {
    sku: string;
    title: string;
    /** Оплата за клик, ₽. */
    click: number;
    /** Оплата за заказ, ₽. */
    order: number;
    clicks: number;
    orders: number;
}

export interface AdSkuSummary {
    from: string;
    to: string;
    /** Расход всех кампаний по дневной статистике — с ним сверяется разбивка. */
    campaignSpent: number;
    lines: AdSkuLine[];
    /** Что не удалось разложить по товарам и почему. */
    unallocated: Array<{ title: string; spent: number; reason: string }>;
    /** Отчётов-заданий к Ozon (0 — из кэша). */
    reports: number;
    cachedAt?: number;
}

/** Типы кампаний: SKU — оплата за клик по товарам, SEARCH_PROMO — оплата за заказ. Остальное — баннеры и видео. */
const CLICK_TYPES = new Set(['SKU']);
const ORDER_TYPES = new Set(['SEARCH_PROMO']);

db.exec(`
CREATE TABLE IF NOT EXISTS ozon_ads_sku (
  cabinet    TEXT NOT NULL,
  period     TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  data       BLOB NOT NULL,
  PRIMARY KEY (cabinet, period)
);
`);

/**
 * Версия формата записи кэша. Поменялся разбор или состав AdSkuSummary —
 * увеличьте: старые записи тогда не читаются, а перекачиваются, и прежняя
 * раскладка не выдаётся за новую.
 */
const ADS_CACHE_FORMAT = 1;

/** Период закрыт, если с его конца прошло 10 дней: как у начислений, Ozon дописывает расход с опозданием. */
const closedPeriod = (to: string): boolean => Date.now() - Date.parse(`${to}T21:00:00Z`) > 10 * 86_400_000;

/**
 * Расход по SKU × инструмент за период. Кампании без расхода не трогаем —
 * каждое задание к Ozon идёт секунды, а кампаний бывает сотня.
 */
export async function adSpendBySku(cabinet: OzonCabinet, dateFrom: string, dateTo: string, refresh = false): Promise<AdSkuSummary> {
    const period = `${dateFrom}..${dateTo}`;
    const closed = closedPeriod(dateTo);
    if (closed && !refresh) {
        const row = db.prepare('SELECT fetched_at, data FROM ozon_ads_sku WHERE cabinet = ? AND period = ?').get(cabinet.slug, period) as
            | { fetched_at: number; data: Buffer }
            | undefined;
        if (row) {
            try {
                const rec = JSON.parse(inflateSync(row.data).toString('utf8')) as { v?: number; summary?: AdSkuSummary };
                // Запись старого формата (или без версии) не читаем — перекачиваем.
                if (rec.v === ADS_CACHE_FORMAT && rec.summary) return { ...rec.summary, reports: 0, cachedAt: row.fetched_at };
            } catch {
                /* битая запись — перекачаем */
            }
        }
    }

    const [days, campaigns] = await Promise.all([dailyStats(cabinet, dateFrom, dateTo), listCampaigns(cabinet)]);
    const spentBy = rollUpByCampaign(days).campaigns.filter(c => c.spent > 0);
    const typeOf = new Map(campaigns.map(c => [c.id, c.advObjectType]));
    const campaignSpent = spentBy.reduce((s, c) => s + c.spent, 0);

    const clickIds = spentBy.filter(c => CLICK_TYPES.has(typeOf.get(c.id) ?? 'SKU')).map(c => c.id);
    const orderCamps = spentBy.filter(c => ORDER_TYPES.has(typeOf.get(c.id) ?? ''));
    const other = spentBy.filter(c => !clickIds.includes(c.id) && !orderCamps.includes(c));

    const by = new Map<string, AdSkuLine>();
    const line = (sku: string, title: string): AdSkuLine => {
        const cur = by.get(sku) ?? { sku, title, click: 0, order: 0, clicks: 0, orders: 0 };
        if (!cur.title && title) cur.title = title;
        by.set(sku, cur);
        return cur;
    };
    const unallocated: AdSkuSummary['unallocated'] = [];
    let reports = 0;

    if (clickIds.length > 0) {
        const rows = await clickSpendBySku(cabinet, clickIds, dateFrom, dateTo);
        reports += Math.ceil(clickIds.length / 10) * split62(dateFrom, dateTo).length;
        const perCampaign = new Map<string, number>();
        for (const r of rows) {
            const l = line(r.sku, r.title);
            l.click += r.spent;
            l.clicks += r.clicks;
            l.orders += r.orders;
            perCampaign.set(r.campaignId, (perCampaign.get(r.campaignId) ?? 0) + r.spent);
        }
        // Сверка по каждой кампании: что не сошлось с дневной статистикой — в «не разложено».
        for (const c of spentBy.filter(x => clickIds.includes(x.id))) {
            const diff = c.spent - (perCampaign.get(c.id) ?? 0);
            if (Math.abs(diff) >= 1) {
                unallocated.push({ title: c.title, spent: diff, reason: 'отчёт по товарам кампании не сошёлся с дневной статистикой' });
            }
        }
    }

    if (orderCamps.length > 0) {
        const want = orderCamps.reduce((s, c) => s + c.spent, 0);
        const rows = await orderSpendBySku(cabinet, dateFrom, dateTo);
        reports += split62(dateFrom, dateTo).length;
        let got = 0;
        for (const r of rows) {
            const l = line(r.sku, r.title);
            l.order += r.spent;
            l.orders += r.orders;
            got += r.spent;
        }
        if (Math.abs(want - got) >= 1) {
            unallocated.push({
                title: orderCamps.map(c => c.title).join(', '),
                spent: want - got,
                reason: 'оплата за заказ: отчёт по заказам не сошёлся с дневной статистикой'
            });
        }
    }

    for (const c of other) {
        unallocated.push({ title: c.title, spent: c.spent, reason: `кампания типа ${typeOf.get(c.id) ?? '?'} — не по товарам` });
    }

    const summary: AdSkuSummary = {
        from: dateFrom,
        to: dateTo,
        campaignSpent,
        lines: [...by.values()].filter(l => l.click !== 0 || l.order !== 0).sort((a, b) => b.click + b.order - (a.click + a.order)),
        unallocated,
        reports
    };
    if (closed) {
        db.prepare(
            'INSERT INTO ozon_ads_sku (cabinet, period, fetched_at, data) VALUES (?, ?, ?, ?) ' +
                'ON CONFLICT(cabinet, period) DO UPDATE SET fetched_at = excluded.fetched_at, data = excluded.data'
        ).run(cabinet.slug, period, Math.floor(Date.now() / 1000), deflateSync(Buffer.from(JSON.stringify({ v: ADS_CACHE_FORMAT, summary: { ...summary, reports: 0 } })), { level: 9 }));
    }
    return summary;
}

/** ДРР — доля рекламных расходов в выручке от рекламы. Без выручки не определена. */
export const drr = (spent: number, ordersMoney: number): number | null =>
    ordersMoney > 0 ? Math.round((spent / ordersMoney) * 1000) / 10 : null;

/** CTR в процентах. Без показов не определён — нулём его называть нельзя. */
export const ctr = (clicks: number, views: number): number | null =>
    views > 0 ? Math.round((clicks / views) * 10000) / 100 : null;
