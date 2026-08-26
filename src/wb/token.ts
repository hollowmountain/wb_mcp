/**
 * Разбор JWT-токена Wildberries.
 *
 * Поле `s` — битовая маска свойств токена, документирована здесь:
 * https://dev.wildberries.ru/openapi/api-information (раздел «Поле s»).
 * Позиции бит считаются от нуля.
 */

export const CATEGORY_BITS = {
    content: 1,
    analytics: 2,
    prices: 3,
    marketplace: 4,
    statistics: 5,
    promotion: 6,
    /** Вопросы и отзывы */
    feedbacks: 7,
    /** Чат с покупателями */
    chat: 9,
    supplies: 10,
    returns: 11,
    documents: 12,
    finance: 13,
    users: 16
} as const;

export type CategoryKey = keyof typeof CATEGORY_BITS;

/** Бит 30 — «Токен только на чтение». */
const READ_ONLY_BIT = 30;

export const CATEGORY_NAMES: Record<CategoryKey, string> = {
    content: 'Контент',
    analytics: 'Аналитика',
    prices: 'Цены и скидки',
    marketplace: 'Маркетплейс',
    statistics: 'Статистика',
    promotion: 'Продвижение',
    feedbacks: 'Вопросы и отзывы',
    chat: 'Чат с покупателями',
    supplies: 'Поставки',
    returns: 'Возвраты покупателями',
    documents: 'Документы',
    finance: 'Финансы',
    users: 'Пользователи'
};

export type TokenKind = 'basic' | 'test' | 'personal' | 'service' | 'unknown';

export interface TokenInfo {
    kind: TokenKind;
    /** Токен не может ничего изменять: установлен бит 30. */
    readOnly: boolean;
    categories: Set<CategoryKey>;
    expiresAt: Date | null;
    /** ID продавца — по нему видно, что кабинеты действительно разные. */
    sellerId: string | null;
    mask: number;
}

export class TokenParseError extends Error {}

function kindOf(payload: Record<string, unknown>): TokenKind {
    switch (payload.acc) {
        case 1:
            return 'basic';
        case 2:
            return 'test';
        case 3:
            return 'personal';
        case 4:
            return 'service';
        default:
            return 'unknown';
    }
}

export function parseToken(token: string): TokenInfo {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts[1]) {
        throw new TokenParseError('Это не похоже на JWT из личного кабинета Wildberries');
    }

    let payload: Record<string, unknown>;
    try {
        payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
    } catch {
        throw new TokenParseError('Не удалось разобрать payload токена');
    }

    const mask = typeof payload.s === 'number' ? payload.s : 0;
    const categories = new Set<CategoryKey>();
    for (const [key, bit] of Object.entries(CATEGORY_BITS)) {
        if ((mask >>> bit) & 1) categories.add(key as CategoryKey);
    }

    return {
        kind: kindOf(payload),
        readOnly: Boolean((mask >>> READ_ONLY_BIT) & 1),
        categories,
        expiresAt: typeof payload.exp === 'number' ? new Date(payload.exp * 1000) : null,
        sellerId: typeof payload.sid === 'string' ? payload.sid : null,
        mask
    };
}

/** Что не так с токеном для наших задач. Пустой массив — всё в порядке. */
export function describeProblems(info: TokenInfo, required: CategoryKey[]): string[] {
    const problems: string[] = [];

    for (const key of required) {
        if (!info.categories.has(key)) {
            problems.push(`нет доступа к категории «${CATEGORY_NAMES[key]}»`);
        }
    }
    if (info.readOnly) {
        problems.push('токен только на чтение — отвечать покупателям им нельзя');
    }
    if (info.expiresAt && info.expiresAt.getTime() < Date.now()) {
        problems.push(`срок действия истёк ${info.expiresAt.toISOString().slice(0, 10)}`);
    }
    if (info.kind === 'basic') {
        problems.push('базовый токен: лимит 5 запросов в час на отзывы и 1 в час на чаты — работать невозможно');
    }
    return problems;
}

export function daysLeft(info: TokenInfo): number | null {
    if (!info.expiresAt) return null;
    return Math.floor((info.expiresAt.getTime() - Date.now()) / 86_400_000);
}
