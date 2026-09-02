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
