import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { audit } from '../../audit.js';
import { canSend } from '../../config.js';
import {
    createDraft,
    describeDraft,
    discardDraft,
    getDraft,
    listDrafts,
    sendDraft,
    sendQuestionRejection,
    type DraftStatus
} from '../../drafts.js';
import { getFeedback, getQuestion, listChats, markQuestionViewed } from '../../wb/api.js';
import { actorOf, fail, guarded, text } from './common.js';

const CONFIRM_PHRASE = 'ОТПРАВИТЬ';

export function registerWriteTools(server: McpServer): void {
    // ─── Создание черновиков ────────────────────────────────────────────────

    server.registerTool(
        'wb_draft_feedback_reply',
        {
            title: 'Черновик ответа на отзыв',
            description:
                'Готовит ответ на отзыв, но НЕ отправляет его. Возвращает черновик и текст исходного отзыва для сверки. Отправка — отдельным вызовом wb_draft_send.',
            inputSchema: {
                feedbackId: z.string().min(1).describe('ID отзыва'),
                text: z.string().min(2).max(5000).describe('Текст ответа, 2–5000 символов')
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
        },
        guarded('wb_draft_feedback_reply', async (args, extra) => {
            const actor = actorOf(extra);
            const feedback = await getFeedback(args.feedbackId);
            if (feedback.answer?.text) {
                return fail(
                    `На отзыв ${args.feedbackId} уже есть ответ: «${feedback.answer.text}». Чтобы изменить его, используйте wb_draft_feedback_answer_edit (правка возможна один раз в течение 60 дней).`
                );
            }

            const note = `${feedback.productDetails?.productName ?? ''} · ${feedback.productValuation}★ · ${feedback.userName || 'без имени'} · «${feedback.text || feedback.pros || feedback.cons || 'без текста'}»`;
            const draft = createDraft({
                kind: 'feedback',
                targetId: args.feedbackId,
                targetNote: note,
                text: args.text,
                author: actor.email
            });

            return text(
                `${describeDraft(draft)}\n\nОтвет пока никуда не ушёл. Покажите его человеку и, получив согласие, вызовите wb_draft_send с draftId=${draft.id} и confirm="${CONFIRM_PHRASE}".`
            );
        })
    );

    server.registerTool(
        'wb_draft_feedback_answer_edit',
        {
            title: 'Черновик правки ответа на отзыв',
            description:
                'Готовит новую редакцию уже опубликованного ответа на отзыв. WB разрешает отредактировать ответ ОДИН раз в течение 60 дней — второй попытки не будет.',
            inputSchema: {
                feedbackId: z.string().min(1).describe('ID отзыва'),
                text: z.string().min(2).max(5000).describe('Новый текст ответа, 2–5000 символов')
            },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
        },
        guarded('wb_draft_feedback_answer_edit', async (args, extra) => {
            const actor = actorOf(extra);
            const feedback = await getFeedback(args.feedbackId);
            if (!feedback.answer?.text) {
                return fail(`У отзыва ${args.feedbackId} ещё нет ответа — используйте wb_draft_feedback_reply.`);
            }
            if (feedback.answer.editable === false) {
                return fail(
                    `WB помечает ответ на отзыв ${args.feedbackId} как нередактируемый: правка уже была использована либо прошло больше 60 дней.`
                );
            }

            const draft = createDraft({
                kind: 'feedback_edit',
                targetId: args.feedbackId,
                targetNote: `Заменяет ответ: «${feedback.answer.text}»`,
                text: args.text,
                author: actor.email
            });

            return text(
                `${describeDraft(draft)}\n\n⚠ Это единственная возможная правка этого ответа. Отправка: wb_draft_send с draftId=${draft.id} и confirm="${CONFIRM_PHRASE}".`
            );
        })
    );

    server.registerTool(
        'wb_draft_question_answer',
        {
            title: 'Черновик ответа на вопрос',
            description:
                'Готовит ответ на вопрос покупателя. Ответ будет опубликован после модерации WB. Отправка — отдельным вызовом wb_draft_send.',
            inputSchema: {
                questionId: z.string().min(1).describe('ID вопроса'),
                text: z.string().min(1).max(5000).describe('Текст ответа')
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
        },
        guarded('wb_draft_question_answer', async (args, extra) => {
            const actor = actorOf(extra);
            const question = await getQuestion(args.questionId);

            const draft = createDraft({
                kind: 'question',
                targetId: args.questionId,
                targetNote: `${question.productDetails?.productName ?? ''} · вопрос: «${question.text}»${question.answer?.text ? ` · текущий ответ: «${question.answer.text}»` : ''}`,
                text: args.text,
                author: actor.email
            });

            const warning = question.answer?.text
                ? '\n\n⚠ У вопроса уже есть ответ. Отправка заменит его — WB разрешает сделать это один раз в течение 60 дней.'
                : '';
            return text(
                `${describeDraft(draft)}${warning}\n\nОтправка: wb_draft_send с draftId=${draft.id} и confirm="${CONFIRM_PHRASE}".`
            );
        })
    );

    server.registerTool(
        'wb_draft_chat_message',
        {
            title: 'Черновик сообщения в чат',
            description:
                'Готовит сообщение покупателю в чат. Не отправляет. Максимум 1000 символов. Отправка — отдельным вызовом wb_draft_send.',
            inputSchema: {
                chatId: z.string().min(1).describe('ID чата из wb_chats_list'),
                text: z.string().min(1).max(1000).describe('Текст сообщения, до 1000 символов')
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
        },
        guarded('wb_draft_chat_message', async (args, extra) => {
            const actor = actorOf(extra);
            const chats = await listChats();
            const chat = chats.find(c => c.chatID === args.chatId);
            if (!chat) {
                return fail(`Чат ${args.chatId} не найден среди чатов продавца. Проверьте ID через wb_chats_list.`);
            }

            const draft = createDraft({
                kind: 'chat',
                targetId: args.chatId,
                targetNote: `Покупатель ${chat.clientName || 'без имени'}${chat.lastMessage ? ` · последнее сообщение: «${chat.lastMessage.text}»` : ''}`,
                text: args.text,
                author: actor.email
            });

            return text(
                `${describeDraft(draft)}\n\nОтправка: wb_draft_send с draftId=${draft.id} и confirm="${CONFIRM_PHRASE}".`
            );
        })
    );

    // ─── Работа с черновиками ───────────────────────────────────────────────

    server.registerTool(
        'wb_drafts_list',
        {
            title: 'Список черновиков',
            description: 'Черновики ответов: что подготовлено, что отправлено, что не удалось отправить.',
            inputSchema: {
                status: z.enum(['pending', 'sent', 'discarded', 'failed']).optional().describe('Фильтр по статусу'),
                limit: z.number().int().min(1).max(200).default(20)
            },
            annotations: { readOnlyHint: true }
        },
        guarded('wb_drafts_list', async args => {
            const drafts = listDrafts(args.status as DraftStatus | undefined, args.limit);
            if (drafts.length === 0) return text('Черновиков нет.');
            return text(drafts.map(describeDraft).join('\n\n'));
        })
    );

    server.registerTool(
        'wb_draft_send',
        {
            title: 'Отправить черновик покупателю',
            description:
                'ЕДИНСТВЕННЫЙ инструмент, который что-либо отправляет покупателю на Wildberries. Требует явного подтверждения человеком: параметр confirm должен быть строкой "ОТПРАВИТЬ". Никогда не вызывайте его, не показав текст черновика человеку и не получив согласия.',
            inputSchema: {
                draftId: z.string().min(1).describe('ID черновика'),
                confirm: z.string().describe(`Ровно "${CONFIRM_PHRASE}" — подтверждение от человека`)
            },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
        },
        guarded('wb_draft_send', async (args, extra) => {
            const actor = actorOf(extra);

            if (args.confirm !== CONFIRM_PHRASE) {
                return fail(
                    `Отправка не выполнена: параметр confirm должен быть ровно "${CONFIRM_PHRASE}". Сначала покажите человеку текст черновика и дождитесь согласия.`
                );
            }

            const draft = getDraft(args.draftId);
            if (!draft) return fail(`Черновик ${args.draftId} не найден.`);

            const sent = await sendDraft(args.draftId, actor);
            return text(`Отправлено.\n\n${describeDraft(sent)}`);
        })
    );

    server.registerTool(
        'wb_draft_discard',
        {
            title: 'Отменить черновик',
            description: 'Помечает черновик как отменённый. Ничего в WB не отправляется.',
            inputSchema: { draftId: z.string().min(1) },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
        },
        guarded('wb_draft_discard', async (args, extra) =>
            text(describeDraft(discardDraft(args.draftId, actorOf(extra))))
        )
    );

    // ─── Прочие изменяющие действия ─────────────────────────────────────────

    server.registerTool(
        'wb_question_reject',
        {
            title: 'Отклонить вопрос',
            description:
                'Отклоняет вопрос покупателя: ответ не публикуется. Действие необратимо, требует подтверждения человеком.',
            inputSchema: {
                questionId: z.string().min(1),
                reason: z.string().min(1).max(5000).describe('Причина отклонения'),
                confirm: z.string().describe(`Ровно "${CONFIRM_PHRASE}" — подтверждение от человека`)
            },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
        },
        guarded('wb_question_reject', async (args, extra) => {
            if (args.confirm !== CONFIRM_PHRASE) {
                return fail(`Отклонение не выполнено: confirm должен быть ровно "${CONFIRM_PHRASE}".`);
            }
            await sendQuestionRejection(args.questionId, args.reason, actorOf(extra));
            return text(`Вопрос ${args.questionId} отклонён.`);
        })
    );

    server.registerTool(
        'wb_question_mark_viewed',
        {
            title: 'Отметить вопрос просмотренным',
            description: 'Снимает с вопроса признак «не просмотрен». Покупатель этого не видит.',
            inputSchema: { questionId: z.string().min(1) },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
        },
        guarded('wb_question_mark_viewed', async (args, extra) => {
            const actor = actorOf(extra);
            if (!canSend(actor.role)) {
                return fail(`У вас роль «${actor.role}»: менять состояние вопросов нельзя.`);
            }
            await markQuestionViewed(args.questionId);
            audit({ actor: actor.email, action: 'question.viewed', target: args.questionId, outcome: 'ok' });
            return text(`Вопрос ${args.questionId} отмечен как просмотренный.`);
        })
    );

    server.registerTool(
        'wb_whoami',
        {
            title: 'Кто я и что мне разрешено',
            description: 'Показывает, под какой учётной записью работает коннектор и может ли она отправлять ответы покупателям.',
            inputSchema: {},
            annotations: { readOnlyHint: true }
        },
        guarded('wb_whoami', async (_args, extra) => {
            const actor = actorOf(extra);
            return text(
                [
                    `Пользователь: ${actor.email}`,
                    `Роль: ${actor.role}`,
                    `Отправка ответов покупателям: ${canSend(actor.role) ? 'разрешена' : 'запрещена'}`,
                    `Разрешения токена: ${actor.scopes.join(', ') || 'нет'}`
                ].join('\n')
            );
        })
    );
}
