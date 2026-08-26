import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { kvGet, kvSet } from '../../db/index.js';
import {
    countFeedbacks,
    countQuestions,
    countUnansweredFeedbacks,
    countUnansweredQuestions,
    getFeedback,
    getQuestion,
    hasNewFeedbacksOrQuestions,
    listArchivedFeedbacks,
    listChatEvents,
    listChats,
    listFeedbacks,
    listQuestions
} from '../../wb/api.js';
import { formatChat, formatChatEvent, formatFeedback, formatQuestion, joinBlocks } from '../format.js';
import { guarded, text, toUnixSeconds, type ToolResult } from './common.js';

const CHAT_CURSOR_KEY = 'chat.events.cursor';

const dateArg = z
    .union([z.string(), z.number()])
    .optional()
    .describe('Дата в ISO-8601 (2026-08-01) или Unix-время в секундах');

export function registerReadTools(server: McpServer): void {
    server.registerTool(
        'wb_overview',
        {
            title: 'Сводка обращений',
            description:
                'Общая картина по обращениям покупателей на Wildberries: сколько отзывов и вопросов ждут ответа, есть ли непросмотренные, сколько открытых чатов. Начинайте с этого инструмента.',
            inputSchema: {},
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('wb_overview', async (): Promise<ToolResult> => {
            const [feedbacks, questions, fresh] = await Promise.all([
                countUnansweredFeedbacks(),
                countUnansweredQuestions(),
                hasNewFeedbacksOrQuestions()
            ]);

            let chatsLine = '';
            try {
                const chats = await listChats();
                chatsLine = `\nЧатов с покупателями: ${chats.length}`;
            } catch {
                chatsLine = '\nЧаты: недоступны (проверьте категорию токена «Чат с покупателями»)';
            }

            return text(
                [
                    'Обращения покупателей Wildberries',
                    `Отзывы без обработки: ${feedbacks.countUnanswered} (сегодня ${feedbacks.countUnansweredToday})`,
                    `Вопросы без ответа: ${questions.countUnanswered} (сегодня ${questions.countUnansweredToday})`,
                    `Непросмотренные: отзывы — ${fresh.hasNewFeedbacks ? 'есть' : 'нет'}, вопросы — ${fresh.hasNewQuestions ? 'есть' : 'нет'}`
                ].join('\n') + chatsLine
            );
        })
    );

    // ─── Отзывы ─────────────────────────────────────────────────────────────

    server.registerTool(
        'wb_feedbacks_list',
        {
            title: 'Список отзывов',
            description:
                'Отзывы покупателей. isAnswered=false — то, что ещё требует обработки. Отзыв считается обработанным, если на него дан ответ или в нём нет текста и фото.',
            inputSchema: {
                isAnswered: z.boolean().describe('false — необработанные, true — обработанные'),
                take: z.number().int().min(1).max(5000).default(20).describe('Сколько отзывов вернуть, максимум 5000'),
                skip: z.number().int().min(0).max(199990).default(0).describe('Сколько пропустить (пагинация)'),
                nmId: z.number().int().optional().describe('Артикул WB — фильтр по конкретному товару'),
                order: z.enum(['dateAsc', 'dateDesc']).default('dateDesc').describe('Сортировка по дате'),
                dateFrom: dateArg,
                dateTo: dateArg
            },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('wb_feedbacks_list', async args => {
            const res = await listFeedbacks({
                isAnswered: args.isAnswered,
                take: args.take,
                skip: args.skip,
                nmId: args.nmId,
                order: args.order,
                dateFrom: toUnixSeconds(args.dateFrom),
                dateTo: toUnixSeconds(args.dateTo)
            });

            const header = `Всего необработанных: ${res.countUnanswered}, в архиве: ${res.countArchive}. Показано: ${res.feedbacks.length}.`;
            const blocks = res.feedbacks.map((f, i) => formatFeedback(f, args.skip + i + 1));
            return text(`${header}\n\n${joinBlocks(blocks, 'Отзывов по этим условиям нет.')}`);
        })
    );

    server.registerTool(
        'wb_feedback_get',
        {
            title: 'Отзыв по ID',
            description: 'Полные данные одного отзыва, включая наш ответ и признак возможности его отредактировать.',
            inputSchema: { id: z.string().min(1).describe('ID отзыва') },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('wb_feedback_get', async args => text(formatFeedback(await getFeedback(args.id))))
    );

    server.registerTool(
        'wb_feedbacks_archive',
        {
            title: 'Архив отзывов',
            description:
                'Архивные отзывы: те, на которые дан ответ, либо которые пролежали без ответа 30 дней, либо без текста и фото.',
            inputSchema: {
                take: z.number().int().min(1).max(5000).default(20),
                skip: z.number().int().min(0).default(0),
                nmId: z.number().int().optional().describe('Артикул WB'),
                order: z.enum(['dateAsc', 'dateDesc']).default('dateDesc')
            },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('wb_feedbacks_archive', async args => {
            const res = await listArchivedFeedbacks(args);
            const blocks = res.feedbacks.map((f, i) => formatFeedback(f, args.skip + i + 1));
            return text(joinBlocks(blocks, 'Архивных отзывов по этим условиям нет.'));
        })
    );

    server.registerTool(
        'wb_feedbacks_count',
        {
            title: 'Количество отзывов за период',
            description: 'Сколько отзывов обработано или не обработано за заданный период.',
            inputSchema: { isAnswered: z.boolean(), dateFrom: dateArg, dateTo: dateArg },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('wb_feedbacks_count', async args => {
            const count = await countFeedbacks({
                isAnswered: args.isAnswered,
                dateFrom: toUnixSeconds(args.dateFrom),
                dateTo: toUnixSeconds(args.dateTo)
            });
            return text(`${args.isAnswered ? 'Обработанных' : 'Необработанных'} отзывов за период: ${count}`);
        })
    );

    // ─── Вопросы ────────────────────────────────────────────────────────────

    server.registerTool(
        'wb_questions_list',
        {
            title: 'Список вопросов',
            description: 'Вопросы покупателей о товарах. isAnswered=false — вопросы, которые ждут ответа.',
            inputSchema: {
                isAnswered: z.boolean().describe('false — без ответа, true — с ответом'),
                take: z.number().int().min(1).max(10000).default(20),
                skip: z.number().int().min(0).max(10000).default(0),
                nmId: z.number().int().optional().describe('Артикул WB'),
                order: z.enum(['dateAsc', 'dateDesc']).default('dateDesc'),
                dateFrom: dateArg,
                dateTo: dateArg
            },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('wb_questions_list', async args => {
            const res = await listQuestions({
                isAnswered: args.isAnswered,
                take: args.take,
                skip: args.skip,
                nmId: args.nmId,
                order: args.order,
                dateFrom: toUnixSeconds(args.dateFrom),
                dateTo: toUnixSeconds(args.dateTo)
            });
            const header = `Без ответа: ${res.countUnanswered}, в архиве: ${res.countArchive}. Показано: ${res.questions.length}.`;
            const blocks = res.questions.map((q, i) => formatQuestion(q, args.skip + i + 1));
            return text(`${header}\n\n${joinBlocks(blocks, 'Вопросов по этим условиям нет.')}`);
        })
    );

    server.registerTool(
        'wb_question_get',
        {
            title: 'Вопрос по ID',
            description: 'Полные данные одного вопроса покупателя.',
            inputSchema: { id: z.string().min(1).describe('ID вопроса') },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('wb_question_get', async args => text(formatQuestion(await getQuestion(args.id))))
    );

    server.registerTool(
        'wb_questions_count',
        {
            title: 'Количество вопросов за период',
            description: 'Сколько вопросов отвечено или не отвечено за заданный период.',
            inputSchema: { isAnswered: z.boolean(), dateFrom: dateArg, dateTo: dateArg },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('wb_questions_count', async args => {
            const count = await countQuestions({
                isAnswered: args.isAnswered,
                dateFrom: toUnixSeconds(args.dateFrom),
                dateTo: toUnixSeconds(args.dateTo)
            });
            return text(`${args.isAnswered ? 'Отвеченных' : 'Неотвеченных'} вопросов за период: ${count}`);
        })
    );

    // ─── Чаты ───────────────────────────────────────────────────────────────

    server.registerTool(
        'wb_chats_list',
        {
            title: 'Список чатов',
            description:
                'Все чаты продавца с покупателями. Чат всегда начинает покупатель. WB рекомендует отвечать в течение 10 дней.',
            inputSchema: {},
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('wb_chats_list', async () => {
            const chats = await listChats();
            const blocks = chats.map((c, i) => formatChat(c, i + 1));
            return text(joinBlocks(blocks, 'Открытых чатов нет.'));
        })
    );

    server.registerTool(
        'wb_chat_events',
        {
            title: 'События чатов',
            description:
                'Лента сообщений всех чатов. Без параметров отдаёт события с момента прошлого вызова (курсор хранится на сервере). Передайте since=0, чтобы прочитать ленту с самого начала.',
            inputSchema: {
                since: z
                    .number()
                    .int()
                    .min(0)
                    .optional()
                    .describe('Курсор: Unix-время в миллисекундах. 0 — с начала. Не указан — продолжить с прошлого раза.'),
                saveCursor: z.boolean().default(true).describe('Запомнить новый курсор для следующего вызова')
            },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('wb_chat_events', async args => {
            const stored = kvGet(CHAT_CURSOR_KEY);
            const since = args.since !== undefined ? (args.since === 0 ? undefined : args.since) : stored ? Number(stored) : undefined;

            const res = await listChatEvents(since);
            if (args.saveCursor && res.next) kvSet(CHAT_CURSOR_KEY, String(res.next));

            const header = `Событий получено: ${res.totalEvents}. Курсор для следующего запроса: ${res.next}.`;
            const blocks = res.events.map((e, i) => formatChatEvent(e, i + 1));
            return text(`${header}\n\n${joinBlocks(blocks, 'Новых событий в чатах нет.')}`);
        })
    );
}
