/**
 * Минимальный клиент Ozon Seller API. Пока нужен только панели: показать
 * владельцу, какие кабинеты подключены и что в них доступно.
 *
 * Авторизация проще, чем у WB: два заголовка, Client-Id и Api-Key.
 * Ключ выпускается с ролью Admin read only — изменить им ничего нельзя.
 */

export interface OzonCabinet {
    slug: string;
    clientId: string;
    apiKey: string;
    /**
     * Ключи рекламного кабинета — другая служба и другая пара доступов,
     * см. ozon/performance.ts. Необязательны: кабинет без них просто живёт
     * без рекламы, остальные инструменты работают как прежде.
     */
    perf?: { clientId: string; secret: string };
}

export interface OzonSellerInfo {
    company: { name: string; ownership_form: string; legal_name: string; inn: string };
    subscription: { is_premium: boolean; type: string } | null;
}

const BASE = 'https://api-seller.ozon.ru';

export class OzonApiError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly path: string
    ) {
        super(message);
        this.name = 'OzonApiError';
    }

    /** Текст для человека. Тело ответа Ozon в 4xx обычно само объясняет причину — роль ключа, подписку. */
    toUserMessage(): string {
        if (this.status === 429) return `Ozon ограничил частоту запросов (429) на ${this.path}. Повторите через минуту.`;
        if (this.status >= 500) return `Ozon сейчас не отвечает (${this.status}) на ${this.path} — сбой на их стороне. Попробуйте позже.`;
        // Так Ozon отвечает на снятый метод — это поломка коннектора, а не отказ.
        if (this.status === 404 && /page not found/i.test(this.message)) {
            return `Ozon больше не поддерживает метод ${this.path} — нужна правка коннектора, сообщите администратору.`;
        }
        if (this.status === 401) return 'Ozon не принял ключ (401). Возможно, ключ API отозван в кабинете продавца.';
        return `Ozon отказал (${this.status}) на ${this.path}: ${this.message}`;
    }
}

async function post<T>(cabinet: OzonCabinet, path: string, body: unknown): Promise<T> {
    const res = await fetch(BASE + path, {
        method: 'POST',
        headers: {
            'Client-Id': cabinet.clientId,
            'Api-Key': cabinet.apiKey,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(20_000)
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new OzonApiError(text.slice(0, 200) || res.statusText, res.status, path);
    }
    return (await res.json()) as T;
}

export const getOzonSellerInfo = (cabinet: OzonCabinet): Promise<OzonSellerInfo> =>
    post<OzonSellerInfo>(cabinet, '/v1/seller/info', {});

/**
 * Что в кабинете доступно, а что закрыто подпиской. Отзывы и вопросы Ozon
 * отдаёт только при Premium Plus и «Управлении отзывами» соответственно —
 * проверено 02.09.2026, все три кабинета отвечали 403.
 */
export interface OzonAccess {
    reviews: boolean;
    questions: boolean;
    chats: boolean;
}

export async function probeOzonAccess(cabinet: OzonCabinet): Promise<OzonAccess> {
    const ok = async (path: string, body: unknown): Promise<boolean> => {
        try {
            await post(cabinet, path, body);
            return true;
        } catch (e) {
            if (e instanceof OzonApiError && e.status === 403) return false;
            // Прочие ошибки — не отказ по правам, честнее показать как доступно.
            return true;
        }
    };
    const [reviews, questions, chats] = await Promise.all([
        ok('/v1/review/count', {}),
        ok('/v1/question/count', {}),
        ok('/v3/chat/list', { limit: 1 })
    ]);
    return { reviews, questions, chats };
}

// ─── Данные кабинета ─────────────────────────────────────────────────────────
//
// Всё ниже — только чтение. Отзывы и вопросы Ozon отдаёт лишь по подписке
// Premium Plus, поэтому их здесь нет: на 03.09.2026 все три кабинета
// отвечали на них 403.

export interface OzonProduct {
    product_id: number;
    offer_id: string;
    has_fbo_stocks?: boolean;
    has_fbs_stocks?: boolean;
    archived?: boolean;
    quants?: unknown[];
}

export const listOzonProducts = (
    cabinet: OzonCabinet,
    params: { limit?: number; lastId?: string } = {}
): Promise<{ result: { items: OzonProduct[]; total: number; last_id: string } }> =>
    post(cabinet, '/v3/product/list', {
        filter: { visibility: 'ALL' },
        limit: Math.min(params.limit ?? 100, 1000),
        last_id: params.lastId ?? ''
    });

export interface OzonStockRow {
    product_id: number;
    offer_id: string;
    stocks: Array<{ type?: string; present?: number; reserved?: number }>;
}

export const getOzonStocks = (
    cabinet: OzonCabinet,
    params: { limit?: number; cursor?: string } = {}
): Promise<{ items: OzonStockRow[]; total: number; cursor: string }> =>
    post(cabinet, '/v4/product/info/stocks', {
        filter: { visibility: 'ALL' },
        limit: Math.min(params.limit ?? 100, 1000),
        cursor: params.cursor ?? ''
    });

export interface OzonPriceRow {
    product_id: number;
    offer_id: string;
    price?: {
        price?: string;
        old_price?: string;
        /** Цена с учётом акций продавца. Поля marketing_price — с акциями Ozon — в v5 больше нет. */
        marketing_seller_price?: string;
        min_price?: string;
        currency_code?: string;
    };
}

export const getOzonPrices = (
    cabinet: OzonCabinet,
    params: { limit?: number; cursor?: string } = {}
): Promise<{ items: OzonPriceRow[]; total: number; cursor: string }> =>
    post(cabinet, '/v5/product/info/prices', {
        filter: { visibility: 'ALL' },
        limit: Math.min(params.limit ?? 100, 1000),
        cursor: params.cursor ?? ''
    });

export interface OzonPosting {
    order_id: number;
    order_number: string;
    posting_number: string;
    status: string;
    substatus?: string;
    created_at: string;
    in_process_at?: string;
    products?: Array<{ name?: string; offer_id?: string; sku?: number; quantity?: number; price?: string }>;
}

/** Заказы со складов Ozon. */
export const listFboPostings = (
    cabinet: OzonCabinet,
    since: string,
    to: string,
    limit = 50
): Promise<{ result: OzonPosting[] }> =>
    post(cabinet, '/v2/posting/fbo/list', {
        filter: { since, to },
        limit: Math.min(limit, 1000),
        offset: 0,
        with: { analytics_data: false, financial_data: false }
    });

/** Заказы со склада продавца. */
export const listFbsPostings = (
    cabinet: OzonCabinet,
    since: string,
    to: string,
    limit = 50
): Promise<{ result: { postings: OzonPosting[]; has_next: boolean } }> =>
    post(cabinet, '/v3/posting/fbs/list', {
        filter: { since, to },
        limit: Math.min(limit, 1000),
        offset: 0,
        with: { analytics_data: false, financial_data: false }
    });

export interface OzonReturn {
    id: number;
    return_reason_name?: string;
    type?: string;
    schema?: string;
    order_number?: string;
    posting_number?: string;
    product?: { name?: string; offer_id?: string; sku?: number; price?: { price?: string; currency_code?: string } };
    visual?: { status?: { display_name?: string; sys_name?: string } };
    place?: { name?: string };
    logistic?: { return_date?: string };
}

export const listOzonReturns = (
    cabinet: OzonCabinet,
    limit = 20
): Promise<{ returns: OzonReturn[]; has_next: boolean }> =>
    post(cabinet, '/v1/returns/list', { limit: Math.min(limit, 500) });

export interface OzonChat {
    chat?: { chat_id?: string; chat_status?: string; chat_type?: string; created_at?: string };
    first_unread_message_id?: number;
    last_message_id?: number;
    unread_count?: number;
}

export const listOzonChats = (cabinet: OzonCabinet, limit = 30): Promise<{ chats: OzonChat[] }> =>
    post(cabinet, '/v3/chat/list', { limit: Math.min(limit, 1000), filter: { unread_only: false } });

// ─── Аналитика, остатки по складам и финансы ─────────────────────────────────
//
// Всё проверено на живых кабинетах 04.09.2026. Три замечания, которые стоили
// времени и которые легко забыть:
//
// 1. Ozon выбросил почти все показатели воронки: delivered_units, returns,
//    cancellations, hits_view*, hits_tocart*, session_view*, conv_tocart*,
//    position_category, postings, adv_* отвечают «deprecated metrics used».
//    Остались ровно два: revenue и ordered_units. Просить больше нельзя —
//    один устаревший показатель роняет весь запрос в 400.
// 2. Если попросить смесь живых и мёртвых показателей, Ozon не ругается,
//    а молча возвращает только живые. Порядок значений в metrics совпадает
//    с порядком запроса, поэтому разъезд легко не заметить.
// 3. Аналитика ограничена по частоте жёстче остального API: третий запрос
//    подряд с паузой в секунду уже ловит 429. Отсюда retryOn429 ниже.

/** Живые показатели аналитики. Больше просить нельзя — запрос упадёт целиком. */
export const OZON_METRICS = ['revenue', 'ordered_units'] as const;

async function retryOn429<T>(run: () => Promise<T>, tries = 3): Promise<T> {
    let wait = 2000;
    for (let i = 0; ; i++) {
        try {
            return await run();
        } catch (e) {
            const limited = e instanceof OzonApiError && (e.status === 429 || e.status === 503);
            if (!limited || i >= tries - 1) throw e;
            await new Promise(r => setTimeout(r, wait));
            wait *= 2;
        }
    }
}

export interface OzonAnalyticsRow {
    /** Для разреза по товару — SKU и название; по дню — дата. */
    id: string;
    name: string;
    revenue: number;
    orderedUnits: number;
}

export interface OzonAnalytics {
    rows: OzonAnalyticsRow[];
    totalRevenue: number;
    totalUnits: number;
}

interface RawAnalytics {
    result?: {
        data?: Array<{ dimensions?: Array<{ id?: string; name?: string }>; metrics?: number[] }>;
        totals?: number[];
    };
}

export async function getOzonAnalytics(
    cabinet: OzonCabinet,
    params: { dateFrom: string; dateTo: string; dimension: 'sku' | 'day'; limit?: number }
): Promise<OzonAnalytics> {
    const raw = await retryOn429(() =>
        post<RawAnalytics>(cabinet, '/v1/analytics/data', {
            date_from: params.dateFrom,
            date_to: params.dateTo,
            metrics: [...OZON_METRICS],
            dimension: [params.dimension],
            limit: Math.min(params.limit ?? 20, 1000),
            offset: 0
        })
    );
    const rows = (raw.result?.data ?? []).map(r => ({
        id: r.dimensions?.[0]?.id ?? '',
        name: r.dimensions?.[0]?.name ?? '',
        revenue: r.metrics?.[0] ?? 0,
        orderedUnits: r.metrics?.[1] ?? 0
    }));
    const totals = raw.result?.totals ?? [];
    return { rows, totalRevenue: totals[0] ?? 0, totalUnits: totals[1] ?? 0 };
}

export interface OzonWarehouseStock {
    sku: number;
    warehouseName: string;
    offerId: string;
    name: string;
    /** Свободно к продаже. */
    free: number;
    reserved: number;
    /** Ожидается поставкой. */
    promised: number;
}

interface RawStockRow {
    sku?: number;
    warehouse_name?: string;
    item_code?: string;
    item_name?: string;
    free_to_sell_amount?: number;
    reserved_amount?: number;
    promised_amount?: number;
}

/**
 * Остатки в разрезе складов. Каждая строка — пара «товар × склад», сводных
 * строк здесь нет, поэтому складывать их можно без опаски: на Wildberries
 * такая же на вид выгрузка содержала строку «Всего на складах», и наивная
 * сумма задваивала остаток вдвое.
 */
export async function getOzonWarehouseStocks(cabinet: OzonCabinet): Promise<OzonWarehouseStock[]> {
    // Одна страница вмещает 1000 строк, а строка — это пара «товар × склад».
    // У кабинета с сотней товаров и двумя десятками складов страниц будет
    // несколько, и остановка на первой молча покажет неполный остаток.
    const PAGE = 1000;
    const all: RawStockRow[] = [];
    for (let offset = 0; offset < 20_000; offset += PAGE) {
        const raw = await retryOn429(() =>
            post<{ result?: { rows?: RawStockRow[] } }>(cabinet, '/v2/analytics/stock_on_warehouses', {
                limit: PAGE,
                offset,
                warehouse_type: 'ALL'
            })
        );
        const rows = raw.result?.rows ?? [];
        all.push(...rows);
        if (rows.length < PAGE) break;
    }
    return all.map(r => ({
        sku: r.sku ?? 0,
        warehouseName: r.warehouse_name ?? '',
        offerId: r.item_code ?? '',
        name: r.item_name ?? '',
        free: r.free_to_sell_amount ?? 0,
        reserved: r.reserved_amount ?? 0,
        promised: r.promised_amount ?? 0
    }));
}

/**
 * Итоги расчётов за период. Значения — рубли с копейками (не копейки!):
 * проверено сверкой с оборотом кабинета. Расходы приходят отрицательными,
 * поэтому «к перечислению» — это просто сумма всех полей.
 */
// ─── Финансы: баланс за период ───────────────────────────────────────────────

/**
 * Итоги расчётов с Ozon за период.
 *
 * До октября 2026 брались из /v3/finance/transaction/totals. Ozon снял его без
 * предупреждения: к 05.10.2026 и он, и /v3/finance/transaction/list отвечают
 * «404 page not found» на всех трёх кабинетах, и ozon_finance молча не работал.
 * Замена — /v1/finance/balance: продажи, возвраты, услуги, начислено и
 * выплачено, плюс остаток на начало и конец. Период — не длиннее месяца,
 * поэтому длинный разбивается на куски.
 *
 * Главное, чего у старого метода не было: продажи разложены на то, что
 * заплатили покупатели (revenue), и то, что докрыл Ozon баллами за скидки
 * (points_for_discounts). По oz-harbez за неделю 28.09–04.10 это 2,26 и
 * 3,17 млн ₽: Ozon оплачивает больше половины цены продавца.
 */
export interface OzonFlow {
    /** Всего по цене продавца. */
    amount: number;
    /** Вознаграждение Ozon. Отрицательное. */
    fee: number;
    /** Сколько заплатили покупатели. */
    revenue: number;
    /** Сколько докрыл Ozon баллами за скидки. */
    points: number;
    /** Партнёрские программы — софинансирование банка и подобное. */
    partners: number;
}

export interface OzonBalance {
    from: string;
    to: string;
    openingBalance: number;
    closingBalance: number;
    accrued: number;
    paid: number;
    sales: OzonFlow;
    returns: OzonFlow;
    /** Услуги по видам, отрицательные — удержания. */
    services: Array<{ name: string; amount: number }>;
}

/** Ozon отдаёт суммы то объектом {value}, то строкой: points_for_discounts приходит как "3166821.88". */
const sumOf = (v: unknown): number => {
    if (typeof v === 'number') return v;
    if (typeof v === 'string') return Number(v) || 0;
    if (v && typeof v === 'object') return Number((v as { value?: unknown }).value ?? 0) || 0;
    return 0;
};

interface RawFlow {
    amount?: unknown;
    fee?: unknown;
    amount_details?: { revenue?: unknown; points_for_discounts?: unknown; partner_programs?: unknown };
}

const flowOf = (f: RawFlow | undefined): OzonFlow => ({
    amount: sumOf(f?.amount),
    fee: sumOf(f?.fee),
    revenue: sumOf(f?.amount_details?.revenue),
    points: sumOf(f?.amount_details?.points_for_discounts),
    partners: sumOf(f?.amount_details?.partner_programs)
});

const addFlow = (a: OzonFlow, b: OzonFlow): OzonFlow => ({
    amount: a.amount + b.amount,
    fee: a.fee + b.fee,
    revenue: a.revenue + b.revenue,
    points: a.points + b.points,
    partners: a.partners + b.partners
});

/** Куски не длиннее 28 дней: Ozon отказывает с «maximum period is one month», а месяцы разной длины. */
export function splitPeriod(from: string, to: string, maxDays = 28): Array<[string, string]> {
    const day = 86_400_000;
    const out: Array<[string, string]> = [];
    let start = Date.parse(`${from}T00:00:00Z`);
    const stop = Date.parse(`${to}T00:00:00Z`);
    while (start <= stop) {
        const end = Math.min(start + (maxDays - 1) * day, stop);
        out.push([new Date(start).toISOString().slice(0, 10), new Date(end).toISOString().slice(0, 10)]);
        start = end + day;
    }
    return out;
}

export async function getOzonBalance(cabinet: OzonCabinet, params: { from: string; to: string }): Promise<OzonBalance> {
    const chunks = splitPeriod(params.from, params.to);
    const zero: OzonFlow = { amount: 0, fee: 0, revenue: 0, points: 0, partners: 0 };
    const acc: OzonBalance = {
        from: params.from,
        to: params.to,
        openingBalance: 0,
        closingBalance: 0,
        accrued: 0,
        paid: 0,
        sales: zero,
        returns: zero,
        services: []
    };
    const services = new Map<string, number>();
    for (const [i, [from, to]] of chunks.entries()) {
        const raw = await retryOn429(() =>
            post<{
                total?: { opening_balance?: unknown; closing_balance?: unknown; accrued?: unknown; payments?: unknown[] };
                cashflows?: { sales?: RawFlow; returns?: RawFlow; services?: Array<{ name?: string; amount?: unknown }> };
            }>(cabinet, '/v1/finance/balance', { date_from: from, date_to: to })
        );
        if (i === 0) acc.openingBalance = sumOf(raw.total?.opening_balance);
        if (i === chunks.length - 1) acc.closingBalance = sumOf(raw.total?.closing_balance);
        acc.accrued += sumOf(raw.total?.accrued);
        acc.paid += (raw.total?.payments ?? []).reduce<number>((s, p) => s + sumOf(p), 0);
        acc.sales = addFlow(acc.sales, flowOf(raw.cashflows?.sales));
        acc.returns = addFlow(acc.returns, flowOf(raw.cashflows?.returns));
        for (const sv of raw.cashflows?.services ?? []) {
            const name = sv.name ?? 'other';
            services.set(name, (services.get(name) ?? 0) + sumOf(sv.amount));
        }
    }
    acc.services = [...services.entries()].map(([name, amount]) => ({ name, amount })).sort((a, b) => a.amount - b.amount);
    return acc;
}

// ─── Цена покупателя: отчёт о реализации ─────────────────────────────────────

/**
 * Сколько покупатели фактически заплатили за каждый товар.
 *
 * В API цен этого больше нет: /v5/product/info/prices отдаёт цену продавца, а
 * поле marketing_price — цену с учётом акций Ozon — убрали. Видимо, потому,
 * что скидки Ozon теперь персональные («AI benefit system» в списке акций
 * заказа): одной цены на сайте больше не существует. В заказе цена тоже
 * продавцова, а скидку Ozon доплачивает продавцу отдельно баллами.
 *
 * Настоящая цена покупателя есть только в отчёте о реализации: по каждой
 * проданной штуке seller_price_per_instance (цена продавца) раскладывается на
 * price_per_instance (заплатил покупатель) + bonus (баллы за скидки от Ozon) +
 * bank_coinvestment и pick_up_point_coinvestment. Сверено до копейки:
 * 2100 = 1096,28 + 992,76 + 10,96.
 *
 * Отчёт помесячный и появляется после закрытия месяца. По дням Ozon отдаёт
 * его только на подписке Premium Plus — у нас Premium.
 */
export interface OzonRealizationItem {
    offerId: string;
    name: string;
    sku: number;
    /** Продано штук. Возвраты не вычитаются: речь о цене покупки, а не об обороте. */
    qty: number;
    /** Сумма по цене продавца. */
    sellerSum: number;
    /** Сколько заплатили покупатели. */
    buyerSum: number;
    /**
     * Разброс цены покупателя за штуку. Скидки Ozon персональные, и средняя
     * прячет, что один платит 249 ₽, а другой заметно больше, — для контроля
     * цен это важнее средней.
     */
    minPrice: number;
    maxPrice: number;
}

export interface OzonRealization {
    year: number;
    month: number;
    items: OzonRealizationItem[];
}

interface RawRealizationRow {
    item?: { name?: string; offer_id?: string; sku?: number };
    seller_price_per_instance?: number;
    delivery_commission?: { price_per_instance?: number; quantity?: number; amount?: number } | null;
}

/** Закрытый месяц не меняется — держим долго. Отчёт тяжёлый: по oz-harbez за сентябрь 6,7 МБ. */
const REALIZATION_TTL_MS = 12 * 60 * 60 * 1000;
const realizationCache = new Map<string, { at: number; data: OzonRealization | null }>();

/** Отчёт за месяц или null, если Ozon его ещё не выпустил. */
export async function getOzonRealization(cabinet: OzonCabinet, year: number, month: number): Promise<OzonRealization | null> {
    const key = `${cabinet.slug}:${year}-${month}`;
    const hit = realizationCache.get(key);
    if (hit && Date.now() - hit.at < REALIZATION_TTL_MS) return hit.data;

    let rows: RawRealizationRow[];
    try {
        const raw = await retryOn429(() =>
            post<{ result?: { rows?: RawRealizationRow[] } }>(cabinet, '/v2/finance/realization', { month, year })
        );
        rows = raw.result?.rows ?? [];
    } catch (e) {
        // «Report was not found» — месяц ещё не закрыт. Не путать с «404 page
        // not found»: так Ozon отвечает на снятый метод, это настоящая поломка.
        if (e instanceof OzonApiError && e.status === 404 && /report/i.test(e.message)) {
            realizationCache.set(key, { at: Date.now(), data: null });
            return null;
        }
        throw e;
    }

    const by = new Map<string, OzonRealizationItem>();
    for (const r of rows) {
        const dc = r.delivery_commission;
        const qty = dc?.quantity ?? 0;
        if (!dc || qty <= 0 || !r.item?.offer_id) continue;
        const paid = typeof dc.amount === 'number' ? dc.amount : (dc.price_per_instance ?? 0) * qty;
        const perInstance = dc.price_per_instance ?? paid / qty;
        const cur = by.get(r.item.offer_id) ?? {
            offerId: r.item.offer_id,
            name: r.item.name ?? '',
            sku: r.item.sku ?? 0,
            qty: 0,
            sellerSum: 0,
            buyerSum: 0,
            minPrice: perInstance,
            maxPrice: perInstance
        };
        cur.qty += qty;
        cur.sellerSum += (r.seller_price_per_instance ?? 0) * qty;
        cur.buyerSum += paid;
        cur.minPrice = Math.min(cur.minPrice, perInstance);
        cur.maxPrice = Math.max(cur.maxPrice, perInstance);
        by.set(r.item.offer_id, cur);
    }
    const data: OzonRealization = { year, month, items: [...by.values()].sort((a, b) => b.qty - a.qty) };
    realizationCache.set(key, { at: Date.now(), data });
    return data;
}


// ─── Постраничный сбор ───────────────────────────────────────────────────────
//
// Ozon отдаёт не больше тысячи строк за раз и присылает метку продолжения:
// last_id у списка товаров, cursor у остатков и цен. Кабинеты сейчас
// маленькие — от 36 до 62 товаров, — но полагаться на это нельзя: вырастет
// ассортимент, и остатки молча покажутся неполными. Ровно так уже вышло
// в 1С, где из 2423 строк бралась тысяча.

const PAGE = 1000;
/** Предохранитель от бесконечного цикла, если площадка перестанет двигать метку. */
const MAX_PAGES = 50;

export async function listAllOzonProducts(cabinet: OzonCabinet): Promise<OzonProduct[]> {
    const out: OzonProduct[] = [];
    let lastId = '';
    for (let page = 0; page < MAX_PAGES; page++) {
        const res = await listOzonProducts(cabinet, { limit: PAGE, lastId });
        const items = res.result?.items ?? [];
        out.push(...items);
        lastId = res.result?.last_id ?? '';
        if (items.length < PAGE || !lastId) break;
    }
    return out;
}

export async function getAllOzonStocks(cabinet: OzonCabinet): Promise<OzonStockRow[]> {
    const out: OzonStockRow[] = [];
    let cursor = '';
    for (let page = 0; page < MAX_PAGES; page++) {
        const res = await getOzonStocks(cabinet, { limit: PAGE, cursor });
        const items = res.items ?? [];
        out.push(...items);
        cursor = res.cursor ?? '';
        if (items.length < PAGE || !cursor) break;
    }
    return out;
}

export async function getAllOzonPrices(cabinet: OzonCabinet): Promise<OzonPriceRow[]> {
    const out: OzonPriceRow[] = [];
    let cursor = '';
    for (let page = 0; page < MAX_PAGES; page++) {
        const res = await getOzonPrices(cabinet, { limit: PAGE, cursor });
        const items = res.items ?? [];
        out.push(...items);
        cursor = res.cursor ?? '';
        if (items.length < PAGE || !cursor) break;
    }
    return out;
}


export interface OzonChatMessage {
    messageId: string;
    /** Кто написал: покупатель, продавец или служебное уведомление Ozon. */
    author: string;
    createdAt: string;
    isRead: boolean;
    isImage: boolean;
    text: string;
}

/**
 * Переписка внутри одного чата.
 *
 * Отзывы Ozon закрыты подпиской, а вот чаты — нет: и список, и история
 * читаются обычным ключом. Это единственный канал общения с покупателем,
 * доступный без доплаты.
 *
 * Осторожно с содержимым: в чатах вперемешку идут сообщения покупателей
 * и служебные уведомления самого Ozon («заберите возвраты из точки выдачи»).
 * Их различает тип автора, и смешивать их в одну ленту нельзя — человек
 * будет искать вопрос покупателя среди рассылки.
 */
export async function getOzonChatHistory(
    cabinet: OzonCabinet,
    chatId: string,
    limit = 30
): Promise<OzonChatMessage[]> {
    const raw = await post<{
        messages?: Array<{
            message_id?: string | number;
            user?: { type?: string };
            created_at?: string;
            is_read?: boolean;
            is_image?: boolean;
            data?: string[];
        }>;
    }>(cabinet, '/v3/chat/history', {
        chat_id: chatId,
        limit: Math.min(limit, 1000),
        direction: 'Backward'
    });
    return (raw.messages ?? []).map(m => ({
        messageId: String(m.message_id ?? ''),
        author: m.user?.type ?? 'Unknown',
        createdAt: m.created_at ?? '',
        isRead: m.is_read === true,
        isImage: m.is_image === true,
        text: (m.data ?? []).join(' ').trim()
    }));
}
