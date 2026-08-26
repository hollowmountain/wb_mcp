/**
 * Выдать сотруднику одноразовый код входа (нужен при IDENTITY_PROVIDER=invite).
 *
 *   npx tsx scripts/invite.ts ivan@company.ru                 — доступ ко всем кабинетам
 *   npx tsx scripts/invite.ts anna@company.ru beauty          — только кабинет beauty
 *   npx tsx scripts/invite.ts petr@company.ru beauty,harbez   — два кабинета
 *
 * Код одноразовый и привязан к почте: он же задаёт, что человек увидит.
 */
import { config } from '../src/config.js';
import { db, newId, now } from '../src/db/index.js';

const email = process.argv[2]?.trim().toLowerCase();
const scopeArg = process.argv[3]?.trim();

if (!email || !email.includes('@')) {
    console.error('Использование: npx tsx scripts/invite.ts <email> [кабинет,кабинет]');
    process.exit(1);
}

const scope = (scopeArg ?? '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);

const unknown = scope.filter(s => !config.cabinets.has(s));
if (unknown.length > 0) {
    console.error(`Неизвестные кабинеты: ${unknown.join(', ')}`);
    console.error(`Доступны: ${config.cabinets.describeChoices()}`);
    process.exit(1);
}

const code = newId(12);
db.prepare('INSERT INTO invites (code, email, cabinets, created_at, used_at) VALUES (?, ?, ?, ?, NULL)').run(
    code,
    email,
    scope.length > 0 ? scope.join(',') : null,
    now()
);

console.log(`Код для ${email}: ${code}`);
console.log(`Кабинеты: ${scope.length > 0 ? scope.join(', ') : 'все'}`);
console.log('Код одноразовый. Передайте его сотруднику по защищённому каналу.');
