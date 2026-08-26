import { Router, urlencoded } from 'express';
import { db, now } from '../../db/index.js';
import { errorPage, invitePage } from '../pages.js';
import type { IdentityProvider } from './types.js';

interface InviteRow {
    code: string;
    email: string;
    used_at: number | null;
}

/**
 * Запасной вариант, когда внешнего IdP нет: администратор выдаёт сотруднику
 * одноразовый код (`npm run invite -- user@company.ru`), тот вводит его один раз.
 */
export const inviteIdentity: IdentityProvider = {
    name: 'invite',

    begin(pendingId, res) {
        res.status(200).send(invitePage(pendingId));
    },

    routes(complete) {
        const router = Router();

        router.post('/invite', urlencoded({ extended: false }), async (req, res) => {
            const body = req.body as Record<string, unknown>;
            const pendingId = typeof body.pendingId === 'string' ? body.pendingId : undefined;
            const code = typeof body.code === 'string' ? body.code.trim() : undefined;

            if (!pendingId) {
                res.status(400).send(errorPage('Сессия входа потеряна', 'Начните подключение коннектора заново.'));
                return;
            }
            if (!code) {
                res.status(400).send(invitePage(pendingId, 'Введите код.'));
                return;
            }

            const row = db.prepare('SELECT code, email, used_at FROM invites WHERE code = ?').get(code) as
                | InviteRow
                | undefined;

            if (!row) {
                res.status(400).send(invitePage(pendingId, 'Код не найден.'));
                return;
            }
            if (row.used_at !== null) {
                res.status(400).send(invitePage(pendingId, 'Этот код уже использован. Запросите новый.'));
                return;
            }

            db.prepare('UPDATE invites SET used_at = ? WHERE code = ?').run(now(), code);
            await complete(pendingId, { email: row.email }, res);
        });

        return router;
    }
};
