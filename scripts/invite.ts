/**
 * Выдать сотруднику одноразовый код входа (нужен при IDENTITY_PROVIDER=invite).
 *
 *   npx tsx scripts/invite.ts ivan@company.ru                 — доступ ко всем кабинетам
 *   npx tsx scripts/invite.ts anna@company.ru beauty          — только кабинет beauty
 *   npx tsx scripts/invite.ts petr@company.ru beauty,harbez   — два кабинета
 *
 * По умолчанию код одноразовый. Число входов задаётся флагом:
 *   --uses 5           — пять входов
 *   --uses unlimited   — без ограничения (для своего постоянного доступа)
 *
 * Код привязан к почте: он же задаёт, что человек увидит.
 */
import { config } from '../src/config.js';
import { db, newId, now } from '../src/db/index.js';

const args = process.argv.slice(2);
const usesFlag = args.indexOf('--uses');
let maxUses = 1;
if (usesFlag !== -1) {
    const raw = args[usesFlag + 1];
    args.splice(usesFlag, 2);
    if (raw === 'unlimited' || raw === '0') {
        maxUses = 0;
    } else {
        maxUses = Number(raw);
        if (!Number.isInteger(maxUses) || maxUses < 1) {
            console.error('--uses принимает целое число от 1 или слово unlimited');
            process.exit(1);
        }
    }
}

const email = args[0]?.trim().toLowerCase();
const scopeArg = args[1]?.trim();

if (!email || !email.includes('@')) {
    console.error('Использование: npx tsx scripts/invite.ts <email> [кабинет,кабинет] [--uses N|unlimited]');
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
db.prepare(
    'INSERT INTO invites (code, email, cabinets, max_uses, used_count, created_at, used_at) VALUES (?, ?, ?, ?, 0, ?, NULL)'
).run(code, email, scope.length > 0 ? scope.join(',') : null, maxUses, now());

console.log(`Код для ${email}: ${code}`);
console.log(`Кабинеты: ${scope.length > 0 ? scope.join(', ') : 'все'}`);
console.log(`Входов: ${maxUses === 0 ? 'без ограничения' : maxUses}`);
console.log('Передайте код по защищённому каналу — он равнозначен паролю.');
