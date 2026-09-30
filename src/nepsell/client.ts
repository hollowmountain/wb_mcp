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
import { logger } from '../logger.js';
import { TokenBucket, sleep } from '../wb/ratelimit.js';

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
            case 422:
                return `Nepsell не принял параметры запроса (${this.status}): ${this.message}`;
            case 408:
                return 'Nepsell не ответил за 90 секунд — отчёт слишком тяжёлый или у них перегрузка. Возьмите период короче или повторите позже.';
            case 502:
            case 503:
            case 504:
                return `Nepsell сейчас не отвечает (${this.status}) — сбой на их стороне, запрос уже повторён трижды. Попробуйте через несколько минут.`;
            case 0:
                return `Не удалось связаться с Nepsell: ${this.message}`;
            default:
                return `Nepsell вернул ошибку ${this.status} на ${this.path}: ${this.message}`;
        }
    }
}

/**
 * Сбои на их стороне, после которых разумно попробовать ещё раз. 25 и 28
 * сентября 2026 утром их nginx десять раз отдал 502 подряд. Все запросы здесь —
 * чтение отчётов, повтор безопасен.
 */
const TRANSIENT = new Set([502, 503, 504]);
const RETRY_DELAYS_MS = [3_000, 8_000];

/**
 * Текст ошибки из тела ответа.
 *
 * Nepsell написан на FastAPI: ошибку проверки параметров он присылает
 * многострочной строкой «1 validation error:\n start_date\n Input should be…».
 * Раньше бралась только первая строка — ровно та, где причины нет, — и до
 * человека доходило бесполезное «1 validation error:». Теперь берётся целиком.
 */
function describeBody(text: string, status: number): string {
    const t = text.trim();
    // При падении их nginx отдаёт HTML-страницу. Модели она ничего не скажет.
    if (t.startsWith('<')) return `сервер Nepsell не ответил (${status})`;
    try {
        const d = (JSON.parse(t) as { detail?: unknown }).detail;
        if (typeof d === 'string') return d.replace(/\s+/g, ' ').trim();
        if (Array.isArray(d)) {
            return d
                .map(x => {
                    const o = x as { loc?: unknown[]; msg?: string };
                    const where = (o.loc ?? []).filter(p => p !== 'body').join('.');
                    return where ? `${where}: ${o.msg ?? ''}` : (o.msg ?? '');
                })
                .join('; ');
        }
    } catch {
        /* тело не JSON — оставляем как есть */
    }
    return t;
}

async function post<T>(token: string, path: string, body: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        await bucket.take(1);
        let res: Response;
        try {
            res = await fetch(BASE + path, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(body ?? {}),
                signal: AbortSignal.timeout(90_000)
            });
        } catch (cause) {
            const err = cause as Error;
            // Тайм-аут не повторяем: 90 секунд уже потрачены, второй заход съел
            // бы ещё столько же, и Claude сотрудника бросил бы ждать раньше.
            const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
            if (!timedOut && attempt < RETRY_DELAYS_MS.length) {
                await sleep(RETRY_DELAYS_MS[attempt]!);
                continue;
            }
            throw new NepsellError(timedOut ? 'не ответил за 90 секунд' : err.message, timedOut ? 408 : 0, path);
        }
        if (res.ok) return (await res.json()) as T;

        const text = await res.text().catch(() => '');
        if (TRANSIENT.has(res.status) && attempt < RETRY_DELAYS_MS.length) {
            logger.warn({ nepsell: true, path, status: res.status, attempt: attempt + 1 }, 'nepsell transient error, retrying');
            await sleep(RETRY_DELAYS_MS[attempt]!);
            continue;
        }
        throw new NepsellError(describeBody(text, res.status).slice(0, 500) || res.statusText, res.status, path);
    }
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
    /** Wildberries опознаёт товар так. */
    nm_id?: string;
    /** А Ozon — так, и это массив. Одно из двух полей всегда пустое. */
    skus?: string[];
    metric_name: string;
    metric_value: number;
}

/**
 * Чем Nepsell опознал товар. У Wildberries это nm_id, у Ozon — skus[0].
 * Без этой развилки все строки Ozon сливаются в одну кучу с ключом undefined,
 * итоги остаются верными, а разбивка по товарам пропадает.
 */
export const itemIdOf = (row: { nm_id?: string; skus?: string[] }): string =>
    row.nm_id ?? row.skus?.[0] ?? '';

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
    /** Wildberries. */
    nm_ids?: string[];
    /** Товары, которые кампания тянет за собой: основа для assoc_orders. Только Wildberries. */
    assoc_nm_ids?: string[];
    /** Ozon перечисляет товары кампании здесь и связанных не различает. */
    skus?: string[];
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
