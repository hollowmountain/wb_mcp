import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { allowedCabinets, resolveCabinets } from '../../access.js';
import type { Actor } from '../../auth/provider.js';
import { config } from '../../config.js';
import { kvGet, kvSet } from '../../db/index.js';
import type { Cabinet } from '../../wb/cabinets.js';
import { CATEGORY_NAMES, daysLeft } from '../../wb/token.js';
import {
    countFeedbacks,
    getCardByNmId,
    getGoodByNmId,
    listClaims,
    searchCards,
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
import {
    formatChat,
    formatChatEvent,
    formatFeedback,
    formatProductCard,
    formatQuestion,
    formatReturnClaim,
    joinBlocks
} from '../format.js';
import { actorOf, guarded, text, toUnixSeconds, type ToolResult } from './common.js';
import { locateFeedback, locateQuestion } from './resolve.js';

const chatCursorKey = (slug: string): string => `chat.events.cursor.${slug}`;

const dateArg = z
    .union([z.string(), z.number()])
    .optional()
    .describe('Дата в ISO-8601 (2026-08-01) или Unix-время в секундах');

const cabinetArg = z
    .string()
    .optional()
    .describe('Идентификатор кабинета Wildberries. Не указан — по всем кабинетам сразу.');

const cabinetRequiredArg = z
    .string()
    .optional()
    .describe(
        'Идентификатор кабинета Wildberries. Если не указан, кабинет определяется по идентификатору обращения.'
    );

/** Заголовок блока кабинета. При единственном доступном кабинете не засоряем вывод. */
function heading(cabinet: Cabinet, total: number): string {
    return total === 1 ? '' : `━━ Кабинет ${cabinet.slug} (${cabinet.label}) ━━\n`;
}

/** Прогон операции по доступным кабинетам с аккуратной обработкой отказов. */
async function overCabinets(
    actor: Actor,
    slug: string | undefined,
    run: (cabinet: Cabinet) => Promise<string>
): Promise<ToolResult> {
    const cabinets = resolveCabinets(actor, slug);
    const blocks = await Promise.all(
        cabinets.map(async cabinet => {
            try {
                return heading(cabinet, cabinets.length) + (await run(cabinet));
            } catch (e) {
                // Падение одного кабинета не должно скрывать данные остальных.
                const message = e instanceof Error ? e.message : String(e);
                return `${heading(cabinet, cabinets.length)}Ошибка: ${message}`;
            }
        })
    );
    return text(blocks.join('\n\n'));
}

export function registerReadTools(server: McpServer): void {
    server.registerTool(
        'wb_cabinets',
        {
            title: 'Кабинеты Wildberries',
            description:
                'Список подключённых кабинетов продавца: идентификаторы для параметра cabinet, права токена и срок его действия. Вызовите первым, если не знаете, какие кабинеты есть.',
            inputSchema: {},
            annotations: { readOnlyHint: true }
        },
        guarded('wb_cabinets', async (_args, extra) => {
            const blocks = allowedCabinets(actorOf(extra)).map(c => {
                const days = daysLeft(c.info);
                const cats = [...c.info.categories].map(k => CATEGORY_NAMES[k]).join(', ');
                const lines = [
                    `${c.slug} — ${c.label}`,
                    `   Токен: ${c.info.kind}, ${c.info.readOnly ? 'ТОЛЬКО ЧТЕНИЕ' : 'чтение и запись'}`,
                    `   Истекает: ${c.info.expiresAt?.toISOString().slice(0, 10) ?? '?'}${days === null ? '' : ` (осталось ${days} дн.)`}`,
                    `   Категории: ${cats || 'нет'}`
                ];
                if (c.problems.length > 0) lines.push(`   ⚠ ${c.problems.join('; ')}`);

                if (c.dataInfo) {
                    const dataDays = daysLeft(c.dataInfo);
                    const dataCats = [...c.dataInfo.categories].map(k => CATEGORY_NAMES[k]).join(', ');
                    lines.push(
                        `   Токен данных: ${c.dataInfo.readOnly ? 'только чтение' : 'ЧТЕНИЕ И ЗАПИСЬ'}, истекает ${c.dataInfo.expiresAt?.toISOString().slice(0, 10) ?? '?'}${dataDays === null ? '' : ` (осталось ${dataDays} дн.)`}`,
                        `   Данные доступны: ${dataCats || 'нет'}`
                    );
                    if (c.dataProblems.length > 0) lines.push(`   ⚠ токен данных: ${c.dataProblems.join('; ')}`);
                } else {
                    lines.push('   Токен данных не задан — заказы, карточки, цены и возвраты недоступны');
                }
                return lines.join('\n');
            });
            return text(blocks.join('\n\n'));
        })
    );

    server.registerTool(
        'wb_overview',
        {
            title: 'Сводка обращений',
            description:
                'Сколько отзывов и вопросов ждут ответа, есть ли непросмотренные, сколько открытых чатов. По всем кабинетам, если не указан конкретный. Начинайте с этого инструмента.',
            inputSchema: { cabinet: cabinetArg },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('wb_overview', async (args, extra) =>
            overCabinets(actorOf(extra), args.cabinet, async cabinet => {
                const [feedbacks, questions, fresh] = await Promise.all([
                    countUnansweredFeedbacks(cabinet),
                    countUnansweredQuestions(cabinet),
                    hasNewFeedbacksOrQuestions(cabinet)
                ]);

                let chatsLine: string;
                try {
                    chatsLine = `Чатов с покупателями: ${(await listChats(cabinet)).length}`;
                } catch {
                    chatsLine = 'Чаты: недоступны (проверьте категорию токена «Чат с покупателями»)';
                }

                return [
                    `Отзывы без обработки: ${feedbacks.countUnanswered} (сегодня ${feedbacks.countUnansweredToday})`,
                    `Вопросы без ответа: ${questions.countUnanswered} (сегодня ${questions.countUnansweredToday})`,
                    `Непросмотренные: отзывы — ${fresh.hasNewFeedbacks ? 'есть' : 'нет'}, вопросы — ${fresh.hasNewQuestions ? 'есть' : 'нет'}`,
                    chatsLine
                ].join('\n');
            })
        )
    );

    // ─── Отзывы ─────────────────────────────────────────────────────────────

    server.registerTool(
        'wb_feedbacks_list',
        {
            title: 'Список отзывов',
            description:
                'Отзывы покупателей. isAnswered=false — то, что ещё требует обработки. Отзыв считается обработанным, если на него дан ответ или в нём нет текста и фото.',
            inputSchema: {
                cabinet: cabinetArg,
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
        guarded('wb_feedbacks_list', async (args, extra) =>
            overCabinets(actorOf(extra), args.cabinet, async cabinet => {
                const res = await listFeedbacks(cabinet, {
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
                return `${header}\n\n${joinBlocks(blocks, 'Отзывов по этим условиям нет.')}`;
            })
        )
    );

    server.registerTool(
        'wb_feedback_get',
        {
            title: 'Отзыв по ID',
            description: 'Полные данные одного отзыва, включая наш ответ и признак возможности его отредактировать.',
            inputSchema: { cabinet: cabinetRequiredArg, id: z.string().min(1).describe('ID отзыва') },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('wb_feedback_get', async (args, extra) => {
            const { cabinet, item } = await locateFeedback(actorOf(extra), args.cabinet, args.id);
            return text(heading(cabinet, config.cabinets.size) + formatFeedback(item));
        })
    );

    server.registerTool(
        'wb_feedbacks_archive',
        {
            title: 'Архив отзывов',
            description:
                'Архивные отзывы: те, на которые дан ответ, либо которые пролежали без ответа 30 дней, либо без текста и фото.',
            inputSchema: {
                cabinet: cabinetArg,
                take: z.number().int().min(1).max(5000).default(20),
                skip: z.number().int().min(0).default(0),
                nmId: z.number().int().optional().describe('Артикул WB'),
                order: z.enum(['dateAsc', 'dateDesc']).default('dateDesc')
            },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('wb_feedbacks_archive', async (args, extra) =>
            overCabinets(actorOf(extra), args.cabinet, async cabinet => {
                const res = await listArchivedFeedbacks(cabinet, {
                    take: args.take,
                    skip: args.skip,
                    nmId: args.nmId,
                    order: args.order
                });
                const blocks = res.feedbacks.map((f, i) => formatFeedback(f, args.skip + i + 1));
                return joinBlocks(blocks, 'Архивных отзывов по этим условиям нет.');
            })
        )
    );

    server.registerTool(
        'wb_feedbacks_count',
        {
            title: 'Количество отзывов за период',
            description: 'Сколько отзывов обработано или не обработано за заданный период.',
            inputSchema: { cabinet: cabinetArg, isAnswered: z.boolean(), dateFrom: dateArg, dateTo: dateArg },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('wb_feedbacks_count', async (args, extra) =>
            overCabinets(actorOf(extra), args.cabinet, async cabinet => {
                const count = await countFeedbacks(cabinet, {
                    isAnswered: args.isAnswered,
                    dateFrom: toUnixSeconds(args.dateFrom),
                    dateTo: toUnixSeconds(args.dateTo)
                });
                return `${args.isAnswered ? 'Обработанных' : 'Необработанных'} отзывов за период: ${count}`;
            })
        )
    );

    // ─── Вопросы ────────────────────────────────────────────────────────────

    server.registerTool(
        'wb_questions_list',
        {
            title: 'Список вопросов',
            description: 'Вопросы покупателей о товарах. isAnswered=false — вопросы, которые ждут ответа.',
            inputSchema: {
                cabinet: cabinetArg,
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
        guarded('wb_questions_list', async (args, extra) =>
            overCabinets(actorOf(extra), args.cabinet, async cabinet => {
                const res = await listQuestions(cabinet, {
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
                return `${header}\n\n${joinBlocks(blocks, 'Вопросов по этим условиям нет.')}`;
            })
        )
    );

    server.registerTool(
        'wb_question_get',
        {
            title: 'Вопрос по ID',
            description: 'Полные данные одного вопроса покупателя.',
            inputSchema: { cabinet: cabinetRequiredArg, id: z.string().min(1).describe('ID вопроса') },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('wb_question_get', async (args, extra) => {
            const { cabinet, item } = await locateQuestion(actorOf(extra), args.cabinet, args.id);
            return text(heading(cabinet, config.cabinets.size) + formatQuestion(item));
        })
    );

    server.registerTool(
        'wb_questions_count',
        {
            title: 'Количество вопросов за период',
            description: 'Сколько вопросов отвечено или не отвечено за заданный период.',
            inputSchema: { cabinet: cabinetArg, isAnswered: z.boolean(), dateFrom: dateArg, dateTo: dateArg },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('wb_questions_count', async (args, extra) =>
            overCabinets(actorOf(extra), args.cabinet, async cabinet => {
                const count = await countQuestions(cabinet, {
                    isAnswered: args.isAnswered,
                    dateFrom: toUnixSeconds(args.dateFrom),
                    dateTo: toUnixSeconds(args.dateTo)
                });
                return `${args.isAnswered ? 'Отвеченных' : 'Неотвеченных'} вопросов за период: ${count}`;
            })
        )
    );

    // ─── Чаты ───────────────────────────────────────────────────────────────

    server.registerTool(
        'wb_chats_list',
        {
            title: 'Список чатов',
            description:
                'Все чаты продавца с покупателями. Чат всегда начинает покупатель. WB рекомендует отвечать в течение 10 дней.',
            inputSchema: { cabinet: cabinetArg },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('wb_chats_list', async (args, extra) =>
            overCabinets(actorOf(extra), args.cabinet, async cabinet => {
                const chats = await listChats(cabinet);
                return joinBlocks(
                    chats.map((c, i) => formatChat(c, i + 1)),
                    'Открытых чатов нет.'
                );
            })
        )
    );

    server.registerTool(
        'wb_chat_events',
        {
            title: 'События чатов',
            description:
                'Лента сообщений всех чатов. Без параметров отдаёт события с момента прошлого вызова — курсор хранится на сервере отдельно для каждого кабинета. Передайте since=0, чтобы прочитать ленту с начала.',
            inputSchema: {
                cabinet: cabinetArg,
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
        guarded('wb_chat_events', async (args, extra) =>
            overCabinets(actorOf(extra), args.cabinet, async cabinet => {
                const key = chatCursorKey(cabinet.slug);
                const stored = kvGet(key);
                const since =
                    args.since !== undefined
                        ? args.since === 0
                            ? undefined
                            : args.since
                        : stored
                          ? Number(stored)
                          : undefined;

                const res = await listChatEvents(cabinet, since);
                if (args.saveCursor && res.next) kvSet(key, String(res.next));

                const header = `Событий получено: ${res.totalEvents}. Курсор для следующего запроса: ${res.next}.`;
                const blocks = res.events.map((e, i) => formatChatEvent(e, i + 1));
                return `${header}\n\n${joinBlocks(blocks, 'Новых событий в чатах нет.')}`;
            })
        )
    );

    server.registerTool(
        'wb_product',
        {
            title: 'Карточка товара',
            description:
                'Карточка товара: характеристики, состав, размеры, штрихкоды, габариты и текущая цена со скидкой. Ищет по nmID (он есть в каждом отзыве и вопросе) либо по артикулу продавца. Берите этот инструмент, когда покупатель спрашивает про состав, размер, комплектацию или цену.',
            inputSchema: {
                nmId: z
                    .number()
                    .int()
                    .positive()
                    .optional()
                    .describe('Номенклатура WB (nmID). Указана в каждом отзыве и вопросе.'),
                article: z
                    .string()
                    .optional()
                    .describe('Артикул продавца или его часть. Вернутся все совпадения.'),
                cabinet: cabinetRequiredArg
            },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('wb_product', async (args, extra) => {
            if (args.nmId === undefined && !args.article?.trim()) {
                return text('Укажите nmId или article — без одного из них искать нечего.');
            }
            return overCabinets(actorOf(extra), args.cabinet, async cabinet => {
                if (args.nmId !== undefined) {
                    const card = await getCardByNmId(cabinet, args.nmId);
                    if (!card) return `Товар nmID ${args.nmId} в этом кабинете не найден.`;
                    const good = await getGoodByNmId(cabinet, args.nmId);
                    return formatProductCard(card, good);
                }
                const cards = await searchCards(cabinet, args.article!.trim(), 10);
                if (cards.length === 0) return `По запросу «${args.article}» ничего не найдено.`;
                const blocks = await Promise.all(
                    cards.map(async card => formatProductCard(card, await getGoodByNmId(cabinet, card.nmID)))
                );
                return joinBlocks(blocks, 'Ничего не найдено');
            });
        })
    );

    server.registerTool(
        'wb_returns',
        {
            title: 'Заявки на возврат',
            description:
                'Заявки покупателей на возврат товара: что вернули, почему, на какую сумму и в каком состоянии заявка. По всем кабинетам, если не указан конкретный.',
            inputSchema: {
                cabinet: cabinetArg,
                archive: z
                    .boolean()
                    .optional()
                    .describe('true — показать архивные, уже закрытые заявки. По умолчанию только активные.'),
                limit: z.number().int().min(1).max(200).optional().describe('Сколько заявок вернуть, по умолчанию 20')
            },
            annotations: { readOnlyHint: true, openWorldHint: true }
        },
        guarded('wb_returns', async (args, extra) =>
            overCabinets(actorOf(extra), args.cabinet, async cabinet => {
                const page = await listClaims(cabinet, { archive: args.archive, limit: args.limit });
                const blocks = page.claims.map((c, i) => formatReturnClaim(c, i + 1));
                const head = `Заявок ${args.archive ? 'в архиве' : 'активных'}: ${page.total}`;
                return `${head}\n\n${joinBlocks(blocks, 'Заявок нет')}`;
            })
        )
    );
}
