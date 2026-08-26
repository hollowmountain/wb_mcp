import { Router } from 'express';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { errorPage } from '../pages.js';
import type { IdentityProvider, VerifiedIdentity } from './types.js';

const AUTH_ENDPOINT = 'https://oauth.yandex.ru/authorize';
const TOKEN_ENDPOINT = 'https://oauth.yandex.ru/token';
const USERINFO_ENDPOINT = 'https://login.yandex.ru/info?format=json';

const redirectUri = new URL('/idp/yandex/callback', config.publicUrl).toString();

export const yandexIdentity: IdentityProvider = {
    name: 'yandex',

    begin(pendingId, res) {
        const url = new URL(AUTH_ENDPOINT);
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('client_id', config.yandex.clientId);
        url.searchParams.set('redirect_uri', redirectUri);
        url.searchParams.set('state', pendingId);
        url.searchParams.set('force_confirm', 'yes');
        res.redirect(url.toString());
    },

    routes(complete) {
        const router = Router();

        router.get('/yandex/callback', async (req, res) => {
            const code = typeof req.query.code === 'string' ? req.query.code : undefined;
            const pendingId = typeof req.query.state === 'string' ? req.query.state : undefined;

            if (typeof req.query.error === 'string') {
                res.status(400).send(errorPage('Вход отменён', `Яндекс вернул ошибку: ${req.query.error}`));
                return;
            }
            if (!code || !pendingId) {
                res.status(400).send(errorPage('Некорректный ответ Яндекса', 'В запросе нет code или state.'));
                return;
            }

            let identity: VerifiedIdentity;
            try {
                identity = await exchange(code);
            } catch (e) {
                logger.warn({ err: e }, 'yandex token exchange failed');
                res.status(502).send(errorPage('Не удалось подтвердить вход', 'Яндекс не подтвердил авторизацию.'));
                return;
            }

            await complete(pendingId, identity, res);
        });

        return router;
    }
};

async function exchange(code: string): Promise<VerifiedIdentity> {
    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: config.yandex.clientId,
        client_secret: config.yandex.clientSecret,
        redirect_uri: redirectUri
    });

    const tokenRes = await fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(15_000)
    });
    if (!tokenRes.ok) throw new Error(`Yandex token endpoint вернул ${tokenRes.status}`);

    const { access_token: accessToken } = (await tokenRes.json()) as { access_token?: string };
    if (!accessToken) throw new Error('В ответе Яндекса нет access_token');

    const infoRes = await fetch(USERINFO_ENDPOINT, {
        headers: { Authorization: `OAuth ${accessToken}` },
        signal: AbortSignal.timeout(15_000)
    });
    if (!infoRes.ok) throw new Error(`Yandex userinfo вернул ${infoRes.status}`);

    const info = (await infoRes.json()) as { default_email?: string; real_name?: string; display_name?: string };
    if (!info.default_email) throw new Error('В профиле Яндекса нет почты');

    return { email: info.default_email, name: info.real_name ?? info.display_name };
}
