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
    // Справочники
    'Catalog_Номенклатура',
    'Catalog_ЕдиницыИзмерения',
    'Catalog_Организации',
    'Catalog_Контрагенты',
    'Catalog_СтруктурныеЕдиницы',
    'Catalog_ХарактеристикиНоменклатуры',
    // Документы продаж и закупок
    'Document_ЗаказПокупателя',
    'Document_РасходнаяНакладная',
    'Document_ПриходнаяНакладная',
    'Document_ЗаказПоставщику',
    // Производство и склад
    'Document_ЗаказНаПроизводство',
    'Document_ПеремещениеЗапасов',
    'Document_СписаниеЗапасов',
    'Document_ОприходованиеЗапасов',
    'Document_ИнвентаризацияЗапасов',
    // Регистры
    'AccumulationRegister_ЗапасыНаСкладах',
    // Виртуальная таблица остатков: сами движения бесполезны без свёртки,
    // а Balance отдаёт готовый остаток на текущий момент.
    'AccumulationRegister_ЗапасыНаСкладах/Balance',
    'AccumulationRegister_Продажи',
    'AccumulationRegister_Продажи/Turnovers'
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

    // Имя может состоять из двух частей — «регистр/Balance». Косую черту
    // разделителем сохраняем, каждую часть кодируем отдельно: иначе
    // encodeURIComponent превратит её в %2F и 1С ответит «сущность не найдена».
    const path = entity.split('/').map(encodeURIComponent).join('/');

    // Строку запроса собираем руками. URLSearchParams кодирует пробел как «+»
    // по правилам форм, а разборщик 1С понимает только %20 и берёт плюс
    // буквально — фильтр «Date ge datetime'…' and DeletionMark eq false»
    // превращался в бессмыслицу, и база отвечала «Операция не разрешена
    // в предложении ГДЕ». Ломались все фильтры с пробелами, то есть все,
    // кроме поиска по подстроке.
    const parts = ['$format=json'];
    for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== '') parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    }
    const url = `${cfg.baseUrl}/odata/standard.odata/${path}?${parts.join('&')}`;

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
    opts: { top?: number; filter?: string; select?: string; orderby?: string; expand?: string } = {}
): Promise<T[]> {
    const res = await fetchEntity<{ value: T[] }>(cfg, entity, {
        $top: Math.min(opts.top ?? 50, 1000),
        $filter: opts.filter,
        $select: opts.select,
        $orderby: opts.orderby,
        $expand: opts.expand
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


// ─── Разворачивание ссылок ───────────────────────────────────────────────────

const EMPTY_GUID = '00000000-0000-0000-0000-000000000000';

/**
 * Регистры хранят ссылки на справочники, а не названия: в строке остатка
 * лежит Номенклатура_Key вида 542544e4-… . Показывать человеку такое нельзя,
 * поэтому собираем уникальные ссылки и спрашиваем названия одним запросом
 * на справочник. $expand тоже работает, но тянет карточку целиком — на сотне
 * строк это мегабайты ради одного поля.
 */
const nameCache = new Map<string, { at: number; names: Map<string, string> }>();
const NAME_TTL = 10 * 60 * 1000;

/**
 * Сколько ссылок влезает в один фильтр. Веб-сервер перед 1С (IIS) режет
 * строку запроса примерно на двух тысячах знаков и отвечает 404.15 —
 * страницей об ошибке, а не JSON. Проверено: 25 ссылок проходят (1696 знаков),
 * 30 уже нет. Берём 20 с запасом.
 */
const REFS_PER_QUERY = 20;

export async function resolveNames(
    cfg: OnecConfig,
    entity: OnecEntity,
    keys: Iterable<string>
): Promise<Map<string, string>> {
    const unique = [...new Set([...keys].filter(k => k && k !== EMPTY_GUID))];
    const names = new Map<string, string>();
    if (unique.length === 0) return names;

    // Справочники меняются редко, а один и тот же товар встречается в остатках
    // на десятке складов. Без памяти каждый вызов заново гонял бы сотни ссылок.
    const cached = nameCache.get(entity);
    const fresh = cached && Date.now() - cached.at < NAME_TTL ? cached.names : new Map<string, string>();
    const missing: string[] = [];
    for (const k of unique) {
        const known = fresh.get(k);
        if (known === undefined) missing.push(k);
        else names.set(k, known);
    }

    for (let i = 0; i < missing.length; i += REFS_PER_QUERY) {
        const chunk = missing.slice(i, i + REFS_PER_QUERY);
        const filter = chunk.map(k => `Ref_Key eq guid'${k}'`).join(' or ');
        const rows = await listEntity<{ Ref_Key: string; Description?: string }>(cfg, entity, {
            top: chunk.length,
            filter,
            select: 'Ref_Key,Description'
        });
        for (const r of rows) {
            const name = r.Description ?? '';
            names.set(r.Ref_Key, name);
            fresh.set(r.Ref_Key, name);
        }
    }
    nameCache.set(entity, { at: cached && Date.now() - cached.at < NAME_TTL ? cached.at : Date.now(), names: fresh });
    return names;
}

export interface OnecStockRow {
    productKey: string;
    product: string;
    warehouseKey: string;
    warehouse: string;
    quantity: number;
}

/** Остатки на складах на текущий момент, только ненулевые. */
export async function getOnecStock(
    cfg: OnecConfig,
    opts: { top?: number } = {}
): Promise<OnecStockRow[]> {
    // Фильтровать по мере регистра нельзя: 1С отвечает «Операция не разрешена
    // в предложении ГДЕ». Поэтому забираем всё и отсеиваем нули у себя.
    const raw = (
        await listEntity<{
            Номенклатура_Key: string;
            СтруктурнаяЕдиница_Key: string;
            КоличествоBalance: number;
        }>(cfg, 'AccumulationRegister_ЗапасыНаСкладах/Balance', { top: opts.top ?? 1000 })
    ).filter(r => (r.КоличествоBalance ?? 0) > 0);

    const [products, warehouses] = await Promise.all([
        resolveNames(cfg, 'Catalog_Номенклатура', raw.map(r => r.Номенклатура_Key)),
        resolveNames(cfg, 'Catalog_СтруктурныеЕдиницы', raw.map(r => r.СтруктурнаяЕдиница_Key))
    ]);

    return raw.map(r => ({
        productKey: r.Номенклатура_Key,
        product: products.get(r.Номенклатура_Key) ?? '(без названия)',
        warehouseKey: r.СтруктурнаяЕдиница_Key,
        warehouse: warehouses.get(r.СтруктурнаяЕдиница_Key) ?? '(склад не указан)',
        quantity: r.КоличествоBalance
    }));
}
