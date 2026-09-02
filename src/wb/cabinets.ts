import { TokenBucket } from './ratelimit.js';
import { describeProblems, parseToken, type CategoryKey, type TokenInfo } from './token.js';

/**
 * Кабинет продавца Wildberries. У каждого свои токены и свои счётчики лимитов:
 * лимиты WB считаются на аккаунт продавца, поэтому общие вёдра на все кабинеты
 * искусственно тормозили бы работу.
 *
 * Токенов два, и это вынужденно. Признак «только чтение» в токене WB — один бит
 * на весь токен (бит 30), а не настройка по категориям. Значит «отвечать
 * покупателям, но остальное только смотреть» одним токеном не выражается.
 * Отсюда пара:
 *   token     — узкий, с записью: только отзывы и чат;
 *   dataToken — широкий, только на чтение: заказы, карточки, цены, статистика.
 * Если широкий токен утечёт, изменить им ничего нельзя, а тот, что умеет писать,
 * дотягивается только до ответов покупателям.
 */
export interface Cabinet {
    /** Короткий идентификатор для параметров инструментов: main, opt, detsky. */
    slug: string;
    /** Человеческое название, которое видит пользователь. */
    label: string;
    /** Токен для ответов: отзывы и чат, с правом записи. */
    token: string;
    info: TokenInfo;
    /** Проблемы токена ответов, найденные при разборе. Пустой массив — всё хорошо. */
    problems: string[];
    /** Токен для чтения данных. null — кабинет настроен по-старому, данные недоступны. */
    dataToken: string | null;
    dataInfo: TokenInfo | null;
    dataProblems: string[];
    buckets: Record<BucketKey, TokenBucket>;
}

/** Области WB, у каждой свой хост и свои лимиты. */
export type BucketKey =
    | 'feedbacks'
    | 'chat'
    | 'returns'
    | 'common'
    | 'marketplace'
    | 'content'
    | 'prices'
    | 'statistics'
    | 'analytics'
    | 'supplies'
    | 'finance';

/**
 * Параметры вёдер: (ёмкость всплеска, пополнение в секунду).
 *
 * Для отзывов и чата взяты из документации лимитов персонального токена:
 * https://dev.wildberries.ru/openapi/api-information
 *
 * Для остальных областей WB публикует лимиты неполно, поэтому значения
 * намеренно занижены — лучше медленнее, чем ловить 429 и штрафовать ведро.
 * Статистика проверена опытом 02.09.2026: два запроса подряд к
 * statistics-api дали 429, поэтому у неё ведро на один запрос в минуту.
 */
const BUCKET_LIMITS: Record<BucketKey, [capacity: number, perSecond: number]> = {
    feedbacks: [6, 3],
    chat: [10, 1],
    returns: [10, 20 / 60],
    common: [10, 1],
    marketplace: [10, 3],
    content: [10, 1.5],
    prices: [5, 1],
    // Самая жёсткая область: один запрос в минуту, всплеска нет.
    statistics: [1, 1 / 60],
    analytics: [2, 1 / 20],
    supplies: [5, 1],
    finance: [5, 1]
};

function makeBuckets(): Record<BucketKey, TokenBucket> {
    const buckets = {} as Record<BucketKey, TokenBucket>;
    for (const [key, [capacity, perSecond]] of Object.entries(BUCKET_LIMITS)) {
        buckets[key as BucketKey] = new TokenBucket(capacity, perSecond);
    }
    return buckets;
}

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,23}$/;

/** Категории, которые должны быть у широкого токена, чтобы от него был толк. */
const DATA_CATEGORIES: CategoryKey[] = ['content', 'marketplace', 'prices', 'statistics'];

export function buildCabinet(slug: string, label: string, token: string, dataToken?: string): Cabinet {
    if (!SLUG_RE.test(slug)) {
        throw new Error(
            `Некорректный идентификатор кабинета «${slug}»: разрешены строчные латинские буквы, цифры, дефис и подчёркивание, до 24 символов`
        );
    }
    const info = parseToken(token);
    const problems = describeProblems(info, ['feedbacks', 'chat']);

    let dataInfo: TokenInfo | null = null;
    const dataProblems: string[] = [];
    const trimmed = dataToken?.trim();
    if (trimmed) {
        dataInfo = parseToken(trimmed);
        for (const key of DATA_CATEGORIES) {
            if (!dataInfo.categories.has(key)) dataProblems.push(`нет доступа к категории «${key}»`);
        }
        if (!dataInfo.readOnly) {
            // Не отказ: работать будет. Но широкий токен с записью — лишний риск,
            // ради снижения которого вся эта пара токенов и заведена.
            dataProblems.push('токен данных умеет записывать — безопаснее выпустить его «только на чтение»');
        }
        if (dataInfo.sellerId && info.sellerId && dataInfo.sellerId !== info.sellerId) {
            dataProblems.push('токен данных выписан другим продавцом — проверьте, из того ли кабинета он взят');
        }
        if (dataInfo.expiresAt && dataInfo.expiresAt.getTime() < Date.now()) {
            dataProblems.push(`срок действия истёк ${dataInfo.expiresAt.toISOString().slice(0, 10)}`);
        }
    }

    return {
        slug,
        label: label || slug,
        token,
        info,
        problems,
        dataToken: trimmed || null,
        dataInfo,
        dataProblems,
        buckets: makeBuckets()
    };
}

export class CabinetRegistry {
    private readonly bySlug = new Map<string, Cabinet>();
    /** Замечания, которые index.ts выводит в лог при старте. */
    readonly warnings: string[] = [];

    constructor(cabinets: Cabinet[]) {
        if (cabinets.length === 0) {
            throw new Error('Не настроен ни один кабинет Wildberries');
        }
        for (const cabinet of cabinets) {
            if (this.bySlug.has(cabinet.slug)) {
                throw new Error(`Кабинет «${cabinet.slug}» указан дважды`);
            }
            this.bySlug.set(cabinet.slug, cabinet);
        }

        // Разные кабинеты должны принадлежать разным продавцам: если sid совпал,
        // скорее всего один и тот же токен вставили дважды. Логгер здесь звать
        // нельзя — он сам зависит от конфига, получилась бы циклическая загрузка.
        const seen = new Map<string, string>();
        for (const cabinet of cabinets) {
            const sid = cabinet.info.sellerId;
            if (!sid) continue;
            const previous = seen.get(sid);
            if (previous) {
                this.warnings.push(
                    `У кабинетов «${previous}» и «${cabinet.slug}» совпадает ID продавца — похоже, задан один и тот же токен.`
                );
            }
            seen.set(sid, cabinet.slug);
        }

        for (const cabinet of cabinets) {
            for (const problem of cabinet.problems) {
                this.warnings.push(`Кабинет «${cabinet.slug}»: ${problem}`);
            }
            if (!cabinet.dataToken) {
                this.warnings.push(
                    `Кабинет «${cabinet.slug}»: не задан WB_DATA_TOKEN — заказы, карточки и остатки недоступны.`
                );
            }
            for (const problem of cabinet.dataProblems) {
                this.warnings.push(`Кабинет «${cabinet.slug}», токен данных: ${problem}`);
            }
        }
    }

    all(): Cabinet[] {
        return [...this.bySlug.values()];
    }

    slugs(): string[] {
        return [...this.bySlug.keys()];
    }

    get size(): number {
        return this.bySlug.size;
    }

    has(slug: string): boolean {
        return this.bySlug.has(slug);
    }

    /**
     * Находит кабинет по slug. Если он не указан и кабинет всего один — берёт его.
     * При нескольких кабинетах молча угадывать нельзя: ответ уйдёт не тем покупателям.
     */
    resolve(slug?: string): Cabinet {
        if (slug === undefined || slug === '') {
            if (this.bySlug.size === 1) return this.all()[0]!;
            throw new CabinetError(
                `Настроено несколько кабинетов — укажите параметр cabinet. Доступны: ${this.describeChoices()}`
            );
        }
        const cabinet = this.bySlug.get(slug.trim().toLowerCase());
        if (!cabinet) {
            throw new CabinetError(`Кабинет «${slug}» не найден. Доступны: ${this.describeChoices()}`);
        }
        return cabinet;
    }

    /** Кабинеты для операции, которая может идти по всем сразу. */
    resolveMany(slug?: string): Cabinet[] {
        if (slug === undefined || slug === '') return this.all();
        return [this.resolve(slug)];
    }

    describeChoices(): string {
        return this.all()
            .map(c => `${c.slug} (${c.label})`)
            .join(', ');
    }
}

export class CabinetError extends Error {}
