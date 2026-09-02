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
