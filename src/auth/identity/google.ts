import { Router, type Response } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { errorPage } from '../pages.js';
import type { IdentityProvider, VerifiedIdentity } from './types.js';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const jwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

const redirectUri = new URL('/idp/google/callback', config.publicUrl).toString();

export const googleIdentity: IdentityProvider = {
    name: 'google',

    begin(pendingId, res) {
        const url = new URL(AUTH_ENDPOINT);
        url.searchParams.set('client_id', config.google.clientId);
        url.searchParams.set('redirect_uri', redirectUri);
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('scope', 'openid email profile');
        url.searchParams.set('state', pendingId);
        url.searchParams.set('prompt', 'select_account');
        // Подсказка Google, какой домен показывать первым. Проверку всё равно делаем сами.
        const firstDomain = config.access.domains[0];
        if (firstDomain) url.searchParams.set('hd', firstDomain);
        res.redirect(url.toString());
    },

    routes(complete) {
        const router = Router();

        router.get('/google/callback', async (req, res) => {
            const code = typeof req.query.code === 'string' ? req.query.code : undefined;
            const pendingId = typeof req.query.state === 'string' ? req.query.state : undefined;

            if (typeof req.query.error === 'string') {
                res.status(400).send(errorPage('Вход отменён', `Google вернул ошибку: ${req.query.error}`));
                return;
            }
            if (!code || !pendingId) {
                res.status(400).send(errorPage('Некорректный ответ Google', 'В запросе нет code или state.'));
                return;
            }

            let identity: VerifiedIdentity;
            try {
                identity = await exchange(code);
            } catch (e) {
                logger.warn({ err: e }, 'google token exchange failed');
                res.status(502).send(errorPage('Не удалось подтвердить вход', 'Google не подтвердил авторизацию. Попробуйте ещё раз.'));
                return;
            }

            await complete(pendingId, identity, res);
        });

        return router;
    }
};

async function exchange(code: string): Promise<VerifiedIdentity> {
    const body = new URLSearchParams({
        code,
        client_id: config.google.clientId,
        client_secret: config.google.clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
    });

    const res = await fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(15_000)
    });
    if (!res.ok) throw new Error(`Google token endpoint вернул ${res.status}`);

    const payload = (await res.json()) as { id_token?: string };
    if (!payload.id_token) throw new Error('В ответе Google нет id_token');

    const { payload: claims } = await jwtVerify(payload.id_token, jwks, {
        issuer: ISSUERS,
        audience: config.google.clientId
    });

    const email = typeof claims.email === 'string' ? claims.email : undefined;
    if (!email) throw new Error('В id_token нет email');
    if (claims.email_verified !== true) throw new Error('Google не подтвердил владение почтой');

    return { email, name: typeof claims.name === 'string' ? claims.name : undefined };
}
