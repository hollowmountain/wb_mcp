/**
 * Клиент 1С:УНФ через стандартный интерфейс OData.
 *
 * Здесь есть только чтение. Функций записи в этом модуле не существует —
 * не «мы их не вызываем», а физически нечем: ни POST, ни PATCH, ни DELETE
 * не реализованы. Это вторая линия обороны.
 *
 * Первая линия — сама 1С: служебный пользователь claude_mcp работает под
 * профилем «Только просмотр», и платформа откажет в записи независимо от
 * нашего кода.
 *
 * Третья линия — белый список ниже. Публикация OData в базе оказалась
 * грубым инструментом: разрешение зависимостей одной «Номенклатуры»
 * транзитивно открыло 1460 сущностей, включая справочники сотрудников и
 * физических лиц. Профиль «Только просмотр» ограничивает запись, но не
 * состав данных, поэтому доступ сужаем здесь: всё, чего нет в списке,
 * для клиента не существует.
 */
import { TokenBucket } from '../wb/ratelimit.js';

/**
 * Сущности, к которым коннектору разрешено обращаться. Имена проверены
 * на живой базе 02.09.2026 — в УНФ склады называются «СтруктурныеЕдиницы»,
 * а регистр остатков «ЗапасыНаСкладах».
 *
 * Расширять этот список — сознательное решение, а не побочный эффект.
 * Ничего про сотрудников, физических лиц, зарплату и НДФЛ здесь быть не должно.
 */
export const ALLOWED_ENTITIES = [
    'Catalog_Номенклатура',
    'Catalog_ЕдиницыИзмерения',
    'Catalog_Организации',
    'Catalog_Контрагенты',
    'Catalog_СтруктурныеЕдиницы',
    'Document_ЗаказПокупателя',
    'Document_РасходнаяНакладная',
    'Document_ПриходнаяНакладная',
    'AccumulationRegister_ЗапасыНаСкладах',
    'AccumulationRegister_Продажи'
] as const;

export type OnecEntity = (typeof ALLOWED_ENTITIES)[number];

const allowed = new Set<string>(ALLOWED_ENTITIES);

/** База в облаке, лимитов не публикует. Ходим сдержанно. */
const bucket = new TokenBucket(4, 1);

export class OnecError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly entity: string
    ) {
        super(message);
        this.name = 'OnecError';
    }

    toUserMessage(): string {
        switch (this.status) {
            case 401:
                return '1С не приняла учётные данные (401). Возможно, пароль служебного пользователя сменили.';
            case 403:
                return `1С запретила доступ к «${this.entity}» (403). У служебного пользователя нет прав на этот раздел.`;
            case 404:
                return `1С не нашла «${this.entity}» (404). Объект не опубликован в настройках OData или называется иначе.`;
            default:
                return `1С вернула ошибку ${this.status} по «${this.entity}»: ${this.message}`;
        }
    }
}

export interface OnecConfig {
    baseUrl: string;
    user: string;
    password: string;
}

/**
 * Единственный способ обратиться к 1С из этого кода. Метод жёстко GET,
 * сущность обязана быть в белом списке.
 */
async function fetchEntity<T>(
    cfg: OnecConfig,
    entity: string,
    query: Record<string, string | number | undefined>
): Promise<T> {
    if (!allowed.has(entity)) {
        // Не «нет данных», а именно отказ: так видно, что сработал запрет,
        // а не опечатка в имени.
        throw new OnecError(
            `Обращение к «${entity}» не разрешено. Коннектору открыты только: ${ALLOWED_ENTITIES.join(', ')}`,
            403,
            entity
        );
    }

    await bucket.take(1);

    const url = new URL(`${cfg.baseUrl}/odata/standard.odata/${encodeURIComponent(entity)}`);
    url.searchParams.set('$format', 'json');
    for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    }

    const auth = Buffer.from(`${cfg.user}:${cfg.password}`).toString('base64');
    const res = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(120_000)
    });

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        let detail = text;
        try {
            const parsed = JSON.parse(text) as { 'odata.error'?: { message?: { value?: string } } };
            detail = parsed['odata.error']?.message?.value ?? text;
        } catch {
            /* тело не JSON — оставляем как есть */
        }
        throw new OnecError(detail.slice(0, 300) || res.statusText, res.status, entity);
    }

    return (await res.json()) as T;
}

/** Список записей сущности. */
export async function listEntity<T>(
    cfg: OnecConfig,
    entity: OnecEntity,
    opts: { top?: number; filter?: string; select?: string; orderby?: string } = {}
): Promise<T[]> {
    const res = await fetchEntity<{ value: T[] }>(cfg, entity, {
        $top: Math.min(opts.top ?? 50, 1000),
        $filter: opts.filter,
        $select: opts.select,
        $orderby: opts.orderby
    });
    return res?.value ?? [];
}

/** Сколько всего записей. Дешевле, чем тянуть список. */
export async function countEntity(cfg: OnecConfig, entity: OnecEntity): Promise<number> {
    const res = await fetchEntity<{ value: unknown[] }>(cfg, entity, { $top: 0, $inlinecount: 'allpages' });
    const raw = res as unknown as Record<string, unknown>;
    const n = Number(raw['odata.count'] ?? raw['@odata.count'] ?? NaN);
    return Number.isFinite(n) ? n : (res?.value?.length ?? 0);
}

/** Что вообще открыто коннектору — для показа человеку. */
export const describeAllowed = (): string => ALLOWED_ENTITIES.join(', ');
