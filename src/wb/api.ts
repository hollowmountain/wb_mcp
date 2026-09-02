import type { Cabinet } from './cabinets.js';
import { wbChat, wbChatFile, wbCommon, wbDataJson, wbFeedbacks, wbJson } from './client.js';

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

// ─── Продавец ────────────────────────────────────────────────────────────────

export interface SellerInfo {
    /** Юридическое лицо: ООО «…», ИП … */
    name: string;
    sid: string;
    tin: string;
    /** Торговая марка, под которой покупатели видят магазин. */
    tradeMark: string;
}

export const getSellerInfo = (cabinet: Cabinet) => wbCommon<SellerInfo>(cabinet, '/api/v1/seller-info');

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

export const listFeedbacks = (cabinet: Cabinet, p: FeedbackListParams) =>
    wbFeedbacks<{ countUnanswered: number; countArchive: number; feedbacks: Feedback[] }>(cabinet, {
        path: '/api/v1/feedbacks',
        query: { ...p }
    });

export const listArchivedFeedbacks = (
    cabinet: Cabinet,
    p: { take: number; skip: number; nmId?: number; order?: 'dateAsc' | 'dateDesc' }
) => wbFeedbacks<{ feedbacks: Feedback[] }>(cabinet, { path: '/api/v1/feedbacks/archive', query: { ...p } });

export const getFeedback = (cabinet: Cabinet, id: string) =>
    wbFeedbacks<Feedback>(cabinet, { path: '/api/v1/feedback', query: { id } });

export const countUnansweredFeedbacks = (cabinet: Cabinet) =>
    wbFeedbacks<{ countUnanswered: number; countUnansweredToday: number }>(cabinet, {
        path: '/api/v1/feedbacks/count-unanswered'
    });

export const countFeedbacks = (cabinet: Cabinet, p: { isAnswered: boolean; dateFrom?: number; dateTo?: number }) =>
    wbFeedbacks<number>(cabinet, { path: '/api/v1/feedbacks/count', query: { ...p } });

/** POST /api/v1/feedbacks/answer — ответ уходит на модерацию и затем публикуется. */
export const answerFeedback = (cabinet: Cabinet, id: string, text: string) =>
    wbFeedbacks<void>(cabinet, { path: '/api/v1/feedbacks/answer', method: 'POST', json: { id, text } });

/** PATCH /api/v1/feedbacks/answer — правка возможна один раз в течение 60 дней. */
export const editFeedbackAnswer = (cabinet: Cabinet, id: string, text: string) =>
    wbFeedbacks<void>(cabinet, { path: '/api/v1/feedbacks/answer', method: 'PATCH', json: { id, text } });

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

export const listQuestions = (cabinet: Cabinet, p: QuestionListParams) =>
    wbFeedbacks<{ countUnanswered: number; countArchive: number; questions: Question[] }>(cabinet, {
        path: '/api/v1/questions',
        query: { ...p }
    });

export const getQuestion = (cabinet: Cabinet, id: string) =>
    wbFeedbacks<Question>(cabinet, { path: '/api/v1/question', query: { id } });

export const countUnansweredQuestions = (cabinet: Cabinet) =>
    wbFeedbacks<{ countUnanswered: number; countUnansweredToday: number }>(cabinet, {
        path: '/api/v1/questions/count-unanswered'
    });

export const countQuestions = (cabinet: Cabinet, p: { isAnswered: boolean; dateFrom?: number; dateTo?: number }) =>
    wbFeedbacks<number>(cabinet, { path: '/api/v1/questions/count', query: { ...p } });

export const hasNewFeedbacksOrQuestions = (cabinet: Cabinet) =>
    wbFeedbacks<{ hasNewQuestions: boolean; hasNewFeedbacks: boolean }>(cabinet, {
        path: '/api/v1/new-feedbacks-questions'
    });

/** state=wbRu — опубликовать ответ; правка ответа возможна один раз за 60 дней. */
export const answerQuestion = (cabinet: Cabinet, id: string, text: string) =>
    wbFeedbacks<null>(cabinet, {
        path: '/api/v1/questions',
        method: 'PATCH',
        json: { id, answer: { text }, state: 'wbRu' }
    });

/** state=none — отклонить вопрос, покупатель ответа не увидит. */
export const rejectQuestion = (cabinet: Cabinet, id: string, text: string) =>
    wbFeedbacks<null>(cabinet, {
        path: '/api/v1/questions',
        method: 'PATCH',
        json: { id, answer: { text }, state: 'none' }
    });

export const markQuestionViewed = (cabinet: Cabinet, id: string) =>
    wbFeedbacks<null>(cabinet, { path: '/api/v1/questions', method: 'PATCH', json: { id, wasViewed: true } });

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

export const listChats = (cabinet: Cabinet) => wbChat<Chat[]>(cabinet, { path: '/api/v1/seller/chats' });

/**
 * Лента событий всех чатов. Пагинация — курсором `next` (Unix-время в мс).
 * Повторять с полученным next, пока totalEvents не станет 0.
 */
export const listChatEvents = (cabinet: Cabinet, next?: number) =>
    wbChat<{
        next: number;
        newestEventTime: string;
        oldestEventTime: string;
        totalEvents: number;
        events: ChatEvent[];
    }>(cabinet, { path: '/api/v1/seller/events', query: { next } });

/** Отправка сообщения покупателю. Обязателен replySign, текст до 1000 символов. */
export async function sendChatMessage(
    cabinet: Cabinet,
    replySign: string,
    message: string
): Promise<{ addTime: number; chatID: string }> {
    const form = new FormData();
    form.set('replySign', replySign);
    form.set('message', message);
    return wbChat<{ addTime: number; chatID: string }>(cabinet, {
        path: '/api/v1/seller/message',
        method: 'POST',
        form
    });
}

export const downloadChatFile = (cabinet: Cabinet, downloadId: string) =>
    wbChatFile(cabinet, `/api/v1/seller/download/${downloadId}`);

// ─── Карточка товара ─────────────────────────────────────────────────────────
//
// Прямого поиска карточки по nmID у WB нет: textSearch ищет только по артикулу,
// а /content/v2/cards/filter отвечает 404 (проверено 02.09.2026). Поэтому путь
// в две ступени: nmID → цены отдают артикул → артикул находит карточку.

export interface CardSize {
    chrtID: number;
    techSize: string;
    wbSize: string;
    skus: string[];
}

export interface CardCharacteristic {
    id: number;
    name: string;
    /** WB кладёт сюда и массив строк, и число, и строку — единого типа нет. */
    value: unknown;
}

export interface ProductCard {
    nmID: number;
    imtID: number;
    subjectID: number;
    subjectName: string;
    vendorCode: string;
    brand: string;
    title: string;
    description: string;
    photos: Array<{ big: string }> | null;
    dimensions: { width: number; height: number; length: number; weightBrutto: number } | null;
    characteristics: CardCharacteristic[] | null;
    sizes: CardSize[] | null;
    createdAt: string;
    updatedAt: string;
}

interface CardsListResponse {
    cards: ProductCard[];
    cursor: { updatedAt: string; nmID: number; total: number };
}

/** Поиск карточек по артикулу или части названия. */
export async function searchCards(cabinet: Cabinet, textSearch: string, limit = 10): Promise<ProductCard[]> {
    const res = await wbJson<CardsListResponse>(cabinet, 'content', {
        path: '/content/v2/get/cards/list',
        method: 'POST',
        json: { settings: { cursor: { limit }, filter: { withPhoto: -1, textSearch } } }
    });
    return res?.cards ?? [];
}

// ─── Цены ────────────────────────────────────────────────────────────────────

export interface GoodSize {
    sizeID: number;
    price: number;
    discountedPrice: number;
    clubDiscountedPrice: number;
    techSizeName: string;
}

export interface Good {
    nmID: number;
    vendorCode: string;
    sizes: GoodSize[];
    currencyIsoCode4217: string;
    discount: number;
    clubDiscount: number;
    editableSizePrice: boolean;
}

/** Цены и артикул по номенклатуре. Единственный проверенный способ узнать артикул по nmID. */
export async function getGoodByNmId(cabinet: Cabinet, nmId: number): Promise<Good | null> {
    const res = await wbDataJson<{ listGoods: Good[] }>(cabinet, 'prices', {
        path: '/api/v2/list/goods/filter',
        query: { limit: 10, offset: 0, filterNmID: nmId }
    });
    // Только точное совпадение: фильтр WB может вернуть соседние позиции,
    // а показать покупателю чужой товар хуже, чем не найти ничего.
    return res?.listGoods?.find(g => g.nmID === nmId) ?? null;
}

/** Карточка по номенклатуре: сначала артикул через цены, затем сама карточка. */
export async function getCardByNmId(cabinet: Cabinet, nmId: number): Promise<ProductCard | null> {
    const good = await getGoodByNmId(cabinet, nmId);
    if (!good?.vendorCode) return null;
    const cards = await searchCards(cabinet, good.vendorCode, 10);
    return cards.find(c => c.nmID === nmId) ?? null;
}

// ─── Заявки на возврат ───────────────────────────────────────────────────────

export interface ReturnClaim {
    id: string;
    claim_type: number;
    status: number;
    status_ex: number;
    nm_id: number;
    user_comment: string;
    wb_comment: string | null;
    dt: string;
    imt_name: string;
    order_dt: string;
    dt_update: string;
    photos: string[] | null;
    video_paths: string[] | null;
    actions: string[] | null;
    price: number;
    currency_code: string;
    srid: string;
    delivery_dt: string | null;
}

export interface ClaimsPage {
    claims: ReturnClaim[];
    total: number;
}

export async function listClaims(
    cabinet: Cabinet,
    params: { archive?: boolean; limit?: number; offset?: number } = {}
): Promise<ClaimsPage> {
    const res = await wbJson<ClaimsPage>(cabinet, 'returns', {
        path: '/api/v1/claims',
        query: {
            is_archive: params.archive ?? false,
            limit: Math.min(params.limit ?? 20, 200),
            offset: params.offset ?? 0
        }
    });
    return { claims: res?.claims ?? [], total: res?.total ?? 0 };
}
