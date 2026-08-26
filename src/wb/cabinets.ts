import { TokenBucket } from './ratelimit.js';
import { describeProblems, parseToken, type TokenInfo } from './token.js';

/**
 * Кабинет продавца Wildberries. У каждого свой токен и свои счётчики лимитов:
 * лимиты WB считаются на аккаунт продавца, поэтому общие вёдра на все кабинеты
 * искусственно тормозили бы работу.
 */
export interface Cabinet {
    /** Короткий идентификатор для параметров инструментов: main, opt, detsky. */
    slug: string;
    /** Человеческое название, которое видит пользователь. */
    label: string;
    token: string;
    info: TokenInfo;
    /** Проблемы токена, найденные при разборе. Пустой массив — всё хорошо. */
    problems: string[];
    buckets: {
        feedbacks: TokenBucket;
        chat: TokenBucket;
        returns: TokenBucket;
    };
}

function makeBuckets(): Cabinet['buckets'] {
    // feedbacks: 3 запроса в секунду, всплеск 6
    // chat: 10 запросов за 10 секунд, всплеск 10
    // returns: 20 запросов в минуту, всплеск 10
    return {
        feedbacks: new TokenBucket(6, 3),
        chat: new TokenBucket(10, 1),
        returns: new TokenBucket(10, 20 / 60)
    };
}

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,23}$/;

export function buildCabinet(slug: string, label: string, token: string): Cabinet {
    if (!SLUG_RE.test(slug)) {
        throw new Error(
            `Некорректный идентификатор кабинета «${slug}»: разрешены строчные латинские буквы, цифры, дефис и подчёркивание, до 24 символов`
        );
    }
    const info = parseToken(token);
    const problems = describeProblems(info, ['feedbacks', 'chat']);

    return { slug, label: label || slug, token, info, problems, buckets: makeBuckets() };
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
