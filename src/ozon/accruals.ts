/**
 * Начисления Ozon детально: каждый вид начисления и услуги, по товарам.
 *
 * Откуда. До осени 2026 это был /v3/finance/transaction/list. Ozon снял его
 * вместе с /v3/finance/transaction/totals к 05.10.2026 («404 page not found»,
 * так же отвечают v1, v2, v4). Замена — три метода семейства accrual:
 *   - /v1/finance/accrual/types   — справочник видов начислений, 138 штук,
 *     у каждого код (Logistic) и русское название («Логистика»);
 *   - /v1/finance/accrual/by-day  — все начисления за один день, страницами
 *     по 1000 с меткой last_id;
 *   - /v1/finance/accrual/postings — то же по номерам отправлений, до 200 за раз.
 * Проверено на всех трёх кабинетах 31.10.2026: by-day за август в сумме
 * сходится с /v1/finance/balance до копейки (начислено, продажи, вознаграждение
 * и каждая услуга).
 *
 * Как устроено одно начисление by-day:
 *   - POSTING — отправление: по каждому товару блок commission (продажа по цене
 *     продавца, сколько заплатил покупатель, баллы Ozon, вознаграждение) и
 *     delivery.services — логистика с кодом вида;
 *   - ITEM — услуга по товару: item_fees с SKU, видом и количеством;
 *   - NON_ITEM — услуга без товара: реклама, хранение, обработка поставки.
 * Сумма частей каждого начисления равна его total_amount — это проверяется
 * на лету, и всё, что не удалось разобрать, идёт отдельной строкой, а не теряется.
 *
 * Реклама (оплата за клик и за заказ), хранение и обработка поставок приходят
 * без SKU: Ozon не раскладывает их по товарам. Разбивку рекламы по товарам
 * даёт только рекламный кабинет — ozon_ads с groupBy=sku.
 *
 * Деньги считаются в копейках целыми числами: за месяц у oz-pixeltap 44 тысячи
 * начислений, и сумма дробей с плавающей точкой расходится с балансом на копейки.
 */

import { deflateSync, inflateSync } from 'node:zlib';

import { db } from '../db/index.js';
import { post, retryOn429, type OzonCabinet } from './client.js';

// ─── Справочник видов ────────────────────────────────────────────────────────

export interface AccrualType {
    id: number;
    /** Код Ozon: Logistic, PayPerClick. */
    code: string;
    /** Русское название из справочника Ozon. */
    name: string;
}

/**
 * Служебные ключи для того, у чего в by-day нет кода вида.
 * Продажи и возвраты приходят блоком commission внутри отправления, без type_id.
 * Товарная компенсация (25) смешивает возмещения Ozon за потерю и порчу (плюс)
 * с декомпенсацией (минус): финансист первые в расходы не берёт, а вторую
 * берёт, поэтому они разведены по знаку.
 */
export const SALE = 'sale';
export const RETURN = 'return';
export const COMP_PLUS = '25+';
export const COMP_MINUS = '25-';
export const UNPARSED = 'unparsed';
/** Вознаграждение за продажу — так этот вид называется в справочнике. */
export const SALE_COMMISSION = '69';

const PSEUDO: Record<string, AccrualType> = {
    // Кода вида у продаж нет: это поле sale_amount в блоке commission отправления.
    [SALE]: { id: 0, code: 'sale_amount>0', name: 'Продажи (по цене продавца)' },
    [RETURN]: { id: 0, code: 'sale_amount<0', name: 'Возвраты и отмены продаж' },
    [COMP_PLUS]: { id: 25, code: 'ItemCompensation, плюс', name: 'Товарная компенсация: возмещение Ozon' },
    [COMP_MINUS]: { id: 25, code: 'ItemCompensation, минус', name: 'Товарная компенсация: декомпенсация' },
    [UNPARSED]: { id: 0, code: '—', name: 'Не разобрано (новый формат Ozon)' }
};

let typesCache: { at: number; map: Map<number, AccrualType> } | null = null;
const TYPES_TTL_MS = 24 * 60 * 60 * 1000;

/** Справочник один на всех продавцов; держим сутки. Без него — только номера видов. */
export async function getAccrualTypes(cabinet: OzonCabinet): Promise<Map<number, AccrualType>> {
    if (typesCache && Date.now() - typesCache.at < TYPES_TTL_MS) return typesCache.map;
    const raw = await retryOn429(() =>
        post<{ accrual_types?: Array<{ id?: number; name?: string; description?: string }> }>(
            cabinet,
            '/v1/finance/accrual/types',
            {}
        )
    );
    const map = new Map<number, AccrualType>();
    for (const t of raw.accrual_types ?? []) {
        if (typeof t.id === 'number') map.set(t.id, { id: t.id, code: t.name ?? String(t.id), name: t.description ?? t.name ?? '' });
    }
    typesCache = { at: Date.now(), map };
    return map;
}

export function describeType(key: string, types: Map<number, AccrualType>): AccrualType {
    const pseudo = PSEUDO[key];
    if (pseudo) return pseudo;
    const id = Number(key);
    return types.get(id) ?? { id, code: `type_id ${key}`, name: `вид ${key} (нет в справочнике Ozon)` };
}

// ─── Статьи «3 Формы» ────────────────────────────────────────────────────────

/**
 * Как финансист раскладывает начисления Ozon по строкам отчёта «3 Формы».
 * Сверено с его файлом за август 2026 по трём кабинетам: выручка до рубля,
 * логистика и прочие — расхождение 11–37 ₽ на миллионных суммах.
 *
 * Прочие расходы — всё, что не попало в остальные статьи. Возмещения Ozon за
 * потерю и порчу товара финансист в расходы не включает: без них сумма
 * «логистика + прочие» сходится с его файлом до рубля, с ними — нет.
 */
export type FormLine = 'Выручка' | 'Комиссия' | 'Эквайринг' | 'Логистика' | 'Хранение' | 'Реклама' | 'Прочие расходы' | 'Компенсации';

export const FORM_LINES: FormLine[] = ['Выручка', 'Комиссия', 'Эквайринг', 'Логистика', 'Хранение', 'Реклама', 'Прочие расходы', 'Компенсации'];

/** Логистика: Логистика, Доставка до места выдачи, Обратная логистика, Обработка возвратов партнёрами. */
const LOGISTICS = new Set(['32', '29', '59', '45']);
/**
 * Реклама. В августе 2026 были только оплата за клик (41) и за заказ (54);
 * остальные — рекламные по смыслу виды из справочника, в августе их не было,
 * и с финансистом их отнесение не сверено.
 */
const ADS = new Set(['41', '54', '33', '3', '4', '5', '19', '23', '55', '75', '87', '130']);
/** Компенсации — доход, не расход: возмещения по товарной компенсации и прямые. */
const COMPENSATIONS = new Set([COMP_PLUS, '10', '104']);

export function formLineOf(key: string): FormLine {
    if (key === SALE || key === RETURN) return 'Выручка';
    if (key === SALE_COMMISSION) return 'Комиссия';
    if (key === '1') return 'Эквайринг';
    if (LOGISTICS.has(key)) return 'Логистика';
    if (key === '46') return 'Хранение';
    if (ADS.has(key)) return 'Реклама';
    if (COMPENSATIONS.has(key)) return 'Компенсации';
    return 'Прочие расходы';
}

// ─── Агрегат ─────────────────────────────────────────────────────────────────

/** Ячейка: вид × SKU. sku = 0 — начисление без товара. */
export interface AccrualCell {
    key: string;
    sku: number;
    /** Копейки. */
    kop: number;
    /** Штуки: по отправлениям и услугам по товару. У услуг без товара 0. */
    qty: number;
    /** Строк источника. */
    rows: number;
}

export interface AccrualAggregate {
    from: string;
    to: string;
    /** Начислений в источнике. */
    sourceRows: number;
    /** Запросов к Ozon (0 — всё из кэша). */
    requests: number;
    /** Сумма total_amount всех начислений, копейки. */
    totalKop: number;
    /** Продажи по цене продавца разложены: покупатель, баллы Ozon, партнёры. Копейки, за вычетом возвратов. */
    salesSplit: { buyerKop: number; pointsKop: number; partnersKop: number };
    /** Сколько начислений не сошлись с total_amount — остаток в UNPARSED. */
    unparsedRows: number;
    cells: AccrualCell[];
    /** SKU → артикул продавца и название. */
    skus: Record<string, { offerId: string; name: string }>;
    /** Месяцы, взятые из кэша, и когда они скачаны. */
    cached: Array<{ month: string; fetchedAt: number }>;
}

const kop = (v: unknown): number => {
    const raw = v && typeof v === 'object' ? (v as { amount?: unknown }).amount : v;
    const n = typeof raw === 'number' ? raw : Number(raw ?? 0);
    return Number.isFinite(n) ? Math.round(n * 100) : 0;
};

interface RawAccrual {
    total_amount?: { amount?: string };
    accrued_category?: string;
    posting?: {
        products?: Array<{
            sku?: number;
            quantity?: number;
            delivery?: { services?: Array<{ type_id?: number; accrued?: { amount?: string } }> } | null;
            commission?: {
                sale_amount?: { amount?: string };
                sale_price?: { amount?: string };
                bonus?: { amount?: string };
                coinvestment?: { amount?: string };
                commission?: { amount?: string };
            } | null;
        }>;
    } | null;
    item_fees?: { fees?: Array<{ sku?: number; quantity?: number; fees?: Array<{ type_id?: number; accrued?: { amount?: string } }> }> } | null;
    non_item_fee?: { type_id?: number; accrued?: { amount?: string } } | null;
    container_fees?: unknown;
}

/** Накопитель: ключ ячейки — `${key}|${sku}`. */
class Acc {
    cells = new Map<string, AccrualCell>();
    sourceRows = 0;
    requests = 0;
    totalKop = 0;
    unparsedRows = 0;
    split = { buyerKop: 0, pointsKop: 0, partnersKop: 0 };

    add(key: string, sku: number, k: number, qty: number, rows = 1): void {
        const id = `${key}|${sku}`;
        const c = this.cells.get(id) ?? { key, sku, kop: 0, qty: 0, rows: 0 };
        c.kop += k;
        c.qty += qty;
        c.rows += rows;
        this.cells.set(id, c);
    }

    addAccrual(a: RawAccrual): void {
        this.sourceRows++;
        const total = kop(a.total_amount);
        this.totalKop += total;
        let parsed = 0;
        for (const p of a.posting?.products ?? []) {
            const sku = p.sku ?? 0;
            const q = p.quantity ?? 0;
            for (const s of p.delivery?.services ?? []) {
                const v = kop(s.accrued);
                this.add(String(s.type_id ?? 'unknown'), sku, v, q);
                parsed += v;
            }
            const c = p.commission;
            if (c) {
                const sale = kop(c.sale_amount);
                if (sale !== 0) this.add(sale > 0 ? SALE : RETURN, sku, sale, q);
                // Штуки у вознаграждения — как у выручки: возврат вычитается.
                const fee = kop(c.commission);
                if (fee !== 0) this.add(SALE_COMMISSION, sku, fee, sale < 0 ? -q : q);
                this.split.buyerKop += kop(c.sale_price);
                this.split.pointsKop += kop(c.bonus);
                this.split.partnersKop += kop(c.coinvestment);
                parsed += sale + fee;
            }
        }
        for (const f of a.item_fees?.fees ?? []) {
            for (const x of f.fees ?? []) {
                const v = kop(x.accrued);
                this.add(String(x.type_id ?? 'unknown'), f.sku ?? 0, v, f.quantity ?? 0);
                parsed += v;
            }
        }
        if (a.non_item_fee) {
            const v = kop(a.non_item_fee.accrued);
            const t = a.non_item_fee.type_id;
            // Товарная компенсация смешивает доход и расход — разводим по знаку.
            const key = t === 25 ? (v >= 0 ? COMP_PLUS : COMP_MINUS) : String(t ?? 'unknown');
            this.add(key, 0, v, 0);
            parsed += v;
        }
        // container_fees в августе 2026 всегда null, формат неизвестен. Если Ozon
        // начнёт их слать или поменяет что-то ещё, разница не пропадёт молча.
        if (parsed !== total) {
            this.unparsedRows++;
            this.add(UNPARSED, 0, total - parsed, 0);
        }
    }

    merge(a: AccrualAggregate): void {
        this.sourceRows += a.sourceRows;
        this.requests += a.requests;
        this.totalKop += a.totalKop;
        this.unparsedRows += a.unparsedRows;
        this.split.buyerKop += a.salesSplit.buyerKop;
        this.split.pointsKop += a.salesSplit.pointsKop;
        this.split.partnersKop += a.salesSplit.partnersKop;
        for (const c of a.cells) this.add(c.key, c.sku, c.kop, c.qty, c.rows);
    }

    result(from: string, to: string, skus: AccrualAggregate['skus'], cached: AccrualAggregate['cached']): AccrualAggregate {
        return {
            from,
            to,
            sourceRows: this.sourceRows,
            requests: this.requests,
            totalKop: this.totalKop,
            salesSplit: { ...this.split },
            unparsedRows: this.unparsedRows,
            cells: [...this.cells.values()].filter(c => c.kop !== 0 || c.qty !== 0),
            skus,
            cached
        };
    }
}

// ─── Загрузка ────────────────────────────────────────────────────────────────

/** Страница by-day — 1000 начислений; у oz-pixeltap бывает до трёх страниц в день. */
const MAX_PAGES_PER_DAY = 50;
/**
 * Сколько дней качаем разом. Последовательно месяц oz-pixeltap — 61 запрос и
 * 45 секунд; на трёх кабинетах это две минуты. По четыре дня 429 на проверке
 * не было, а если будет — retryOn429 подождёт.
 */
const PARALLEL_DAYS = 4;

async function fetchDay(cabinet: OzonCabinet, date: string, acc: Acc): Promise<void> {
    let lastId = '';
    for (let page = 0; page < MAX_PAGES_PER_DAY; page++) {
        const raw = await retryOn429(
            () =>
                post<{ accruals?: RawAccrual[]; last_id?: string }>(
                    cabinet,
                    '/v1/finance/accrual/by-day',
                    lastId ? { date, last_id: lastId } : { date }
                ),
            5
        );
        acc.requests++;
        for (const a of raw.accruals ?? []) acc.addAccrual(a);
        lastId = raw.last_id ?? '';
        if (!lastId) return;
    }
    throw new Error(`Ozon отдал за ${date} больше ${MAX_PAGES_PER_DAY} страниц начислений — остановились, чтобы не зациклиться.`);
}

function daysOf(from: string, to: string): string[] {
    const out: string[] = [];
    const stop = Date.parse(`${to}T00:00:00Z`);
    for (let t = Date.parse(`${from}T00:00:00Z`); t <= stop; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
    return out;
}

async function fetchRange(cabinet: OzonCabinet, from: string, to: string): Promise<Acc> {
    const acc = new Acc();
    const days = daysOf(from, to);
    let next = 0;
    const worker = async (): Promise<void> => {
        while (next < days.length) {
            const date = days[next++]!;
            await fetchDay(cabinet, date, acc);
        }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL_DAYS, days.length) }, worker));
    return acc;
}

async function productsBySku(cabinet: OzonCabinet, skus: number[], out: AccrualAggregate['skus']): Promise<void> {
    for (let i = 0; i < skus.length; i += 500) {
        const raw = await retryOn429(() =>
            post<{ items?: Array<{ offer_id?: string; name?: string; sku?: number; sources?: Array<{ sku?: number }> }> }>(
                cabinet,
                '/v3/product/info/list',
                { sku: skus.slice(i, i + 500) }
            )
        );
        for (const it of raw.items ?? []) {
            const info = { offerId: it.offer_id ?? '', name: it.name ?? '' };
            for (const s of [it.sku, ...(it.sources ?? []).map(x => x.sku)]) if (s) out[String(s)] = info;
        }
    }
}

/**
 * SKU → артикул продавца. Одна SKU у товара не единственная: у квантов свои.
 * Уценённых товаров /v3/product/info/list не знает вовсе — у них своя SKU,
 * а исходную отдаёт /v1/product/info/discounted. В августе 2026 так не
 * опознавались три SKU из сотни.
 */
export async function resolveSkus(cabinet: OzonCabinet, skus: number[]): Promise<AccrualAggregate['skus']> {
    const out: AccrualAggregate['skus'] = {};
    await productsBySku(cabinet, [...new Set(skus.filter(s => s > 0))], out);
    const missing = [...new Set(skus.filter(s => s > 0 && !out[String(s)]))];
    if (missing.length === 0) return out;
    try {
        const base = new Map<number, number>();
        for (let i = 0; i < missing.length; i += 500) {
            const raw = await retryOn429(() =>
                post<{ items?: Array<{ discounted_sku?: number; sku?: number }> }>(cabinet, '/v1/product/info/discounted', {
                    discounted_skus: missing.slice(i, i + 500)
                })
            );
            for (const it of raw.items ?? []) if (it.discounted_sku && it.sku) base.set(it.discounted_sku, it.sku);
        }
        const unknownBase = [...new Set(base.values())].filter(s => !out[String(s)]);
        if (unknownBase.length) await productsBySku(cabinet, unknownBase, out);
        for (const [disc, sku] of base) {
            const info = out[String(sku)];
            if (info) out[String(disc)] = { offerId: `${info.offerId} (уценка)`, name: info.name };
        }
    } catch {
        // Без артикула уценки отчёт всё равно верен: SKU показана, артикул — «?».
    }
    return out;
}

// ─── Кэш закрытых месяцев ────────────────────────────────────────────────────
//
// Месяц начислений — десятки тысяч строк и полсотни запросов. Закрытый месяц
// не меняется, поэтому храним его агрегатом: ячейки «вид × SKU» плюс артикулы,
// JSON, сжатый zlib. Август oz-pixeltap — около 10 КБ. Сырых строк не храним:
// диск сервера тесный, а для отчёта они не нужны.
//
// Закрытым считаем месяц через 10 дней после конца: начисления за последние
// дни Ozon дописывает с опозданием, и раньше в кэш попала бы неполная картина.

db.exec(`
CREATE TABLE IF NOT EXISTS ozon_accruals_month (
  cabinet    TEXT NOT NULL,
  month      TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  data       BLOB NOT NULL,
  PRIMARY KEY (cabinet, month)
);
`);

const CLOSE_AFTER_DAYS = 10;

/** Последний день месяца YYYY-MM. */
const monthEnd = (month: string): string => {
    const [y, m] = month.split('-').map(Number) as [number, number];
    return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

/** Месяц закрыт, если с его конца прошло CLOSE_AFTER_DAYS дней по Москве. */
export function isClosedMonth(month: string, now = Date.now()): boolean {
    const end = Date.parse(`${monthEnd(month)}T00:00:00Z`) - 3 * 3_600_000;
    return now - end > (CLOSE_AFTER_DAYS + 1) * 86_400_000;
}

function readMonth(cabinet: string, month: string): { agg: AccrualAggregate; fetchedAt: number } | null {
    const row = db.prepare('SELECT fetched_at, data FROM ozon_accruals_month WHERE cabinet = ? AND month = ?').get(cabinet, month) as
        | { fetched_at: number; data: Buffer }
        | undefined;
    if (!row) return null;
    try {
        const agg = JSON.parse(inflateSync(row.data).toString('utf8')) as AccrualAggregate;
        return { agg, fetchedAt: row.fetched_at };
    } catch {
        return null; // битая запись — перекачаем
    }
}

function writeMonth(cabinet: string, month: string, agg: AccrualAggregate): void {
    // В кэш — только то, что не меняется: без отметок о запросах и кэше.
    const slim: AccrualAggregate = { ...agg, requests: 0, cached: [] };
    db.prepare(
        'INSERT INTO ozon_accruals_month (cabinet, month, fetched_at, data) VALUES (?, ?, ?, ?) ' +
            'ON CONFLICT(cabinet, month) DO UPDATE SET fetched_at = excluded.fetched_at, data = excluded.data'
    ).run(cabinet, month, Math.floor(Date.now() / 1000), deflateSync(Buffer.from(JSON.stringify(slim)), { level: 9 }));
}

/** Свежие (незакрытые) окна держим в памяти полчаса: повторный вызов в том же разговоре не качает заново. */
const LIVE_TTL_MS = 30 * 60 * 1000;
const liveCache = new Map<string, { at: number; agg: AccrualAggregate }>();

/** Окна по календарным месяцам: [from, to, month, целый ли месяц]. */
export function monthWindows(from: string, to: string): Array<{ from: string; to: string; month: string; whole: boolean }> {
    const out: Array<{ from: string; to: string; month: string; whole: boolean }> = [];
    let cur = from;
    while (cur <= to) {
        const month = cur.slice(0, 7);
        const end = monthEnd(month);
        const winTo = end < to ? end : to;
        out.push({ from: cur, to: winTo, month, whole: cur === `${month}-01` && winTo === end });
        const next = new Date(Date.parse(`${end}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
        cur = next;
    }
    return out;
}

async function windowAggregate(
    cabinet: OzonCabinet,
    w: { from: string; to: string; month: string; whole: boolean },
    refresh: boolean
): Promise<{ agg: AccrualAggregate; fetchedAt?: number }> {
    const closed = w.whole && isClosedMonth(w.month);
    if (closed && !refresh) {
        const hit = readMonth(cabinet.slug, w.month);
        if (hit) return { agg: hit.agg, fetchedAt: hit.fetchedAt };
    }
    const liveKey = `${cabinet.slug}:${w.from}:${w.to}`;
    const live = liveCache.get(liveKey);
    if (!closed && !refresh && live && Date.now() - live.at < LIVE_TTL_MS) return { agg: live.agg };

    const acc = await fetchRange(cabinet, w.from, w.to);
    const skuList = [...new Set([...acc.cells.values()].map(c => c.sku))];
    const skus = await resolveSkus(cabinet, skuList);
    const agg = acc.result(w.from, w.to, skus, []);
    if (closed) writeMonth(cabinet.slug, w.month, agg);
    else liveCache.set(liveKey, { at: Date.now(), agg });
    return { agg };
}

/**
 * Начисления за период, склеенные из окон по календарным месяцам. Закрытые
 * целые месяцы берутся из кэша, остальное качается по дням.
 */
export async function getOzonAccruals(
    cabinet: OzonCabinet,
    params: { from: string; to: string; refresh?: boolean }
): Promise<AccrualAggregate> {
    const acc = new Acc();
    const skus: AccrualAggregate['skus'] = {};
    const cached: AccrualAggregate['cached'] = [];
    for (const w of monthWindows(params.from, params.to)) {
        const { agg, fetchedAt } = await windowAggregate(cabinet, w, params.refresh === true);
        acc.merge(agg);
        Object.assign(skus, agg.skus);
        if (fetchedAt) cached.push({ month: w.month, fetchedAt });
    }
    return acc.result(params.from, params.to, skus, cached);
}
