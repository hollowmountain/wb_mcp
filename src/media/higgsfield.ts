/**
 * Клиент Higgsfield Cloud API — генерация картинок и видео.
 *
 * Устроен иначе, чем остальные наши источники: не «спросил — получил», а
 * очередь. Запрос принимается сразу, работа идёт минутами, результат
 * забирается отдельно. Поэтому здесь нет функции «сгенерируй и верни» —
 * есть «поставь в очередь» и «посмотри, что вышло».
 *
 * Оплата покредитная, около 6,25 цента за кредит. Картинка через soul/v2
 * стоит треть цента, ролик на шесть секунд — от девятнадцати центов. Разница
 * в шестьдесят раз, поэтому цену узнаём до запуска, а не после.
 */

const BASE = 'https://api.higgsfield.ai';

export interface HiggsfieldConfig {
    keyId: string;
    keySecret: string;
}

export class HiggsfieldError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly code: string
    ) {
        super(message);
        this.name = 'HiggsfieldError';
    }

    toUserMessage(): string {
        switch (this.code) {
            case 'not_enough_credits':
                return 'На счету Higgsfield кончились кредиты. Пополнить может только владелец, в кабинете cloud.higgsfield.ai.';
            case 'model_not_found':
            case 'model_disabled':
            case 'model_blocked':
                return `Модель «${this.message}» вашему аккаунту недоступна.`;
            default:
                if (this.status === 401) return 'Higgsfield не принял ключ. Возможно, его перевыпустили.';
                // Предел одновременных запросов приходит обычным 400 с текстом.
                if (/concurrent/i.test(this.message)) {
                    return 'Higgsfield уже занят другими генерациями. Подождите, пока освободится очередь.';
                }
                return `Higgsfield вернул ошибку ${this.status}: ${this.message}`;
        }
    }
}

async function call<T>(cfg: HiggsfieldConfig, url: string, body?: unknown): Promise<T> {
    const res = await fetch(url, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
            Authorization: `Key ${cfg.keyId}:${cfg.keySecret}`,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(60_000)
    });

    const text = await res.text();
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        parsed = null;
    }

    if (!res.ok) {
        const detail =
            typeof (parsed as { detail?: unknown } | null)?.detail === 'string'
                ? ((parsed as { detail: string }).detail)
                : text.slice(0, 200) || res.statusText;
        throw new HiggsfieldError(detail, res.status, detail);
    }
    return parsed as T;
}

export interface Estimate {
    credits: number;
    usd: number;
}

/**
 * Сколько будет стоить. Считать обязательно до запуска: у API нет ни
 * остатка на счёте, ни стоимости в ответе о готовности — если не спросить
 * заранее, узнать цену уже неоткуда.
 */
export async function estimate(cfg: HiggsfieldConfig, model: string, params: unknown): Promise<Estimate> {
    const r = await call<{ credits: string; usd: string }>(cfg, `${BASE}/estimate/${model}`, params);
    return { credits: Number(r.credits), usd: Number(r.usd) };
}

export interface Submitted {
    requestId: string;
    /** Адрес опроса берём из ответа: он ведёт на platform.higgsfield.ai, а не на api. */
    statusUrl: string;
    cancelUrl: string;
}

export async function submit(cfg: HiggsfieldConfig, model: string, params: unknown): Promise<Submitted> {
    const r = await call<{ request_id: string; status_url: string; cancel_url: string }>(
        cfg,
        `${BASE}/${model}`,
        params
    );
    return { requestId: r.request_id, statusUrl: r.status_url, cancelUrl: r.cancel_url };
}

export type JobStatus = 'queued' | 'in_progress' | 'completed' | 'failed' | 'nsfw' | 'canceled';

export interface JobResult {
    status: JobStatus;
    /** Ссылки на готовые файлы. Живут не меньше семи дней, потом удаляются. */
    urls: string[];
    error: string | null;
}

const TERMINAL: readonly string[] = ['completed', 'failed', 'nsfw', 'canceled'];

export const isTerminal = (s: string): boolean => TERMINAL.includes(s);

/** Из ответа тянем всё, что похоже на готовый файл: поля зависят от модели. */
function mediaUrls(raw: Record<string, unknown>): string[] {
    const out: string[] = [];
    const eat = (v: unknown): void => {
        if (typeof v === 'string' && /^https?:\/\//.test(v)) out.push(v);
        else if (Array.isArray(v)) v.forEach(eat);
        else if (v && typeof v === 'object') {
            for (const [k, inner] of Object.entries(v as Record<string, unknown>)) {
                // status_url и cancel_url — служебные, это не результат.
                if (k.endsWith('_url') && !k.startsWith('status') && !k.startsWith('cancel')) eat(inner);
                else if (['url', 'image', 'images', 'video', 'audio', 'audios'].includes(k)) eat(inner);
            }
        }
    };
    for (const key of ['images', 'image', 'video', 'audio', 'audios']) eat(raw[key]);
    return [...new Set(out)];
}

export async function check(cfg: HiggsfieldConfig, statusUrl: string): Promise<JobResult> {
    const raw = await call<Record<string, unknown>>(cfg, statusUrl);
    const status = String(raw.status ?? 'queued') as JobStatus;
    return {
        status,
        urls: mediaUrls(raw),
        error: typeof raw.error === 'string' ? raw.error : null
    };
}

export const cancel = (cfg: HiggsfieldConfig, cancelUrl: string): Promise<unknown> =>
    call<unknown>(cfg, cancelUrl, {});

/**
 * Модели, которые проверены на живом аккаунте 10.09.2026 и открыты нам.
 * Список намеренно короткий: в спецификации сорок восемь адресов, но
 * половина отвечает model_not_found или model_blocked, а перебирать их
 * вслепую значит отдавать человеку ошибки вместо картинок.
 *
 * Цены — из метода оценки, в кредитах. Кредит стоит около 6,25 цента.
 */
export interface ModelInfo {
    path: string;
    kind: 'image' | 'video';
    label: string;
    /** Ориентировочно, для подсказки в описании инструмента. */
    credits: number;
    /** Нужна ли исходная картинка. */
    needsImage: boolean;
}

export type ModelKey = 'photo' | 'video_fast' | 'video';

export const MODELS: Record<ModelKey, ModelInfo> = {
    photo: {
        path: 'higgsfield-ai/soul/v2/standard',
        kind: 'image',
        label: 'Картинка по описанию',
        credits: 0.05,
        needsImage: false
    },
    video_fast: {
        path: 'minimax/hailuo-2.3-fast/standard/image-to-video',
        kind: 'video',
        label: 'Ролик из картинки, подешевле',
        credits: 3.04,
        needsImage: true
    },
    video: {
        path: 'kling-video/v2.5-turbo/standard/image-to-video',
        kind: 'video',
        label: 'Ролик из картинки, поплавнее',
        credits: 3.36,
        needsImage: true
    }
};
