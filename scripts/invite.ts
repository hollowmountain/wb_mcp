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
 * Что человек увидит, задаётся областями:
 *   --profile support        — готовый набор под роль
 *   --areas inbox,catalog    — вручную
 * Без них области не назначаются, и человек получает набор по умолчанию.
 *
 * Код привязан к почте: он же задаёт, что человек увидит.
 */
import { AREAS, PROFILES, isArea, type Area } from '../src/areas.js';
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

let areas: Area[] = [];
const profileFlag = args.indexOf('--profile');
if (profileFlag !== -1) {
    const name = args[profileFlag + 1];
    args.splice(profileFlag, 2);
    const preset = name ? PROFILES[name] : undefined;
    if (!preset) {
        console.error(`Неизвестный профиль «${name}». Доступны: ${Object.keys(PROFILES).join(', ')}`);
        process.exit(1);
    }
    areas = [...preset.areas];
}
const areasFlag = args.indexOf('--areas');
if (areasFlag !== -1) {
    const raw = args[areasFlag + 1] ?? '';
    args.splice(areasFlag, 2);
    const parts = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const bad = parts.filter(s => !isArea(s));
    if (bad.length > 0) {
        console.error(`Неизвестные области: ${bad.join(', ')}. Доступны: ${AREAS.join(', ')}`);
        process.exit(1);
    }
    areas = [...new Set([...areas, ...(parts as Area[])])];
}
if (areas.includes('reply') && !areas.includes('inbox')) {
    console.error('Область reply без inbox бессмысленна: отвечать не на что. Добавьте inbox.');
    process.exit(1);
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

// Область видимости может включать и кабинеты Wildberries, и кабинеты Ozon:
// это разные площадки с раздельным доступом, слаги Ozon начинаются с oz-.
const ozonSlugs = new Set(config.ozon.map(c => c.slug));
const unknown = scope.filter(s => !config.cabinets.has(s) && !ozonSlugs.has(s));
if (unknown.length > 0) {
    const choices = [config.cabinets.describeChoices(), [...ozonSlugs].join(', ')].filter(Boolean).join(', ');
    console.error(`Неизвестные кабинеты: ${unknown.join(', ')}`);
    console.error(`Доступны: ${choices}`);
    process.exit(1);
}

const code = newId(12);
db.prepare(
    'INSERT INTO invites (code, email, cabinets, areas, max_uses, used_count, created_at, used_at) VALUES (?, ?, ?, ?, ?, 0, ?, NULL)'
).run(code, email, scope.length > 0 ? scope.join(',') : null, areas.length > 0 ? areas.join(',') : null, maxUses, now());

console.log(`Код для ${email}: ${code}`);
console.log(`Кабинеты: ${scope.length > 0 ? scope.join(', ') : 'все'}`);
console.log(`Области: ${areas.length > 0 ? areas.join(', ') : 'по умолчанию'}`);
console.log(`Входов: ${maxUses === 0 ? 'без ограничения' : maxUses}`);
console.log('Передайте код по защищённому каналу — он равнозначен паролю.');
