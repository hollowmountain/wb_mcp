import { config } from '../../config.js';
import { CabinetError, type Cabinet } from '../../wb/cabinets.js';
import { getFeedback, getQuestion, listChats, type Chat, type Feedback, type Question } from '../../wb/api.js';

/**
 * Определяет кабинет по идентификатору обращения.
 *
 * Если кабинет указан явно — берём его. Если кабинет один — берём единственный.
 * Иначе ищем обращение во всех кабинетах: ID отзывов, вопросов и чатов
 * выдаёт сам Wildberries, и в чужом кабинете такого ID не будет.
 *
 * Так инструмент не падает, когда модель не передала cabinet, но и не угадывает:
 * если ID нашёлся в нескольких кабинетах, честно требуем уточнить.
 */
async function locate<T>(
    slug: string | undefined,
    id: string,
    what: string,
    fetch: (cabinet: Cabinet) => Promise<T>
): Promise<{ cabinet: Cabinet; item: T }> {
    if (slug !== undefined && slug !== '') {
        const cabinet = config.cabinets.resolve(slug);
        return { cabinet, item: await fetch(cabinet) };
    }
    if (config.cabinets.size === 1) {
        const cabinet = config.cabinets.resolve();
        return { cabinet, item: await fetch(cabinet) };
    }

    type Hit = { cabinet: Cabinet; item: T };
    const probes = await Promise.all(
        config.cabinets.all().map(async (cabinet): Promise<Hit | null> => {
            try {
                const item = await fetch(cabinet);
                return item === undefined || item === null ? null : { cabinet, item };
            } catch {
                // В этом кабинете такого обращения нет — это ожидаемо, не ошибка.
                return null;
            }
        })
    );

    const found: Hit[] = [];
    for (const probe of probes) {
        if (probe !== null) found.push(probe);
    }

    if (found.length === 1) return found[0]!;
    if (found.length === 0) {
        throw new CabinetError(
            `${what} ${id} не найден ни в одном из кабинетов: ${config.cabinets.describeChoices()}. Проверьте идентификатор.`
        );
    }
    throw new CabinetError(
        `${what} ${id} нашёлся сразу в нескольких кабинетах (${found.map(f => f.cabinet.slug).join(', ')}). Укажите параметр cabinet явно.`
    );
}

export const locateFeedback = (slug: string | undefined, id: string): Promise<{ cabinet: Cabinet; item: Feedback }> =>
    locate(slug, id, 'Отзыв', cabinet => getFeedback(cabinet, id));

export const locateQuestion = (slug: string | undefined, id: string): Promise<{ cabinet: Cabinet; item: Question }> =>
    locate(slug, id, 'Вопрос', cabinet => getQuestion(cabinet, id));

export const locateChat = (slug: string | undefined, id: string): Promise<{ cabinet: Cabinet; item: Chat }> =>
    locate(slug, id, 'Чат', async cabinet => {
        const chat = (await listChats(cabinet)).find(c => c.chatID === id);
        if (!chat) throw new Error('нет такого чата');
        return chat;
    });
