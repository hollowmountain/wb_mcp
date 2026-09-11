/**
 * Откуда берётся исходное фото товара.
 *
 * Два пути. Обычный — назвать nmID: коннектор сам спросит карточку в
 * Wildberries и возьмёт оттуда ссылку на снимок. Запасной — дать прямую
 * ссылку, если нужного кадра в карточке нет.
 *
 * Ссылку нельзя принимать какую попало. Сервер ходит по ней сам, изнутри
 * сети, поэтому «https://127.0.0.1/...» или адрес соседней служебной машины
 * превратили бы инструмент рисования картинок в способ читать чужое.
 * Отсюда белый список хостов и запрет частных адресов.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { getCardByNmId } from '../wb/api.js';
import type { Cabinet } from '../wb/cabinets.js';

/** Максимум, который принимает OpenAI на вход. */
const MAX_BYTES = 50 * 1024 * 1024;

/** Хосты, с которых можно брать картинки: витрины площадок и ничего больше. */
const ALLOWED_HOSTS = [/\.wbbasket\.ru$/i, /\.wb\.ru$/i, /\.wildberries\.ru$/i, /\.ozone\.ru$/i, /\.ozonusercontent\.com$/i];

const MIME_BY_EXT: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp'
};

export class ReferenceError_ extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ReferenceError_';
    }
}

/** Частные и служебные диапазоны: сюда сервер ходить не должен. */
function isPrivateAddress(ip: string): boolean {
    if (isIP(ip) === 6) {
        const v6 = ip.toLowerCase();
        return v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80') || v6.startsWith('::ffff:');
    }
    const parts = ip.split('.').map(Number);
    const a = parts[0] ?? -1;
    const b = parts[1] ?? -1;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
}

async function assertPublicHost(url: URL): Promise<void> {
    if (url.protocol !== 'https:') throw new ReferenceError_('Ссылка должна начинаться с https://');

    const host = url.hostname;
    if (!ALLOWED_HOSTS.some(re => re.test(host))) {
        throw new ReferenceError_(
            `Хост «${host}» не в списке разрешённых. Брать фото можно только с витрин Wildberries и Ozon — ` +
                'или укажите nmID, и коннектор найдёт снимок сам.'
        );
    }

    const resolved = await lookup(host, { all: true }).catch(() => []);
    if (resolved.length === 0) throw new ReferenceError_(`Не удалось определить адрес хоста «${host}».`);
    if (resolved.some(r => isPrivateAddress(r.address))) {
        throw new ReferenceError_(`Хост «${host}» ведёт во внутреннюю сеть. Такие ссылки не принимаются.`);
    }
}

export interface Reference {
    bytes: Buffer;
    mime: string;
    filename: string;
    /** Откуда взяли — показываем человеку, чтобы он видел, что согласовывает. */
    source: string;
}

async function download(url: string): Promise<Reference> {
    const parsed = new URL(url);
    await assertPublicHost(parsed);

    const response = await fetch(parsed, {
        // Витрины отдают картинки только «браузерам».
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; mcp-wb/1.0)' },
        redirect: 'error',
        signal: AbortSignal.timeout(30_000)
    });

    if (!response.ok) throw new ReferenceError_(`Фото не скачалось: ${response.status} ${response.statusText}`);

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) throw new ReferenceError_('По ссылке пусто.');
    if (bytes.length > MAX_BYTES) throw new ReferenceError_('Фото тяжелее 50 МБ — столько на вход не принимается.');

    const ext = parsed.pathname.split('.').pop()?.toLowerCase() ?? '';
    const mime = response.headers.get('content-type')?.split(';')[0]?.trim() || MIME_BY_EXT[ext] || 'image/jpeg';
    if (!mime.startsWith('image/')) throw new ReferenceError_(`По ссылке не картинка, а ${mime}.`);

    return { bytes, mime, filename: `reference.${ext || 'jpg'}`, source: url };
}

export interface ReferenceRequest {
    nmId?: number;
    /** Номер снимка в карточке, считая с единицы. */
    photo?: number;
    imageUrl?: string;
}

/**
 * Достаёт фото товара. При nmID берём ссылки из карточки Wildberries: там
 * лежат те же снимки, что видит покупатель, и гадать с адресами не нужно.
 */
export async function resolveReference(cabinet: Cabinet | null, request: ReferenceRequest): Promise<Reference> {
    if (request.imageUrl) return download(request.imageUrl);

    if (!request.nmId) throw new ReferenceError_('Нужен либо nmID товара, либо прямая ссылка на фото.');
    if (!cabinet) throw new ReferenceError_('Чтобы найти фото по nmID, укажите кабинет Wildberries.');

    const card = await getCardByNmId(cabinet, request.nmId);
    if (!card) throw new ReferenceError_(`Товар nmID ${request.nmId} в этом кабинете не найден.`);

    const photos = (card.photos ?? []).map(p => p.big).filter(Boolean);
    if (photos.length === 0) throw new ReferenceError_(`У товара nmID ${request.nmId} в карточке нет фотографий.`);

    const index = Math.max(1, request.photo ?? 1);
    if (index > photos.length) {
        throw new ReferenceError_(`У товара всего ${photos.length} фото, а запрошено ${index}-е.`);
    }

    const chosen = photos[index - 1];
    if (!chosen) throw new ReferenceError_(`У товара нет ${index}-го фото.`);

    const reference = await download(chosen);
    return { ...reference, source: `nmID ${request.nmId}, фото ${index} из ${photos.length}` };
}

/** Сколько фотографий в карточке — чтобы человек выбрал нужное, не гадая. */
export async function listPhotos(cabinet: Cabinet, nmId: number): Promise<string[]> {
    const card = await getCardByNmId(cabinet, nmId);
    return (card?.photos ?? []).map(p => p.big).filter(Boolean);
}
