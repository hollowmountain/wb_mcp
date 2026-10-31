import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { audit, type AuditOutcome } from '../../audit.js';
import { actorFromAuthInfo, type Actor } from '../../auth/provider.js';
import { DraftError } from '../../drafts.js';
import { logger } from '../../logger.js';
import { CabinetError } from '../../wb/cabinets.js';

export interface CallExtra {
    authInfo?: AuthInfo;
}

export interface ToolResult {
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
    // SDK ждёт результат с открытой формой — без индексной сигнатуры типы не сходятся.
    [key: string]: unknown;
}

/**
 * Понятный текст из ошибки любого источника.
 *
 * У ошибок Wildberries, Ozon, 1С и Nepsell есть toUserMessage() — объяснение,
 * что случилось и что делать. До 30.09.2026 его вызывали только для WB, а
 * остальные доходили до человека сырыми: от Nepsell при сбое прилетала
 * HTML-страница nginx, и Claude сотрудника пересказывал её как мог.
 */
export function explainError(e: unknown): string {
    if (hasUserMessage(e)) return e.toUserMessage();
    return e instanceof Error ? e.message : String(e);
}

function hasUserMessage(e: unknown): e is Error & { toUserMessage(): string } {
    return e instanceof Error && typeof (e as { toUserMessage?: unknown }).toUserMessage === 'function';
}

export const text = (value: string): ToolResult => ({ content: [{ type: 'text', text: value }] });

/**
 * Предел одного ответа выгрузок «за месяц». Всё, что отдаёт инструмент,
 * ложится в контекст Claude целиком, поэтому длинные таблицы режем на
 * страницы. 30 КБ — договорённость из ТЗ на отчёт «3 Формы» (30.10.2026).
 * Считаем в байтах UTF-8: кириллица весит вдвое, и по знакам предел
 * перевалил бы за 50 КБ.
 */
export const REPLY_BYTES = 30_000;

/** Сумма для таблицы: «1 234,50», с копейками, без знака рубля. */
export const amount = (v: number): string =>
    v.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Страница таблицы: с offset, не больше limit строк и не больше REPLY_BYTES
 * вместе с шапкой. Хотя бы одна строка берётся всегда, иначе листание
 * встало бы на длинной строке.
 *
 * Обрезка здесь никогда не бывает молчаливой: внизу пишется, какие строки
 * показаны из скольких и с какого offset продолжать. Итоги вызывающий
 * считает сам по всем строкам, а не по странице.
 */
export function pageOf(rows: string[], offset: number, limit: number, head: string): { lines: string[]; footer: string } {
    // Запас под строку «Строки … из …» и перевод строк.
    const budget = REPLY_BYTES - Buffer.byteLength(head, 'utf8') - 200;
    const lines: string[] = [];
    let used = 0;
    let bySize = false;
    for (let i = offset; i < rows.length && lines.length < limit; i++) {
        const b = Buffer.byteLength(rows[i]!, 'utf8') + 1;
        if (lines.length > 0 && used + b > budget) {
            bySize = true;
            break;
        }
        lines.push(rows[i]!);
        used += b;
    }
    const end = offset + lines.length;
    if (rows.length === 0) return { lines, footer: '' };
    if (lines.length === 0) return { lines, footer: `Строк всего ${rows.length}, offset=${offset} — дальше пусто. Начните с offset=0.` };
    const footer =
        end < rows.length
            ? `Строки ${offset + 1}–${end} из ${rows.length}${bySize ? ' (страница урезана до 30 КБ)' : ''}. Дальше: offset=${end}`
            : `Строки ${offset + 1}–${end} из ${rows.length}${offset > 0 ? ' — последняя страница' : ''}.`;
    return { lines, footer };
}

export const fail = (value: string): ToolResult => ({ content: [{ type: 'text', text: value }], isError: true });

export function actorOf(extra: CallExtra): Actor {
    return actorFromAuthInfo(extra.authInfo);
}

/**
 * Записываем сам факт вызова: кто, что дёрнул, по какому кабинету, чем
 * кончилось и сколько заняло.
 *
 * Ни параметров запроса, ни ответа здесь нет и быть не должно. Иначе в журнал
 * попадут поисковые строки и тексты переписки с покупателями, и он из средства
 * понять, чем пользуются, превратится в слежку за тем, что человек читал.
 * Кабинет — единственное исключение: без него не отличить работу по «красоте»
 * от работы по «харбезу», а сам по себе он ничего личного не сообщает.
 */
function record(name: string, args: unknown, extra: CallExtra, outcome: AuditOutcome, startedAt: number): void {
    try {
        const email = typeof extra.authInfo?.extra?.email === 'string' ? extra.authInfo.extra.email : 'аноним';
        const cabinet =
            args && typeof args === 'object' && typeof (args as { cabinet?: unknown }).cabinet === 'string'
                ? (args as { cabinet: string }).cabinet
                : undefined;
        audit({
            actor: email,
            action: `tool.${name}`,
            cabinet,
            outcome,
            detail: { ms: Date.now() - startedAt }
        });
    } catch (e) {
        // Журнал не должен ломать работу инструмента: если запись не удалась,
        // человек всё равно должен получить свои данные.
        logger.warn({ tool: name, err: e }, 'не удалось записать вызов в журнал');
    }
}

/**
 * Оборачивает обработчик инструмента: превращает исключения в понятный текст,
 * чтобы модель могла объяснить пользователю, что пошло не так, а не упасть.
 * Заодно отмечает вызов в журнале.
 */
export function guarded<A>(name: string, handler: (args: A, extra: CallExtra) => Promise<ToolResult>) {
    return async (args: A, extra: CallExtra): Promise<ToolResult> => {
        const startedAt = Date.now();
        try {
            const result = await handler(args, extra);
            // Отказ по правам приходит обычным результатом с пометкой isError —
            // отличаем его от успеха, иначе в журнале не увидеть, кому чего
            // не хватает для работы. А если упали все кабинеты сразу, это не
            // отказ, а сбой источника — пишем его как error.
            const outcome = result.sourceFailed === true ? 'error' : result.isError === true ? 'denied' : 'ok';
            record(name, args, extra, outcome, startedAt);
            delete result.sourceFailed;
            return result;
        } catch (e) {
            // Не тот кабинет — это отказ по доступу, а не поломка: в журнале
            // он должен стоять рядом с другими отказами, а не среди ошибок.
            if (e instanceof CabinetError) {
                record(name, args, extra, 'denied', startedAt);
                return fail(e.message);
            }
            record(name, args, extra, 'error', startedAt);
            if (e instanceof DraftError) return fail(e.message);
            if (hasUserMessage(e)) {
                // Упала или отказала площадка — это ожидаемо, а не ошибка в нашем коде.
                const status = (e as { status?: unknown }).status;
                logger.warn({ tool: name, source: e.name, status, err: e.message.slice(0, 300) }, 'source error in tool');
                return fail(e.toUserMessage());
            }
            logger.error({ tool: name, err: e }, 'tool failed');
            return fail(`Инструмент ${name} завершился ошибкой: ${e instanceof Error ? e.message : String(e)}`);
        }
    };
}

/** Приводим Unix-даты: принимаем и ISO-строку, и секунды. */
export function toUnixSeconds(value: string | number | undefined): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value === 'number') return Math.floor(value);
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) throw new DraftError(`Не удалось разобрать дату «${value}». Ожидается ISO-8601 или Unix-время.`);
    return Math.floor(parsed / 1000);
}
