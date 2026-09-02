import { config } from '../config.js';
import { logger } from '../logger.js';
import type { BucketKey, Cabinet } from './cabinets.js';
import { sleep } from './ratelimit.js';

/**
 * Области WB API. У каждой свой хост, своя категория токена и свои лимиты.
 * Лимиты живут в вёдрах кабинета, см. BUCKET_LIMITS в wb/cabinets.ts.
 *
 * Хосты ниже не из головы: все проверены запросами с боевого сервера 02.09.2026,
 * каждый ответил 200 на указанный рядом метод.
 */
export type WbCategory = BucketKey;

const HOSTS: Record<WbCategory, { prod: string; sandbox: string | null }> = {
    // Вопросы, отзывы, закреплённые отзывы
    feedbacks: {
        prod: 'https://feedbacks-api.wildberries.ru',
        sandbox: 'https://feedbacks-api-sandbox.wildberries.ru'
    },
    // Чат с покупателями. Отдельного sandbox-хоста у WB нет — проверено по DNS.
    chat: { prod: 'https://buyer-chat-api.wildberries.ru', sandbox: null },
    // Заявки покупателей на возврат: /api/v1/claims
    returns: { prod: 'https://returns-api.wildberries.ru', sandbox: null },
    // Общие методы: информация о продавце, проверка подключения
    common: { prod: 'https://common-api.wildberries.ru', sandbox: null },
    // Заказы FBS, сборочные задания, склады: /api/v3/orders, /api/v3/warehouses
    marketplace: { prod: 'https://marketplace-api.wildberries.ru', sandbox: null },
    // Карточки товаров: /content/v2/get/cards/list (POST)
    content: { prod: 'https://content-api.wildberries.ru', sandbox: null },
    // Цены и скидки: /api/v2/list/goods/filter
    prices: { prod: 'https://discounts-prices-api.wildberries.ru', sandbox: null },
    // Заказы и продажи по датам, отчёт о реализации: /api/v1/supplier/orders
    statistics: { prod: 'https://statistics-api.wildberries.ru', sandbox: null },
    // Остатки на складах и продажи по регионам: /api/v1/warehouse_remains
    analytics: { prod: 'https://seller-analytics-api.wildberries.ru', sandbox: null },
    // Поставки FBW: /api/v1/supplies (POST)
    supplies: { prod: 'https://supplies-api.wildberries.ru', sandbox: null },
    // Баланс продавца: /api/v1/account/balance
    finance: { prod: 'https://finance-api.wildberries.ru', sandbox: null }
};

/**
 * Области, которые обслуживает широкий токен «только чтение». Всё остальное —
 * отзывы и чат — идёт узким токеном с правом записи.
 */
const DATA_AREAS: ReadonlySet<WbCategory> = new Set<WbCategory>([
    // Возвраты тоже здесь: у узкого токена ответов категории «Возвраты» нет.
    'returns',
    'marketplace',
    'content',
    'prices',
    'statistics',
    'analytics',
    'supplies',
    'finance'
]);

function tokenFor(cabinet: Cabinet, category: WbCategory): string {
    if (!DATA_AREAS.has(category)) return cabinet.token;
    if (!cabinet.dataToken) {
        throw new WbApiError(
            `Кабинету «${cabinet.slug}» не задан токен данных (WB_DATA_TOKEN_${cabinet.slug.toUpperCase()}), ` +
                'поэтому заказы, карточки и остатки по нему недоступны.',
            501,
            category,
            ''
        );
    }
    return cabinet.dataToken;
}

// Вёдра лимитов живут в самом кабинете: лимиты WB считаются на аккаунт
// продавца, поэтому у каждого кабинета они свои.

export class WbApiError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly category: WbCategory,
        readonly path: string,
        readonly body?: unknown,
        readonly retryAfterSeconds?: number
    ) {
        super(message);
        this.name = 'WbApiError';
    }

    /** Текст, который безопасно и полезно показать модели и пользователю. */
    toUserMessage(): string {
        switch (this.status) {
            case 401:
                return 'WB отклонил токен (401). Проверьте: токен не истёк (живёт 180 дней), у него есть нужная категория, и он не удалён в ЛК.';
            case 403:
                return 'WB запретил доступ (403). Токен не должен быть создан удалённым пользователем, а метод — быть заблокирован для магазина.';
            case 404:
                return `WB не нашёл метод ${this.path} (404). Возможно, метод изменился — сверьтесь с dev.wildberries.ru.`;
            case 429:
                return `WB ограничил частоту запросов (429). Повтор возможен через ${this.retryAfterSeconds ?? '?'} с.`;
            default:
                return `WB вернул ошибку ${this.status} на ${this.path}: ${this.message}`;
        }
    }
}

interface RequestOptions {
    cabinet: Cabinet;
    category: WbCategory;
    path: string;
    method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    query?: Record<string, string | number | boolean | undefined>;
    json?: unknown;
    form?: FormData;
    /** Ответ — бинарный файл, а не JSON. */
    raw?: boolean;
}

function baseUrl(category: WbCategory): string {
    const host = HOSTS[category];
    if (!config.wb.sandbox) return host.prod;
    if (host.sandbox === null) {
        throw new WbApiError(
            `У категории «${category}» нет песочницы WB. Отключите WB_SANDBOX, чтобы работать с ней.`,
            501,
            category,
            ''
        );
    }
    return host.sandbox;
}

const MAX_ATTEMPTS = 4;

async function request<T>(opts: RequestOptions): Promise<T> {
    const url = new URL(opts.path, baseUrl(opts.category));
    for (const [k, v] of Object.entries(opts.query ?? {})) {
        if (v !== undefined) url.searchParams.set(k, String(v));
    }

    const bucket = opts.cabinet.buckets[opts.category];
    let lastError: WbApiError | undefined;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        await bucket.take(1);

        const headers: Record<string, string> = { Authorization: tokenFor(opts.cabinet, opts.category) };
        let body: string | FormData | undefined;
        if (opts.json !== undefined) {
            headers['Content-Type'] = 'application/json';
            body = JSON.stringify(opts.json);
        } else if (opts.form) {
            body = opts.form; // fetch сам проставит multipart boundary
        }

        const started = Date.now();
        let res: Response;
        try {
            res = await fetch(url, {
                method: opts.method ?? 'GET',
                headers,
                body,
                signal: AbortSignal.timeout(60_000)
            });
        } catch (cause) {
            lastError = new WbApiError(
                `Сеть недоступна при обращении к WB: ${(cause as Error).message}`,
                0,
                opts.category,
                opts.path
            );
            if (attempt < MAX_ATTEMPTS) {
                await sleep(500 * attempt);
                continue;
            }
            throw lastError;
        }

        logger.debug(
            {
                wb: true,
                cabinet: opts.cabinet.slug,
                category: opts.category,
                path: opts.path,
                status: res.status,
                ms: Date.now() - started
            },
            'wb request'
        );

        if (res.status === 429) {
            const retry = Number(res.headers.get('X-Ratelimit-Retry') ?? '1');
            bucket.penalise(3);
            lastError = new WbApiError('Слишком много запросов', 429, opts.category, opts.path, undefined, retry);
            if (attempt < MAX_ATTEMPTS) {
                await sleep(Math.min(retry, 30) * 1000);
                continue;
            }
            throw lastError;
        }

        if (res.status >= 500 && attempt < MAX_ATTEMPTS) {
            await sleep(700 * attempt);
            lastError = new WbApiError(`Сервис WB недоступен (${res.status})`, res.status, opts.category, opts.path);
            continue;
        }

        if (!res.ok) {
            const text = await res.text().catch(() => '');
            let parsed: unknown = text;
            try {
                parsed = JSON.parse(text);
            } catch {
                /* тело не JSON — оставляем строкой */
            }
            const detail =
                typeof parsed === 'object' && parsed !== null
                    ? ((parsed as Record<string, unknown>).detail ??
                      (parsed as Record<string, unknown>).errorText ??
                      (parsed as Record<string, unknown>).title ??
                      text)
                    : text;
            throw new WbApiError(String(detail || res.statusText), res.status, opts.category, opts.path, parsed);
        }

        if (opts.raw) return (await res.arrayBuffer()) as T;
        if (res.status === 204) return undefined as T;

        const text = await res.text();
        if (!text) return undefined as T;
        return JSON.parse(text) as T;
    }

    throw lastError ?? new WbApiError('Неизвестная ошибка WB', 0, opts.category, opts.path);
}

/** Конверт методов категории «Вопросы и отзывы». */
interface FeedbackEnvelope<T> {
    data: T;
    error: boolean;
    errorText: string;
    additionalErrors: unknown;
}

/** Конверт методов категории «Чат с покупателями». */
interface ChatEnvelope<T> {
    result: T;
    errors: string[] | null;
}

export async function wbFeedbacks<T>(cabinet: Cabinet, opts: Omit<RequestOptions, 'category' | 'cabinet'>): Promise<T> {
    const res = await request<FeedbackEnvelope<T>>({ ...opts, cabinet, category: 'feedbacks' });
    if (res === undefined) return undefined as T;
    if (res.error) {
        throw new WbApiError(res.errorText || 'WB вернул error=true', 400, 'feedbacks', opts.path, res.additionalErrors);
    }
    return res.data;
}

export async function wbChat<T>(cabinet: Cabinet, opts: Omit<RequestOptions, 'category' | 'cabinet'>): Promise<T> {
    const res = await request<ChatEnvelope<T>>({ ...opts, cabinet, category: 'chat' });
    if (res === undefined) return undefined as T;
    if (res.errors && res.errors.length > 0) {
        throw new WbApiError(res.errors.join('; '), 400, 'chat', opts.path, res.errors);
    }
    return res.result;
}

/** Общие методы отдают тело без конверта. */
export async function wbCommon<T>(cabinet: Cabinet, path: string): Promise<T> {
    return request<T>({ cabinet, category: 'common', path });
}

/**
 * Области данных конверта не используют — тело приходит как есть.
 * Проверено на marketplace, content, statistics, returns, finance, supplies.
 */
export async function wbJson<T>(
    cabinet: Cabinet,
    category: WbCategory,
    opts: Omit<RequestOptions, 'category' | 'cabinet'>
): Promise<T> {
    return request<T>({ ...opts, cabinet, category });
}

/** Часть методов (цены, часть аналитики) заворачивает полезное в { data: ... }. */
export async function wbDataJson<T>(
    cabinet: Cabinet,
    category: WbCategory,
    opts: Omit<RequestOptions, 'category' | 'cabinet'>
): Promise<T> {
    const res = await request<{ data: T } | undefined>({ ...opts, cabinet, category });
    if (res === undefined) return undefined as T;
    return res.data;
}

export async function wbChatFile(cabinet: Cabinet, path: string): Promise<ArrayBuffer> {
    return request<ArrayBuffer>({ cabinet, category: 'chat', path, raw: true });
}

/** Проверка, что токен кабинета принят и нужные категории на месте. */
export async function wbPing(cabinet: Cabinet): Promise<{ feedbacks: boolean; chat: boolean; detail: string[] }> {
    const detail: string[] = [];
    let feedbacks = false;
    let chat = false;
    try {
        await wbFeedbacks<{ countUnanswered: number }>(cabinet, { path: '/api/v1/feedbacks/count-unanswered' });
        feedbacks = true;
    } catch (e) {
        detail.push(`Вопросы и отзывы: ${e instanceof WbApiError ? e.toUserMessage() : String(e)}`);
    }
    if (config.wb.sandbox) {
        detail.push('Чат с покупателями: недоступен в режиме песочницы (у WB нет sandbox-хоста для чата).');
    } else {
        try {
            await wbChat<unknown>(cabinet, { path: '/api/v1/seller/chats' });
            chat = true;
        } catch (e) {
            detail.push(`Чат с покупателями: ${e instanceof WbApiError ? e.toUserMessage() : String(e)}`);
        }
    }
    return { feedbacks, chat, detail };
}
