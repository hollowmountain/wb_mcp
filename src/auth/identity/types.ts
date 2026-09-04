import type { Response, Router } from 'express';

export interface VerifiedIdentity {
    email: string;
    name?: string;
    /**
     * Кабинеты, которые открывает этот вход. undefined — все доступные.
     * Заполняет провайдер, который знает область видимости: например,
     * одноразовый код может быть выдан на один конкретный кабинет.
     */
    cabinets?: string[];
    /** Области доступа. Пусто — набор по умолчанию. */
    areas?: string[];
}

/**
 * Источник личности сотрудника. Claude личность не передаёт
 * (см. anthropics/claude-code#44980), поэтому её устанавливает наш сервер.
 */
export interface IdentityProvider {
    readonly name: string;

    /**
     * Отправить пользователя логиниться. pendingId связывает возврат
     * с исходным запросом /authorize от Claude.
     */
    begin(pendingId: string, res: Response): Promise<void> | void;

    /** Маршруты возврата от IdP. Монтируются под /idp. */
    routes(complete: (pendingId: string, identity: VerifiedIdentity, res: Response) => Promise<void>): Router;
}
