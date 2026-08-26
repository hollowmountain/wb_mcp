import type { Response } from 'express';
import { InvalidGrantError, InvalidTokenError, ServerError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
    OAuthClientInformationFull,
    OAuthTokenRevocationRequest,
    OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js';

import { canSend, config, isAllowedEmail, roleForEmail, type Role } from '../config.js';
import { audit } from '../audit.js';
import { db, hashToken, newId, now } from '../db/index.js';
import { logger } from '../logger.js';
import { identity } from './identity/index.js';
import type { VerifiedIdentity } from './identity/types.js';
import { deniedPage, errorPage } from './pages.js';

export const SCOPE_READ = 'wb:read';
export const SCOPE_WRITE = 'wb:write';
export const SUPPORTED_SCOPES = [SCOPE_READ, SCOPE_WRITE];

const AUTH_CODE_TTL_SECONDS = 300;

// ─── Хранилище клиентов (Dynamic Client Registration) ────────────────────────

interface ClientRow {
    client_id: string;
    client_secret: string | null;
    client_id_issued_at: number;
    client_secret_expires_at: number | null;
    metadata: string;
}

function rowToClient(row: ClientRow): OAuthClientInformationFull {
    const metadata = JSON.parse(row.metadata) as Omit<OAuthClientInformationFull, 'client_id'>;
    return {
        ...metadata,
        client_id: row.client_id,
        client_id_issued_at: row.client_id_issued_at,
        ...(row.client_secret ? { client_secret: row.client_secret } : {}),
        ...(row.client_secret_expires_at ? { client_secret_expires_at: row.client_secret_expires_at } : {})
    } as OAuthClientInformationFull;
}

const clientsStore: OAuthRegisteredClientsStore = {
    getClient(clientId) {
        const row = db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(clientId) as ClientRow | undefined;
        return row ? rowToClient(row) : undefined;
    },

    registerClient(client) {
        const clientId = newId(16);
        const issuedAt = now();
        // Claude регистрируется как публичный клиент с PKCE; секрет выдаём только
        // тем, кто явно просит метод аутентификации, отличный от none.
        const wantsSecret = client.token_endpoint_auth_method && client.token_endpoint_auth_method !== 'none';
        const clientSecret = wantsSecret ? newId(32) : null;

        const full = {
            ...client,
            client_id: clientId,
            client_id_issued_at: issuedAt,
            ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {})
        } as OAuthClientInformationFull;

        const { client_id: _id, client_secret: _secret, client_id_issued_at: _issued, ...metadata } = full as Record<
            string,
            unknown
        > & OAuthClientInformationFull;

        db.prepare(
            `INSERT INTO oauth_clients (client_id, client_secret, client_id_issued_at, client_secret_expires_at, metadata)
             VALUES (?, ?, ?, ?, ?)`
        ).run(clientId, clientSecret, issuedAt, clientSecret ? 0 : null, JSON.stringify(metadata));

        logger.info({ clientId, name: client.client_name }, 'registered oauth client');
        return full;
    }
};

// ─── Строки БД ───────────────────────────────────────────────────────────────

interface PendingRow {
    id: string;
    client_id: string;
    redirect_uri: string;
    client_state: string | null;
    code_challenge: string;
    scopes: string;
    resource: string | null;
    created_at: number;
}

interface CodeRow {
    code: string;
    client_id: string;
    user_email: string;
    redirect_uri: string;
    code_challenge: string;
    scopes: string;
    resource: string | null;
    expires_at: number;
}

interface TokenRow {
    token_hash: string;
    kind: 'access' | 'refresh';
    client_id: string;
    user_email: string;
    scopes: string;
    resource: string | null;
    expires_at: number;
    revoked: number;
}

// ─── Выдача токенов ──────────────────────────────────────────────────────────

/** Сотрудник-reader не получает wb:write, даже если Claude его запросил. */
function grantedScopes(email: string, requested: string[]): string[] {
    const role = roleForEmail(email);
    const wanted = requested.length > 0 ? requested : SUPPORTED_SCOPES;
    return wanted.filter(s => (s === SCOPE_WRITE ? canSend(role) : SUPPORTED_SCOPES.includes(s)));
}

function issueTokens(params: {
    clientId: string;
    email: string;
    scopes: string[];
    resource: string | null;
}): OAuthTokens {
    const accessToken = newId(32);
    const refreshToken = newId(32);
    const issuedAt = now();

    const insert = db.prepare(
        `INSERT INTO tokens (token_hash, kind, client_id, user_email, scopes, resource, expires_at, revoked, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
    );
    const scopeString = params.scopes.join(' ');

    db.transaction(() => {
        insert.run(
            hashToken(accessToken),
            'access',
            params.clientId,
            params.email,
            scopeString,
            params.resource,
            issuedAt + config.accessTokenTtl,
            issuedAt
        );
        insert.run(
            hashToken(refreshToken),
            'refresh',
            params.clientId,
            params.email,
            scopeString,
            params.resource,
            issuedAt + config.refreshTokenTtl,
            issuedAt
        );
    })();

    return {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: config.accessTokenTtl,
        scope: scopeString,
        refresh_token: refreshToken
    };
}

// ─── Провайдер ───────────────────────────────────────────────────────────────

export const wbOAuthProvider: OAuthServerProvider = {
    get clientsStore() {
        return clientsStore;
    },

    async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
        const pendingId = newId(24);
        db.prepare(
            `INSERT INTO pending_auth (id, client_id, redirect_uri, client_state, code_challenge, scopes, resource, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
            pendingId,
            client.client_id,
            params.redirectUri,
            params.state ?? null,
            params.codeChallenge,
            (params.scopes ?? SUPPORTED_SCOPES).join(' '),
            params.resource?.href ?? null,
            now()
        );

        await identity.begin(pendingId, res);
    },

    async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
        const row = db.prepare('SELECT * FROM auth_codes WHERE code = ?').get(authorizationCode) as CodeRow | undefined;
        if (!row || row.client_id !== client.client_id) {
            throw new InvalidGrantError('Код авторизации не найден или выдан другому клиенту');
        }
        return row.code_challenge;
    },

    async exchangeAuthorizationCode(
        client: OAuthClientInformationFull,
        authorizationCode: string,
        _codeVerifier?: string,
        redirectUri?: string,
        resource?: URL
    ): Promise<OAuthTokens> {
        const row = db.prepare('SELECT * FROM auth_codes WHERE code = ?').get(authorizationCode) as CodeRow | undefined;
        if (!row || row.client_id !== client.client_id) {
            throw new InvalidGrantError('Код авторизации недействителен');
        }
        db.prepare('DELETE FROM auth_codes WHERE code = ?').run(authorizationCode);

        if (row.expires_at < now()) throw new InvalidGrantError('Код авторизации истёк');
        if (redirectUri !== undefined && redirectUri !== row.redirect_uri) {
            throw new InvalidGrantError('redirect_uri не совпадает с использованным при авторизации');
        }
        if (resource !== undefined && row.resource !== null && resource.href !== row.resource) {
            throw new InvalidGrantError('Параметр resource не совпадает с запрошенным при авторизации');
        }
        if (!isAllowedEmail(row.user_email)) {
            throw new InvalidGrantError('Доступ для этой учётной записи отозван');
        }

        const scopes = grantedScopes(row.user_email, row.scopes.split(' ').filter(Boolean));
        audit({ actor: row.user_email, action: 'oauth.token.issued', detail: { scopes }, outcome: 'ok' });

        return issueTokens({
            clientId: client.client_id,
            email: row.user_email,
            scopes,
            resource: row.resource
        });
    },

    async exchangeRefreshToken(
        client: OAuthClientInformationFull,
        refreshToken: string,
        scopes?: string[],
        resource?: URL
    ): Promise<OAuthTokens> {
        const hash = hashToken(refreshToken);
        const row = db.prepare('SELECT * FROM tokens WHERE token_hash = ? AND kind = ?').get(hash, 'refresh') as
            | TokenRow
            | undefined;

        if (!row || row.revoked === 1 || row.expires_at < now() || row.client_id !== client.client_id) {
            throw new InvalidGrantError('Refresh-токен недействителен');
        }
        if (!isAllowedEmail(row.user_email)) {
            db.prepare('UPDATE tokens SET revoked = 1 WHERE user_email = ?').run(row.user_email);
            throw new InvalidGrantError('Доступ для этой учётной записи отозван');
        }
        if (resource !== undefined && row.resource !== null && resource.href !== row.resource) {
            throw new InvalidGrantError('Параметр resource не совпадает с исходным');
        }

        // Ротация: старый refresh-токен больше не действует (OAuth 2.1 для публичных клиентов).
        db.prepare('UPDATE tokens SET revoked = 1 WHERE token_hash = ?').run(hash);

        const requested = scopes && scopes.length > 0 ? scopes : row.scopes.split(' ').filter(Boolean);
        const granted = grantedScopes(row.user_email, requested).filter(s => row.scopes.split(' ').includes(s));

        return issueTokens({
            clientId: client.client_id,
            email: row.user_email,
            scopes: granted,
            resource: row.resource
        });
    },

    async verifyAccessToken(token: string): Promise<AuthInfo> {
        const row = db.prepare('SELECT * FROM tokens WHERE token_hash = ? AND kind = ?').get(hashToken(token), 'access') as
            | TokenRow
            | undefined;

        if (!row) throw new InvalidTokenError('Токен неизвестен');
        if (row.revoked === 1) throw new InvalidTokenError('Токен отозван');
        if (row.expires_at < now()) throw new InvalidTokenError('Срок действия токена истёк');
        if (!isAllowedEmail(row.user_email)) throw new InvalidTokenError('Доступ для этой учётной записи отозван');

        db.prepare('UPDATE users SET last_seen = ? WHERE email = ?').run(now(), row.user_email);

        return {
            token,
            clientId: row.client_id,
            scopes: row.scopes.split(' ').filter(Boolean),
            expiresAt: row.expires_at,
            ...(row.resource ? { resource: new URL(row.resource) } : {}),
            extra: { email: row.user_email, role: roleForEmail(row.user_email) satisfies Role }
        };
    },

    async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
        db.prepare('UPDATE tokens SET revoked = 1 WHERE token_hash = ? AND client_id = ?').run(
            hashToken(request.token),
            client.client_id
        );
    }
};

// ─── Возврат из IdP ──────────────────────────────────────────────────────────

/**
 * Вызывается провайдером личности после того, как сотрудник подтвердил, кто он.
 * Здесь решается, пускать ли его, и здесь же создаётся код авторизации для Claude.
 */
export async function completeAuthorization(
    pendingId: string,
    verified: VerifiedIdentity,
    res: Response
): Promise<void> {
    const pending = db.prepare('SELECT * FROM pending_auth WHERE id = ?').get(pendingId) as PendingRow | undefined;
    if (!pending) {
        res.status(400).send(errorPage('Сессия входа истекла', 'Начните подключение коннектора в Claude заново.'));
        return;
    }
    db.prepare('DELETE FROM pending_auth WHERE id = ?').run(pendingId);

    if (pending.created_at < now() - 900) {
        res.status(400).send(errorPage('Сессия входа истекла', 'С момента начала входа прошло больше 15 минут.'));
        return;
    }

    const email = verified.email.toLowerCase();
    if (!isAllowedEmail(email)) {
        audit({ actor: email, action: 'oauth.login', outcome: 'denied' });
        res.status(403).send(deniedPage(email));
        return;
    }

    const timestamp = now();
    // Область видимости приходит из способа входа (например, из одноразового кода)
    // и перезаписывает прежнюю: выдали новый код на один кабинет — доступ сузился.
    const scope = verified.cabinets && verified.cabinets.length > 0 ? verified.cabinets.join(',') : null;
    db.prepare(
        `INSERT INTO users (email, name, cabinets, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET last_seen = excluded.last_seen,
                                          name = COALESCE(excluded.name, users.name),
                                          cabinets = excluded.cabinets`
    ).run(email, verified.name ?? null, scope, timestamp, timestamp);

    const code = newId(32);
    db.prepare(
        `INSERT INTO auth_codes (code, client_id, user_email, redirect_uri, code_challenge, scopes, resource, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
        code,
        pending.client_id,
        email,
        pending.redirect_uri,
        pending.code_challenge,
        pending.scopes,
        pending.resource,
        timestamp + AUTH_CODE_TTL_SECONDS
    );

    audit({ actor: email, action: 'oauth.login', detail: { role: roleForEmail(email) }, outcome: 'ok' });

    let redirect: URL;
    try {
        redirect = new URL(pending.redirect_uri);
    } catch {
        throw new ServerError('Сохранён некорректный redirect_uri');
    }
    redirect.searchParams.set('code', code);
    if (pending.client_state !== null) redirect.searchParams.set('state', pending.client_state);

    res.redirect(redirect.toString());
}

// ─── Доступ к личности внутри инструментов ───────────────────────────────────

export interface Actor {
    email: string;
    role: Role;
    scopes: string[];
    /** Кабинеты, доступные этому человеку. null — все. */
    cabinets: string[] | null;
}

/** Читаем область видимости из базы на каждом запросе: сужение действует сразу. */
export function cabinetScopeOf(email: string): string[] | null {
    const row = db.prepare('SELECT cabinets FROM users WHERE email = ?').get(email) as
        | { cabinets: string | null }
        | undefined;
    const raw = row?.cabinets ?? null;
    if (!raw) return null;
    const list = raw
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
    return list.length > 0 ? list : null;
}

export function actorFromAuthInfo(auth: AuthInfo | undefined): Actor {
    const email = typeof auth?.extra?.email === 'string' ? auth.extra.email : undefined;
    if (!email) throw new InvalidTokenError('В токене нет личности пользователя');
    return { email, role: roleForEmail(email), scopes: auth?.scopes ?? [], cabinets: cabinetScopeOf(email) };
}
