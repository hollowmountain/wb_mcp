import { config } from '../../config.js';
import { googleIdentity } from './google.js';
import { inviteIdentity } from './invite.js';
import type { IdentityProvider } from './types.js';
import { yandexIdentity } from './yandex.js';

const providers: Record<typeof config.identityProvider, IdentityProvider> = {
    google: googleIdentity,
    yandex: yandexIdentity,
    invite: inviteIdentity
};

export const identity: IdentityProvider = providers[config.identityProvider];

export type { IdentityProvider, VerifiedIdentity } from './types.js';
