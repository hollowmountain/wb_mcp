import type { Actor } from './auth/provider.js';
import { config } from './config.js';
import { CabinetError, type Cabinet } from './wb/cabinets.js';

/**
 * Кабинеты, открытые конкретному сотруднику.
 *
 * Область видимости задаётся при выдаче доступа: одноразовый код можно выпустить
 * на один кабинет, и тогда человек больше ничего не увидит. Пустая область
 * (NULL в базе) означает доступ ко всем кабинетам.
 */
export function allowedCabinets(actor: Actor): Cabinet[] {
    const all = config.cabinets.all();
    if (actor.cabinets === null) return all;

    const scope = new Set(actor.cabinets);
    const allowed = all.filter(c => scope.has(c.slug));

    if (allowed.length === 0) {
        throw new CabinetError(
            `Вашей учётной записи (${actor.email}) не открыт ни один из настроенных кабинетов. Обратитесь к администратору.`
        );
    }
    return allowed;
}

export function describeAllowed(actor: Actor): string {
    return allowedCabinets(actor)
        .map(c => `${c.slug} (${c.label})`)
        .join(', ');
}

/** Один кабинет по slug — с проверкой, что он открыт этому сотруднику. */
export function resolveCabinet(actor: Actor, slug?: string): Cabinet {
    const allowed = allowedCabinets(actor);

    if (slug === undefined || slug === '') {
        if (allowed.length === 1) return allowed[0]!;
        throw new CabinetError(`Укажите параметр cabinet. Вам доступны: ${describeAllowed(actor)}`);
    }

    const wanted = slug.trim().toLowerCase();
    const cabinet = allowed.find(c => c.slug === wanted);
    if (!cabinet) {
        // Не подсказываем, существует ли кабинет вообще: чужие кабинеты
        // для этого сотрудника попросту не существуют.
        throw new CabinetError(`Кабинет «${slug}» вам не доступен. Доступны: ${describeAllowed(actor)}`);
    }
    return cabinet;
}

/** Набор кабинетов для операции, которая может идти по всем сразу. */
export function resolveCabinets(actor: Actor, slug?: string): Cabinet[] {
    if (slug === undefined || slug === '') return allowedCabinets(actor);
    return [resolveCabinet(actor, slug)];
}

export function canUseCabinet(actor: Actor, slug: string): boolean {
    return actor.cabinets === null || actor.cabinets.includes(slug);
}

/**
 * Есть ли у человека хоть один кабинет Wildberries.
 *
 * Нужна, чтобы не показывать инструменты WB тому, у кого только Ozon: иначе
 * он видит два десятка кнопок, каждая из которых отвечает «кабинет вам не
 * открыт». Симметрично тому, как устроен доступ к Ozon.
 */
export function hasAnyCabinet(actor: Actor): boolean {
    if (actor.cabinets === null) return config.cabinets.size > 0;
    const scope = new Set(actor.cabinets);
    return config.cabinets.all().some(c => scope.has(c.slug));
}
