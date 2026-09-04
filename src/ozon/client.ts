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
        marketing_price?: string;
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
export interface OzonFinanceTotals {
    accrualsForSale: number;
    saleCommission: number;
    processingAndDelivery: number;
    refundsAndCancellations: number;
    servicesAmount: number;
    compensationAmount: number;
    moneyTransfer: number;
    othersAmount: number;
    /** Сумма всех полей: сколько остаётся продавцу. */
    net: number;
}

export async function getOzonFinanceTotals(
    cabinet: OzonCabinet,
    params: { from: string; to: string }
): Promise<OzonFinanceTotals> {
    const raw = await retryOn429(() =>
        post<{ result?: Record<string, number> }>(cabinet, '/v3/finance/transaction/totals', {
            date: { from: `${params.from}T00:00:00.000Z`, to: `${params.to}T23:59:59.999Z` },
            transaction_type: 'all'
        })
    );
    const r = raw.result ?? {};
    const num = (k: string): number => r[k] ?? 0;
    const totals = {
        accrualsForSale: num('accruals_for_sale'),
        saleCommission: num('sale_commission'),
        processingAndDelivery: num('processing_and_delivery'),
        refundsAndCancellations: num('refunds_and_cancellations'),
        servicesAmount: num('services_amount'),
        compensationAmount: num('compensation_amount'),
        moneyTransfer: num('money_transfer'),
        othersAmount: num('others_amount')
    };
    const net = Object.values(totals).reduce((a, b) => a + b, 0);
    return { ...totals, net };
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
