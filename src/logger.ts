import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
    level: config.logLevel,
    redact: {
        paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'res.headers["set-cookie"]',
            'wbToken',
            'access_token',
            'refresh_token',
            'client_secret'
        ],
        censor: '[скрыто]'
    }
});
