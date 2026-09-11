/**
 * Клиент OpenAI Images — перерисовка фона вокруг готового товара.
 *
 * Почему именно edits, а не generations. Генерация с нуля рисует похожий
 * предмет, а не ваш: форма упаковки уезжает, а надписи на этикетке модель
 * сочиняет. Метод edits получает настоящее фото товара и меняет только то,
 * что вокруг, — упаковка и буквы на ней остаются те же.
 *
 * Проверено на живых товарах 10—11.09.2026: gpt-image-2.5 воспроизводит и
 * латиницу, и кириллицу на этикетке без ошибок. Предшественник (Higgsfield)
 * на тех же снимках буквы путал и стоил вдвое дороже.
 *
 * Оплата потокенная, поэтому точная цена известна только после ответа: она
 * приходит в поле usage. До запуска считаем оценку — см. estimateUsd.
 */

const ENDPOINT = 'https://api.openai.com/v1/images/edits';

/** Проверенная модель. Менять только вместе с проверкой на кириллице. */
export const MODEL = 'gpt-image-2.5-sunburst';

/** Цены за миллион токенов, доллары. */
const PRICE = { imageIn: 8, textIn: 5, out: 30 } as const;

/**
 * Сколько пикселей приходится на один выходной токен при quality=high.
 * Снято с восьми настоящих генераций: 1024×1536 стабильно давали 1372 токена.
 */
const PIXELS_PER_TOKEN = 1146;

/** Во сколько раз дешевле или дороже относительно high. Оценка, не факт. */
const QUALITY_FACTOR: Record<Quality, number> = { medium: 0.5, high: 1 };

export type Quality = 'medium' | 'high';

export interface OpenAiConfig {
    apiKey: string;
}

export interface Usage {
    imageTokens: number;
    textTokens: number;
    outputTokens: number;
}

export interface Generated {
    /** Готовая картинка. */
    bytes: Buffer;
    mime: string;
    usage: Usage;
    /** Сколько это стоило на самом деле. */
    usd: number;
}

export class OpenAiError extends Error {
    constructor(
        message: string,
        readonly status: number
    ) {
        super(message);
        this.name = 'OpenAiError';
    }

    toUserMessage(): string {
        if (this.status === 401) return 'OpenAI не принял ключ. Возможно, его перевыпустили.';
        if (this.status === 429) {
            return 'OpenAI сейчас не принимает запросы: либо кончились деньги на счёте, либо превышен предел частоты. Попробуйте через минуту.';
        }
        if (this.status === 400 && /moderation|safety|rejected/i.test(this.message)) {
            return 'Запрос отклонён проверкой содержимого. Деньги не списаны — переформулируйте сцену.';
        }
        if (this.status === 400) return `OpenAI не принял запрос: ${this.message}`;
        return `OpenAI вернул ошибку ${this.status}: ${this.message}`;
    }
}

export const costOf = (u: Usage): number =>
    (u.imageTokens * PRICE.imageIn + u.textTokens * PRICE.textIn + u.outputTokens * PRICE.out) / 1e6;

/**
 * Оценка до запуска. Точной быть не может: сколько токенов съест промт и
 * сколько вернёт модель, заранее не знает никто. Поэтому берём замеренную
 * плотность пикселей и округляем вверх — лучше назвать цену чуть больше
 * настоящей, чем удивить человека после списания.
 */
export function estimateUsd(width: number, height: number, quality: Quality, promptChars: number): number {
    const outputTokens = ((width * height) / PIXELS_PER_TOKEN) * QUALITY_FACTOR[quality];
    // Одна картинка на входе — примерно столько же токенов, сколько у нас
    // выходило на снимках товара. Символ русского текста ≈ 0,5 токена.
    const inputImage = 600;
    const inputText = promptChars / 2;
    const usd = (inputImage * PRICE.imageIn + inputText * PRICE.textIn + outputTokens * PRICE.out) / 1e6;
    return Math.ceil(usd * 1000) / 1000;
}

interface Part {
    name: string;
    value: string | { filename: string; mime: string; bytes: Buffer };
}

function multipart(parts: Part[]): { body: Buffer; contentType: string } {
    const boundary = `----mcpwb${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    const chunks: Buffer[] = [];

    for (const part of parts) {
        chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"`));
        if (typeof part.value === 'string') {
            chunks.push(Buffer.from(`\r\n\r\n${part.value}\r\n`));
        } else {
            chunks.push(
                Buffer.from(
                    `; filename="${part.value.filename}"\r\nContent-Type: ${part.value.mime}\r\n\r\n`
                ),
                part.value.bytes,
                Buffer.from('\r\n')
            );
        }
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));

    return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

export interface EditRequest {
    /** Фото товара, вокруг которого рисуется сцена. */
    reference: { bytes: Buffer; mime: string; filename: string };
    prompt: string;
    width: number;
    height: number;
    quality: Quality;
}

/**
 * Одна генерация. Синхронная: ответ приходит с готовой картинкой, очереди и
 * опроса статуса нет — этим метод удобнее прежнего поставщика.
 */
export async function edit(cfg: OpenAiConfig, request: EditRequest): Promise<Generated> {
    const { body, contentType } = multipart([
        { name: 'model', value: MODEL },
        { name: 'prompt', value: request.prompt },
        { name: 'size', value: `${request.width}x${request.height}` },
        { name: 'quality', value: request.quality },
        { name: 'n', value: '1' },
        // Площадки принимают JPG, а весит он вчетверо меньше PNG при
        // качестве, на котором буквы на этикетке ещё не сыплются.
        { name: 'output_format', value: 'jpeg' },
        { name: 'output_compression', value: '92' },
        { name: 'image', value: request.reference }
    ]);

    // Крупные размеры на максимальном качестве считаются долго, минуты не
    // хватает. Короткий таймаут здесь опаснее длинного: деньги за начатую
    // генерацию спишутся, а результат мы не заберём.
    const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': contentType },
        body: new Uint8Array(body),
        signal: AbortSignal.timeout(600_000)
    });

    const raw = await response.text();
    let parsed: unknown = null;
    try {
        parsed = JSON.parse(raw);
    } catch {
        /* ниже разберём по статусу */
    }

    if (!response.ok) {
        const message =
            typeof (parsed as { error?: { message?: unknown } } | null)?.error?.message === 'string'
                ? (parsed as { error: { message: string } }).error.message
                : raw.slice(0, 300) || response.statusText;
        throw new OpenAiError(message, response.status);
    }

    const payload = parsed as {
        data?: Array<{ b64_json?: string }>;
        usage?: {
            input_tokens_details?: { image_tokens?: number; text_tokens?: number };
            output_tokens?: number;
        };
    } | null;

    const b64 = payload?.data?.[0]?.b64_json;
    if (!b64) throw new OpenAiError('в ответе нет картинки', response.status);

    const usage: Usage = {
        imageTokens: payload?.usage?.input_tokens_details?.image_tokens ?? 0,
        textTokens: payload?.usage?.input_tokens_details?.text_tokens ?? 0,
        outputTokens: payload?.usage?.output_tokens ?? 0
    };

    return { bytes: Buffer.from(b64, 'base64'), mime: 'image/jpeg', usage, usd: costOf(usage) };
}
