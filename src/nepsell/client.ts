/**
 * Клиент Nepsell — сервиса аналитики маркетплейсов.
 *
 * Зачем он вообще нужен рядом с API самих площадок: Nepsell знает то, чего
 * маркетплейс не знает в принципе — себестоимость товара. Продавец заводит её
 * сам, поэтому ни в отчётах Wildberries, ни в Ozon её нет ни одним полем.
 * Из неё считается вся настоящая экономика: валовая прибыль, маржа, ROI.
 * Второе уникальное — реклама, сшитая с продажами: ДРР, выкуп, заказы по
 * связанным товарам. Площадки отдают расход и продажи по отдельности.
 *
 * Всё, что у площадок есть и живее (карточки, остатки, заказы, отзывы),
 * отсюда сознательно не берётся.
 *
 * Авторизация: Authorization: Bearer nps_a1_… Публичная ветка — /api/a1.
 * Ветка /api/v1 обслуживает их собственный интерфейс по сессии, это не
 * публичный договор, и трогать её нельзя: сломается при их обновлении.
 */
import { TokenBucket } from '../wb/ratelimit.js';

const BASE = 'https://nepsell.ru/api/a1';

/** Лимитов Nepsell не публикует. Держимся скромно: отчёты тяжёлые. */
const bucket = new TokenBucket(3, 0.5);

export class NepsellError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly path: string
    ) {
        super(message);
        this.name = 'NepsellError';
    }

    toUserMessage(): string {
        switch (this.status) {
            case 401:
                return 'Nepsell не принял ключ (401). Проверьте NEPSELL_TOKEN — возможно, он отозван в личном кабинете.';
            case 403:
                return 'Nepsell запретил доступ (403). Похоже, у тарифа нет прав на этот раздел.';
            case 400:
                return `Nepsell отклонил запрос (400): ${this.message}`;
            default:
                return `Nepsell вернул ошибку ${this.status} на ${this.path}: ${this.message}`;
        }
    }
}

async function post<T>(token: string, path: string, body: unknown): Promise<T> {
    await bucket.take(1);
    const res = await fetch(BASE + path, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(90_000)
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        let detail = text;
        try {
            const parsed = JSON.parse(text) as { detail?: unknown };
            if (typeof parsed.detail === 'string') detail = parsed.detail.split('\n')[0] ?? text;
        } catch {
            /* тело не JSON — оставляем как есть */
        }
        throw new NepsellError(detail.slice(0, 300) || res.statusText, res.status, path);
    }
    return (await res.json()) as T;
}

// ─── Кабинеты ────────────────────────────────────────────────────────────────

export interface NepsellClient {
    /** Вида w1134891 или o831430: буква — площадка, дальше её собственный id. */
    client_id: string;
    name: string;
    marketplace: 'Wildberries' | 'Ozon' | string;
}

export const listNepsellClients = (token: string): Promise<{ data: NepsellClient[] }> =>
    post<{ data: NepsellClient[] }>(token, '/clients', {});

// ─── Экономика ───────────────────────────────────────────────────────────────

/** Отчёты приходят «длинной» таблицей: строка — одна метрика одного товара. */
export interface MetricRow {
    period_start: string;
    period_end: string;
    nm_id: string;
    metric_name: string;
    metric_value: number;
}

export const getFinances = (
    token: string,
    clientId: string,
    startDate: string,
    endDate: string
): Promise<{ data: MetricRow[] }> =>
    post<{ data: MetricRow[] }>(token, '/finances', {
        client_id: clientId,
        start_date: startDate,
        end_date: endDate
    });

// ─── Реклама ─────────────────────────────────────────────────────────────────

export interface AdCampaign {
    campaign_id: string;
    campaign_name: string;
    campaign_type: string;
    strategy: string | null;
    nm_ids: string[];
    /** Товары, которые кампания тянет за собой: основа для assoc_orders. */
    assoc_nm_ids: string[];
}

export interface AdMetricRow {
    period_start: string;
    period_end: string;
    campaign_id: string;
    metric_name: string;
    metric_value: number;
}

export const listAdCampaigns = (
    token: string,
    clientId: string,
    startDate: string,
    endDate: string
): Promise<{ data: AdCampaign[] }> =>
    post<{ data: AdCampaign[] }>(token, '/ads-campaigns-list', {
        client_id: clientId,
        start_date: startDate,
        end_date: endDate
    });

export const getAdMetrics = (
    token: string,
    clientId: string,
    startDate: string,
    endDate: string
): Promise<{ data: AdMetricRow[] }> =>
    post<{ data: AdMetricRow[] }>(token, '/ads-campaigns', {
        client_id: clientId,
        start_date: startDate,
        end_date: endDate
    });
