import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
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
 * Оборачивает обработчик инструмента: превращает исключения в понятный текст,
 * чтобы модель могла объяснить пользователю, что пошло не так, а не упасть.
 */
export function guarded<A>(name: string, handler: (args: A, extra: CallExtra) => Promise<ToolResult>) {
    return async (args: A, extra: CallExtra): Promise<ToolResult> => {
        try {
            return await handler(args, extra);
        } catch (e) {
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
