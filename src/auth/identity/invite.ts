import { Router, urlencoded } from 'express';
import { db, now } from '../../db/index.js';
import { errorPage, invitePage } from '../pages.js';
import type { IdentityProvider } from './types.js';

interface InviteRow {
    code: string;
    email: string;
    cabinets: string | null;
    max_uses: number;
    used_count: number;
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

            const row = db
                .prepare('SELECT code, email, cabinets, max_uses, used_count, used_at FROM invites WHERE code = ?')
                .get(code) as InviteRow | undefined;

            if (!row) {
                res.status(400).send(invitePage(pendingId, 'Код не найден.'));
                return;
            }
            // max_uses = 0 — код без ограничения по числу входов.
            if (row.max_uses > 0 && row.used_count >= row.max_uses) {
                res.status(400).send(
                    invitePage(pendingId, `Код исчерпан: по нему уже вошли ${row.used_count} раз(а). Запросите новый.`)
                );
                return;
            }

            db.prepare('UPDATE invites SET used_at = ?, used_count = used_count + 1 WHERE code = ?').run(now(), code);

            const scope = (row.cabinets ?? '')
                .split(',')
                .map(s => s.trim())
                .filter(Boolean);
            await complete(pendingId, { email: row.email, ...(scope.length > 0 ? { cabinets: scope } : {}) }, res);
        });

        return router;
    }
};
