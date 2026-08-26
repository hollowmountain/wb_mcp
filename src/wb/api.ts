import { wbChat, wbChatFile, wbFeedbacks } from './client.js';

// ─── Общие типы ──────────────────────────────────────────────────────────────

export interface ProductDetails {
    imtId: number;
    nmId: number;
    productName: string;
    supplierArticle: string;
    supplierName: string;
    brandName: string;
    size?: string;
}

export interface AnswerBlock {
    text: string;
    state?: string;
    editable?: boolean;
    createDate?: string;
}

export interface PhotoLink {
    fullSize: string;
    miniSize: string;
}

// ─── Отзывы ──────────────────────────────────────────────────────────────────

export interface Feedback {
    id: string;
    text: string;
    pros: string;
    cons: string;
    productValuation: number;
    createdDate: string;
    answer: AnswerBlock | null;
    state: string;
    productDetails: ProductDetails;
    video: { previewImage: string; link: string; durationSec: number } | null;
    wasViewed: boolean;
    photoLinks: PhotoLink[] | null;
    userName: string;
    orderStatus: string;
    matchingSize: string;
    isAbleSupplierFeedbackValuation: boolean;
    supplierFeedbackValuation: number;
    isAbleSupplierProductValuation: boolean;
    supplierProductValuation: number;
    isAbleReturnProductOrders: boolean;
    returnProductOrdersDate: string | null;
    bables: string[] | null;
    lastOrderShkId: number;
    lastOrderCreatedAt: string;
    color: string;
    subjectId: number;
    subjectName: string;
    parentFeedbackId: string | null;
    childFeedbackId: string | null;
}

export interface FeedbackListParams {
    isAnswered: boolean;
    take: number;
    skip: number;
    nmId?: number;
    order?: 'dateAsc' | 'dateDesc';
    dateFrom?: number;
    dateTo?: number;
}

export const listFeedbacks = (p: FeedbackListParams) =>
    wbFeedbacks<{ countUnanswered: number; countArchive: number; feedbacks: Feedback[] }>({
        path: '/api/v1/feedbacks',
        query: { ...p }
    });

export const listArchivedFeedbacks = (p: { take: number; skip: number; nmId?: number; order?: 'dateAsc' | 'dateDesc' }) =>
    wbFeedbacks<{ feedbacks: Feedback[] }>({ path: '/api/v1/feedbacks/archive', query: { ...p } });

export const getFeedback = (id: string) => wbFeedbacks<Feedback>({ path: '/api/v1/feedback', query: { id } });

export const countUnansweredFeedbacks = () =>
    wbFeedbacks<{ countUnanswered: number; countUnansweredToday: number }>({
        path: '/api/v1/feedbacks/count-unanswered'
    });

export const countFeedbacks = (p: { isAnswered: boolean; dateFrom?: number; dateTo?: number }) =>
    wbFeedbacks<number>({ path: '/api/v1/feedbacks/count', query: { ...p } });

/** POST /api/v1/feedbacks/answer — ответ уходит на модерацию и затем публикуется. */
export const answerFeedback = (id: string, text: string) =>
    wbFeedbacks<void>({ path: '/api/v1/feedbacks/answer', method: 'POST', json: { id, text } });

/** PATCH /api/v1/feedbacks/answer — правка возможна один раз в течение 60 дней. */
export const editFeedbackAnswer = (id: string, text: string) =>
    wbFeedbacks<void>({ path: '/api/v1/feedbacks/answer', method: 'PATCH', json: { id, text } });

// ─── Вопросы ─────────────────────────────────────────────────────────────────

export interface Question {
    id: string;
    text: string;
    createdDate: string;
    state: string;
    answer: AnswerBlock | null;
    productDetails: ProductDetails;
    wasViewed: boolean;
    isWarned: boolean;
}

export interface QuestionListParams {
    isAnswered: boolean;
    take: number;
    skip: number;
    nmId?: number;
    order?: 'dateAsc' | 'dateDesc';
    dateFrom?: number;
    dateTo?: number;
}

export const listQuestions = (p: QuestionListParams) =>
    wbFeedbacks<{ countUnanswered: number; countArchive: number; questions: Question[] }>({
        path: '/api/v1/questions',
        query: { ...p }
    });

export const getQuestion = (id: string) => wbFeedbacks<Question>({ path: '/api/v1/question', query: { id } });

export const countUnansweredQuestions = () =>
    wbFeedbacks<{ countUnanswered: number; countUnansweredToday: number }>({
        path: '/api/v1/questions/count-unanswered'
    });

export const countQuestions = (p: { isAnswered: boolean; dateFrom?: number; dateTo?: number }) =>
    wbFeedbacks<number>({ path: '/api/v1/questions/count', query: { ...p } });

export const hasNewFeedbacksOrQuestions = () =>
    wbFeedbacks<{ hasNewQuestions: boolean; hasNewFeedbacks: boolean }>({ path: '/api/v1/new-feedbacks-questions' });

/** state=wbRu — опубликовать ответ; правка ответа возможна один раз за 60 дней. */
export const answerQuestion = (id: string, text: string) =>
    wbFeedbacks<null>({ path: '/api/v1/questions', method: 'PATCH', json: { id, answer: { text }, state: 'wbRu' } });

/** state=none — отклонить вопрос, покупатель ответа не увидит. */
export const rejectQuestion = (id: string, text: string) =>
    wbFeedbacks<null>({ path: '/api/v1/questions', method: 'PATCH', json: { id, answer: { text }, state: 'none' } });

export const markQuestionViewed = (id: string) =>
    wbFeedbacks<null>({ path: '/api/v1/questions', method: 'PATCH', json: { id, wasViewed: true } });

// ─── Чат с покупателями ──────────────────────────────────────────────────────

export interface GoodCard {
    nmID: number;
    price: number;
    priceCurrency: string;
    rid: string;
    size: string;
}

export interface Chat {
    chatID: string;
    /** Подпись чата — без неё нельзя отправить сообщение. */
    replySign: string;
    clientName: string;
    goodCard: GoodCard | null;
    lastMessage: { text: string; addTimestamp: number } | null;
}

export interface ChatFile {
    contentType: string;
    date: string;
    downloadID: string;
    name: string;
    url: string;
    size: number;
}

export interface ChatEvent {
    chatID: string;
    eventID: string;
    eventType: string;
    isNewChat?: boolean;
    message?: {
        text?: string;
        attachments?: {
            goodCard?: GoodCard;
            files?: ChatFile[];
            images?: Array<{ date: string; downloadID: string; url: string }>;
        };
    };
    source?: string;
    addTimestamp: number;
    addTime: string;
    replySign?: string;
    sender: 'client' | 'seller' | string;
    clientName?: string;
}

export const listChats = () => wbChat<Chat[]>({ path: '/api/v1/seller/chats' });

/**
 * Лента событий всех чатов. Пагинация — курсором `next` (Unix-время в мс).
 * Повторять с полученным next, пока totalEvents не станет 0.
 */
export const listChatEvents = (next?: number) =>
    wbChat<{
        next: number;
        newestEventTime: string;
        oldestEventTime: string;
        totalEvents: number;
        events: ChatEvent[];
    }>({ path: '/api/v1/seller/events', query: { next } });

/** Отправка сообщения покупателю. Обязателен replySign, текст до 1000 символов. */
export async function sendChatMessage(
    replySign: string,
    message: string
): Promise<{ addTime: number; chatID: string }> {
    const form = new FormData();
    form.set('replySign', replySign);
    form.set('message', message);
    return wbChat<{ addTime: number; chatID: string }>({
        path: '/api/v1/seller/message',
        method: 'POST',
        form
    });
}

export const downloadChatFile = (downloadId: string) => wbChatFile(`/api/v1/seller/download/${downloadId}`);
