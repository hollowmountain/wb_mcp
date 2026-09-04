import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { audit, type AuditOutcome } from '../../audit.js';
import { actorFromAuthInfo, type Actor } from '../../auth/provider.js';
import { DraftError } from '../../drafts.js';
import { logger } from '../../logger.js';
import { WbApiError } from '../../wb/client.js';
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

export const text = (value: string): ToolResult => ({ content: [{ type: 'text', text: value }] });

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
            // не хватает для работы.
            record(name, args, extra, result.isError === true ? 'denied' : 'ok', startedAt);
            return result;
        } catch (e) {
            record(name, args, extra, 'error', startedAt);
            if (e instanceof WbApiError) {
                logger.warn({ tool: name, status: e.status, path: e.path }, 'wb error in tool');
                return fail(e.toUserMessage());
            }
            if (e instanceof DraftError || e instanceof CabinetError) return fail(e.message);
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
