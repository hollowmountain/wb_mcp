import { audit } from './audit.js';
import { db, newId, now } from './db/index.js';
import type { Actor } from './auth/provider.js';
import { canSend } from './config.js';
import {
    answerFeedback,
    answerQuestion,
    editFeedbackAnswer,
    listChats,
    rejectQuestion,
    sendChatMessage
} from './wb/api.js';

export type DraftKind = 'feedback' | 'feedback_edit' | 'question' | 'chat';
export type DraftStatus = 'pending' | 'sent' | 'discarded' | 'failed';

export interface Draft {
    id: string;
    kind: DraftKind;
    target_id: string;
    target_note: string | null;
    text: string;
    author: string;
    created_at: number;
    status: DraftStatus;
    sent_by: string | null;
    sent_at: number | null;
    error: string | null;
}

/** Ограничения длины из документации WB. */
const LIMITS: Record<DraftKind, { min: number; max: number; label: string }> = {
    feedback: { min: 2, max: 5000, label: 'ответ на отзыв' },
    feedback_edit: { min: 2, max: 5000, label: 'правка ответа на отзыв' },
    question: { min: 1, max: 5000, label: 'ответ на вопрос' },
    chat: { min: 1, max: 1000, label: 'сообщение в чат' }
};

export class DraftError extends Error {}

export function createDraft(input: {
    kind: DraftKind;
    targetId: string;
    targetNote?: string;
    text: string;
    author: string;
}): Draft {
    const limit = LIMITS[input.kind];
    const text = input.text.trim();
    if (text.length < limit.min || text.length > limit.max) {
        throw new DraftError(
            `Длина «${limit.label}» должна быть от ${limit.min} до ${limit.max} символов, сейчас ${text.length}.`
        );
    }

    const id = newId(9);
    const timestamp = now();
    db.prepare(
        `INSERT INTO drafts (id, kind, target_id, target_note, text, author, created_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`
    ).run(id, input.kind, input.targetId, input.targetNote ?? null, text, input.author, timestamp);

    audit({
        actor: input.author,
        action: `draft.create.${input.kind}`,
        target: input.targetId,
        detail: { draftId: id, length: text.length },
        outcome: 'ok'
    });

    return getDraft(id)!;
}

export function getDraft(id: string): Draft | undefined {
    return db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as Draft | undefined;
}

export function listDrafts(status?: DraftStatus, limit = 50): Draft[] {
    return status
        ? (db.prepare('SELECT * FROM drafts WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, limit) as Draft[])
        : (db.prepare('SELECT * FROM drafts ORDER BY created_at DESC LIMIT ?').all(limit) as Draft[]);
}

export function discardDraft(id: string, actor: Actor): Draft {
    const draft = getDraft(id);
    if (!draft) throw new DraftError(`Черновик ${id} не найден.`);
    if (draft.status !== 'pending') throw new DraftError(`Черновик ${id} уже в статусе «${draft.status}».`);

    db.prepare('UPDATE drafts SET status = ? WHERE id = ?').run('discarded', id);
    audit({ actor: actor.email, action: 'draft.discard', target: id, outcome: 'ok' });
    return getDraft(id)!;
}

/**
 * Единственное место, откуда что-либо уходит покупателю.
 * Требует роль responder/admin — reader сюда не проходит.
 */
export async function sendDraft(id: string, actor: Actor): Promise<Draft> {
    const draft = getDraft(id);
    if (!draft) throw new DraftError(`Черновик ${id} не найден.`);
    if (draft.status !== 'pending') {
        throw new DraftError(`Черновик ${id} уже в статусе «${draft.status}», повторная отправка невозможна.`);
    }
    if (!canSend(actor.role)) {
        audit({ actor: actor.email, action: 'draft.send', target: id, outcome: 'denied' });
        throw new DraftError(
            `У вас роль «${actor.role}»: читать данные можно, отправлять ответы клиентам — нет. Обратитесь к администратору.`
        );
    }

    try {
        switch (draft.kind) {
            case 'feedback':
                await answerFeedback(draft.target_id, draft.text);
                break;
            case 'feedback_edit':
                await editFeedbackAnswer(draft.target_id, draft.text);
                break;
            case 'question':
                await answerQuestion(draft.target_id, draft.text);
                break;
            case 'chat': {
                // replySign живёт на стороне WB и может обновиться — берём свежий.
                const chats = await listChats();
                const chat = chats.find(c => c.chatID === draft.target_id);
                if (!chat) throw new DraftError(`Чат ${draft.target_id} не найден в списке чатов продавца.`);
                await sendChatMessage(chat.replySign, draft.text);
                break;
            }
        }
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        db.prepare('UPDATE drafts SET status = ?, error = ? WHERE id = ?').run('failed', message, id);
        audit({ actor: actor.email, action: `draft.send.${draft.kind}`, target: id, detail: { message }, outcome: 'error' });
        throw e;
    }

    db.prepare('UPDATE drafts SET status = ?, sent_by = ?, sent_at = ? WHERE id = ?').run('sent', actor.email, now(), id);
    audit({
        actor: actor.email,
        action: `draft.send.${draft.kind}`,
        target: draft.target_id,
        detail: { draftId: id, author: draft.author, text: draft.text },
        outcome: 'ok'
    });

    return getDraft(id)!;
}

export function rejectQuestionDraftKind(): DraftKind {
    return 'question';
}

/** Отклонение вопроса — отдельный путь: ответ покупателю не публикуется. */
export async function sendQuestionRejection(questionId: string, reason: string, actor: Actor): Promise<void> {
    if (!canSend(actor.role)) {
        audit({ actor: actor.email, action: 'question.reject', target: questionId, outcome: 'denied' });
        throw new DraftError(`У вас роль «${actor.role}»: отклонять вопросы нельзя.`);
    }
    await rejectQuestion(questionId, reason);
    audit({ actor: actor.email, action: 'question.reject', target: questionId, detail: { reason }, outcome: 'ok' });
}

export function describeDraft(d: Draft): string {
    const kindLabel: Record<DraftKind, string> = {
        feedback: 'ответ на отзыв',
        feedback_edit: 'правка ответа на отзыв',
        question: 'ответ на вопрос',
        chat: 'сообщение в чат'
    };
    const lines = [
        `Черновик ${d.id} — ${kindLabel[d.kind]} для ${d.target_id}`,
        `   Статус: ${d.status}${d.error ? ` (${d.error})` : ''}`,
        `   Автор: ${d.author}${d.sent_by ? `, отправил: ${d.sent_by}` : ''}`
    ];
    if (d.target_note) lines.push(`   Контекст: ${d.target_note}`);
    lines.push(`   Текст (${d.text.length} симв.):`, ...d.text.split('\n').map(l => `   > ${l}`));
    return lines.join('\n');
}
