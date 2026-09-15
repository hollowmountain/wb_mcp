/**
 * Клиент 1С:УНФ через стандартный интерфейс OData.
 *
 * Здесь есть только чтение. Функций записи в этом модуле не существует —
 * не «мы их не вызываем», а физически нечем: ни POST, ни PATCH, ни DELETE
 * не реализованы. Это вторая линия обороны.
 *
 * Первая линия — сама 1С: служебный пользователь claude_mcp работает под
 * профилем «Только просмотр», и платформа откажет в записи независимо от
 * нашего кода.
 *
 * Третья линия — белый список ниже. Публикация OData в базе оказалась
 * грубым инструментом: разрешение зависимостей одной «Номенклатуры»
 * транзитивно открыло 1460 сущностей, включая справочники сотрудников и
 * физических лиц. Профиль «Только просмотр» ограничивает запись, но не
 * состав данных, поэтому доступ сужаем здесь: всё, чего нет в списке,
 * для клиента не существует.
 */
import { TokenBucket } from '../wb/ratelimit.js';

/**
 * Сущности, к которым коннектору разрешено обращаться. Имена проверены
 * на живой базе 02.09.2026 — в УНФ склады называются «СтруктурныеЕдиницы»,
 * а регистр остатков «ЗапасыНаСкладах».
 *
 * Расширять этот список — сознательное решение, а не побочный эффект.
 * Ничего про сотрудников, физических лиц, зарплату и НДФЛ здесь быть не должно.
 */
export const ALLOWED_ENTITIES = [
    // Справочники
    'Catalog_Номенклатура',
    'Catalog_ЕдиницыИзмерения',
    'Catalog_Организации',
    'Catalog_Контрагенты',
    'Catalog_СтруктурныеЕдиницы',
    'Catalog_ХарактеристикиНоменклатуры',
    // Нужен только чтобы подставить имя исполнителя в сдельном наряде вместо
    // ссылки. Отдельного инструмента, который просто листает людей, нет.
    'Catalog_Сотрудники',
    // Спецификации: из чего сделана готовая продукция. Нужны, чтобы считать
    // материальную себестоимость. Состав и операции публикуются и отдельными
    // наборами — так их удобнее брать по конкретной спецификации.
    'Catalog_Спецификации',
    'Catalog_Спецификации_Состав',
    'Catalog_Спецификации_Операции',
    // Документы продаж и закупок
    'Document_ЗаказПокупателя',
    'Document_РасходнаяНакладная',
    'Document_ПриходнаяНакладная',
    'Document_ЗаказПоставщику',
    // Производство и склад
    'Document_ЗаказНаПроизводство',
    'Document_СдельныйНаряд',
    // Задания на работу — это и есть «заказ-наряды», просто в УНФ они названы
    // иначе. Искали их по слову «наряд» и не находили: наряд тут сдельный, а
    // задание — почасовое. Состояния лежат в справочнике с третьим названием.
    'Document_ЗаданиеНаРаботу',
    'Catalog_СостоянияЗаказНарядов',
    'Document_ПеремещениеЗапасов',
    'Document_СписаниеЗапасов',
    'Document_ОприходованиеЗапасов',
    'Document_ИнвентаризацияЗапасов',
    // Движение денег. Касса и расчётный счёт — четыре отдельных документа,
    // единого «журнала платежей» в базе нет.
    'Document_ПоступлениеВКассу',
    'Document_ПоступлениеНаСчет',
    'Document_РасходИзКассы',
    'Document_РасходСоСчета',
    // Статья ДДС — единственная аналитика, по которой видно, за что платили.
    // Без неё в отчёте остаются суммы без смысла.
    'Catalog_СтатьиДвиженияДенежныхСредств',
    // Регистры
    'AccumulationRegister_ЗапасыНаСкладах',
    // Виртуальная таблица остатков: сами движения бесполезны без свёртки,
    // а Balance отдаёт готовый остаток на текущий момент.
    'AccumulationRegister_ЗапасыНаСкладах/Balance',
    // Суммовой учёт запасов. Называется просто «Запасы», без слова
    // «себестоимость» — искать его по этому слову бесполезно.
    'AccumulationRegister_Запасы',
    'AccumulationRegister_Запасы/Balance',
    'AccumulationRegister_Продажи',
    'AccumulationRegister_Продажи/Turnovers'
] as const;

/**
 * Имя сущности. Раньше это был союз из тридцати строковых литералов, и он
 * ловил опечатки на этапе сборки. С открытием почти всей базы такой союз
 * потерял смысл: имена приходят от человека, а не из кода. Проверку взял на
 * себя isAllowed во время запроса.
 */
export type OnecEntity = string;

const allowed = new Set<string>(ALLOWED_ENTITIES);


/**
 * Всё остальное, что в базе не пусто.
 *
 * До 15.09.2026 коннектору было открыто около тридцати сущностей, и на каждый
 * вопрос вроде «а покажи задания на работу» приходилось лезть в код. Список
 * снят перебором: из 1461 опубликованной сущности непустых оказалось 197.
 * Пустые не открываем намеренно — они только зашумляют справку.
 *
 * Табличные части и виртуальные таблицы отдельно не перечислены: разрешение
 * распространяется на них само, см. isAllowed.
 */
export const OPEN_ENTITIES: readonly string[] = [
    'AccountingRegister_Управленческий',
    'AccumulationRegister_ВнеоборотныеАктивы',
    'AccumulationRegister_ВыпускПродукции',
    'AccumulationRegister_ГрафикДвиженияЗапасов',
    'AccumulationRegister_ДвиженияДенежныхСредств',
    'AccumulationRegister_ДенежныеСредства',
    'AccumulationRegister_ДенежныеСредстваВРезерве',
    'AccumulationRegister_ДоходыИРасходы',
    'AccumulationRegister_ЗаданияНаРаботу',
    'AccumulationRegister_ЗаказыНаПроизводство',
    'AccumulationRegister_ЗаказыПокупателей',
    'AccumulationRegister_ЗаказыПоставщикам',
    'AccumulationRegister_Закупки',
    'AccumulationRegister_ЗакупкиДляКУДиР',
    'AccumulationRegister_Запасы',
    'AccumulationRegister_ЗапасыНаСкладах',
    'AccumulationRegister_ЗапасыПереданные',
    'AccumulationRegister_КнигаУчетаДоходовИРасходов',
    'AccumulationRegister_НДСЗаписиКнигиПродаж',
    'AccumulationRegister_НДСПредъявленный',
    'AccumulationRegister_ОплатаДокументов',
    'AccumulationRegister_ОплатаСчетовИЗаказов',
    'AccumulationRegister_ПартииТоваровУСН',
    'AccumulationRegister_ПлатежныйКалендарь',
    'AccumulationRegister_ПотребностьВЗапасах',
    'AccumulationRegister_Продажи',
    'AccumulationRegister_РазмещениеЗаказов',
    'AccumulationRegister_РасчетыПоНалогам',
    'AccumulationRegister_РасчетыСПокупателями',
    'AccumulationRegister_РасчетыСПоставщиками',
    'AccumulationRegister_СдельныеНаряды',
    'AccumulationRegister_ФинансовыйРезультат',
    'AccumulationRegister_ЭтапыПроизводства',
    'Catalog_АвтоматическиеСкидки',
    'Catalog_АдресатыПисем',
    'Catalog_Банки',
    'Catalog_БанковскиеСчета',
    'Catalog_ВидыДокументовФизическихЛиц',
    'Catalog_ВидыДоходовПоСтраховымВзносам',
    'Catalog_ВидыДоходовПоСтраховымВзносамУНФ',
    'Catalog_ВидыЗаказНарядов',
    'Catalog_ВидыЗаказовПокупателей',
    'Catalog_ВидыКонтактнойИнформации',
    'Catalog_ВидыНалогов',
    'Catalog_ВидыОтправляемыхДокументов',
    'Catalog_ВидыПроизводства',
    'Catalog_ВидыРесурсовПредприятия',
    'Catalog_ВидыЦен',
    'Catalog_ВидыЦенКонтрагентов',
    'Catalog_ВнеоборотныеАктивы',
    'Catalog_ДоговорыКонтрагентов',
    'Catalog_ДополнительныеУсловия',
    'Catalog_ДрайверыОборудования',
    'Catalog_ЕдиницыИзмерения',
    'Catalog_ЗадачиАссистентаУправления',
    'Catalog_ЗначенияСвойствОбъектов',
    'Catalog_ИдентификаторыОбъектовМетаданных',
    'Catalog_ИсточникиПривлеченияПокупателей',
    'Catalog_Календари',
    'Catalog_Кассы',
    'Catalog_КатегорииНоменклатуры',
    'Catalog_КлассификаторБанков',
    'Catalog_КлассификаторЕдиницИзмерения',
    'Catalog_КлассификаторЗанятий',
    'Catalog_КлассификаторЗанятийУНФ',
    'Catalog_КлассификаторТНВЭД',
    'Catalog_КлючевыеРесурсы',
    'Catalog_КодыОперацийПрослеживаемости',
    'Catalog_КомплектацииНоменклатуры',
    'Catalog_КонтактныеЛица',
    'Catalog_Контрагенты',
    'Catalog_НаборыДополнительныхРеквизитовИСведений',
    'Catalog_НаправленияДеятельности',
    'Catalog_Номенклатура',
    'Catalog_НоменклатураПрисоединенныеФайлы',
    'Catalog_Операции0',
    'Catalog_Организации',
    'Catalog_ОрганизацииПрисоединенныеФайлы',
    'Catalog_ПараметрыРасчетовДоставки',
    'Catalog_ПодключаемоеОборудование',
    'Catalog_Подписи',
    'Catalog_ПоказателиРасчетов',
    'Catalog_ПолитикаУчетаСерий',
    'Catalog_ПрайсЛисты',
    'Catalog_ПричиныНеуспешногоЗавершенияРаботыСЛидом',
    'Catalog_ПричиныОтменыЗаказа',
    'Catalog_ПричиныОтменыЗаказовПоставщикам',
    'Catalog_ПроизводственныеКалендари',
    'Catalog_РабочиеМеста',
    'Catalog_РегистрацииВНалоговомОргане',
    'Catalog_РегламентированныеОтчеты',
    'Catalog_СегментыКонтрагентов',
    'Catalog_СлужбыДоставки',
    'Catalog_СостоянияЗаказНарядов',
    'Catalog_СостоянияЗаказовНаПеремещение',
    'Catalog_СостоянияЗаказовНаПроизводство',
    'Catalog_СостоянияЗаказовПокупателей',
    'Catalog_СостоянияЗаказовПоставщикам',
    'Catalog_СостоянияЛидов',
    'Catalog_СостоянияСобытий',
    'Catalog_Спецификации',
    'Catalog_СтавкиНДС',
    'Catalog_СтатьиДвиженияДенежныхСредств',
    'Catalog_СтраныМира',
    'Catalog_СтруктурныеЕдиницы',
    'Catalog_СценарииПланирования',
    'Catalog_Теги',
    'Catalog_ТипыДокументов',
    'Catalog_УсловияПредоставленияСкидокНаценок',
    'Catalog_УчетныеЗаписиЭлектроннойПочты',
    'Catalog_ХарактеристикиНоменклатуры',
    'Catalog_ХарактеристикиНоменклатурыПрисоединенныеФайлы',
    'Catalog_ХозяйственныеОперации',
    'Catalog_ХранилищеШаблонов',
    'Catalog_ШаблоныПоясненийДляФНС',
    'Catalog_ШаблоныЭтикетокИЦенниковБПО',
    'Catalog_ШтрихкодыУпаковокТоваров',
    'Catalog_ЭтапыПроизводства',
    'ChartOfAccounts_Управленческий',
    'ChartOfCharacteristicTypes_ДополнительныеРеквизитыИСведения',
    'Document_АмортизацияВА',
    'Document_ВводНачальныхОстатков',
    'Document_Взаимозачет',
    'Document_ДоговорКредитаИЗайма',
    'Document_ДополнительныеРасходы',
    'Document_ЗаданиеНаРаботу',
    'Document_ЗаказНаПроизводство',
    'Document_ЗаказПокупателя',
    'Document_ЗаказПоставщику',
    'Document_ЗакрытиеМесяца',
    'Document_ЗаписиУСН',
    'Document_ИнвентаризацияЗапасов',
    'Document_ОприходованиеЗапасов',
    'Document_ОтчетКомиссионера',
    'Document_ОтчетКомиссионераОСписании',
    'Document_ПеремещениеДС',
    'Document_ПеремещениеЗапасов',
    'Document_ПересортицаЗапасов',
    'Document_ПоступлениеВКассу',
    'Document_ПоступлениеНаСчет',
    'Document_ПриходнаяНакладная',
    'Document_РаспределениеЗатрат',
    'Document_РасходИзКассы',
    'Document_РасходСоСчета',
    'Document_РасходнаяНакладная',
    'Document_СборкаЗапасов',
    'Document_СверкаВзаиморасчетов',
    'Document_СдельныйНаряд',
    'Document_СписаниеЗапасов',
    'Document_СчетФактура',
    'Document_СчетФактураПолученный',
    'Document_УстановкаЦенНоменклатуры',
    'InformationRegister_ЖурналУчетаСчетовФактур',
    'InformationRegister_ОписаниеОперацииКУДиР',
    'InformationRegister_ОшибкиЗакрытияМесяца',
    'InformationRegister_ПараметрыВнеоборотныхАктивов',
    'InformationRegister_СостоянияВнеоборотныхАктивов',
];

/**
 * Данные о людях: физлица, зарплата, НДФЛ, взносы, кадровые документы.
 *
 * Лежат в той же базе и читаются тем же способом, но областью отделены —
 * менеджеру кабинета незачем видеть, кто сколько получает. Нужна область
 * payroll, как и для сдельных нарядов.
 */
export const PERSONAL_ENTITIES: readonly string[] = [
    'AccumulationRegister_НачисленияИУдержания',
    'AccumulationRegister_РасчетыСПерсоналом',
    'AccumulationRegister_РасчетыСПодотчетниками',
    'Catalog_АналитикаНачисленияБонусов',
    'Catalog_Бригады',
    'Catalog_ВидыВычетовНДФЛ',
    'Catalog_ВидыДоходовНДФЛ',
    'Catalog_ВидыНачисленийИУдержаний',
    'Catalog_ВидыОбщественноПолезнойДеятельностиСЗВК',
    'Catalog_ВидыРабочегоВремени',
    'Catalog_ВидыТарифовСтраховыхВзносов',
    'Catalog_ВычетыНДФЛ',
    'Catalog_ГрафикиРаботы',
    'Catalog_ГруппыПользователей',
    'Catalog_Должности',
    'Catalog_ЗамещениеГосударственныхМуниципальныхДолжностейПФР',
    'Catalog_КалендариСотрудников',
    'Catalog_КодыДоходовНДФЛ',
    'Catalog_ОснованияИсчисляемогоСтраховогоСтажа',
    'Catalog_ОснованияУвольнения',
    'Catalog_ПараметрыИсчисляемогоСтраховогоСтажа',
    'Catalog_Пользователи',
    'Catalog_ПричиныУвольненияПФР',
    'Catalog_Сотрудники',
    'Catalog_СпособыВыплатыЗарплаты',
    'Catalog_СпособыОкругленияПриРасчетеЗарплаты',
    'Catalog_СтатусыНалогоплательщиковПоНДФЛ',
    'Catalog_СтатьиРасходовЗарплата',
    'Catalog_ТерриториальныеУсловияПФР',
    'Catalog_ТрудовыеФункции',
    'Catalog_ФизическиеЛица',
    'Catalog_ФизическиеЛицаПрисоединенныеФайлы',
    'Catalog_ШаблоныЗаполненияГрафиковРабочегоВремени',
    'ChartOfCalculationTypes_Начисления',
    'Document_Доверенность',
    'Document_КадровоеПеремещениеУНФ',
    'Document_ПриемНаРаботуУНФ',
    'Document_УвольнениеУНФ',
    'InformationRegister_ПлановыеНачисленияИУдержания',
    'InformationRegister_Сотрудники',
];

const openSet = new Set<string>([...OPEN_ENTITIES, ...PERSONAL_ENTITIES]);
const personalSet = new Set<string>(PERSONAL_ENTITIES);

/** Имя без табличной части и без виртуальной таблицы: «Document_X_Строки» → «Document_X». */
function baseOf(entity: string): string {
    const head = entity.split('/')[0] ?? entity;
    const parts = head.split('_');
    return parts.length > 2 ? parts.slice(0, 2).join('_') : head;
}

/**
 * Разрешено ли читать. Табличные части и виртуальные таблицы наследуют
 * разрешение родителя: перечислять «Document_X_Запасы» рядом с «Document_X»
 * значило бы вести список из полутора тысяч строк и всё равно что-то забыть.
 */
export function isAllowed(entity: string): boolean {
    if (allowed.has(entity)) return true;
    const base = baseOf(entity);
    return openSet.has(base) || openSet.has(entity.split('/')[0] ?? entity);
}

/** Нужна ли для этой сущности область payroll, а не просто erp. */
export const isPersonal = (entity: string): boolean => personalSet.has(baseOf(entity));

/** База в облаке, лимитов не публикует. Ходим сдержанно. */
const bucket = new TokenBucket(4, 1);

export class OnecError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly entity: string
    ) {
        super(message);
        this.name = 'OnecError';
    }

    toUserMessage(): string {
        switch (this.status) {
            case 401:
                return '1С не приняла учётные данные (401). Возможно, пароль служебного пользователя сменили.';
            case 403:
                return `1С запретила доступ к «${this.entity}» (403). У служебного пользователя нет прав на этот раздел.`;
            case 404:
                return `1С не нашла «${this.entity}» (404). Объект не опубликован в настройках OData или называется иначе.`;
            default:
                return `1С вернула ошибку ${this.status} по «${this.entity}»: ${this.message}`;
        }
    }
}

export interface OnecConfig {
    baseUrl: string;
    user: string;
    password: string;
}

/**
 * Единственный способ обратиться к 1С из этого кода. Метод жёстко GET,
 * сущность обязана быть в белом списке.
 */
async function fetchEntity<T>(
    cfg: OnecConfig,
    entity: string,
    query: Record<string, string | number | undefined>
): Promise<T> {
    if (!isAllowed(entity)) {
        // Не «нет данных», а именно отказ: так видно, что сработал запрет,
        // а не опечатка в имени. Полный список не печатаем — он длиной в две
        // сотни строк и в сообщении об ошибке бесполезен.
        throw new OnecError(
            `Обращение к «${entity}» не разрешено: такой сущности в базе нет либо она пуста. ` +
                'Что открыто — покажет onec_entities.',
            403,
            entity
        );
    }

    await bucket.take(1);

    // Имя может состоять из двух частей — «регистр/Balance». Косую черту
    // разделителем сохраняем, каждую часть кодируем отдельно: иначе
    // encodeURIComponent превратит её в %2F и 1С ответит «сущность не найдена».
    const path = entity.split('/').map(encodeURIComponent).join('/');

    // Строку запроса собираем руками. URLSearchParams кодирует пробел как «+»
    // по правилам форм, а разборщик 1С понимает только %20 и берёт плюс
    // буквально — фильтр «Date ge datetime'…' and DeletionMark eq false»
    // превращался в бессмыслицу, и база отвечала «Операция не разрешена
    // в предложении ГДЕ». Ломались все фильтры с пробелами, то есть все,
    // кроме поиска по подстроке.
    const parts = ['$format=json'];
    for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== '') parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    }
    const url = `${cfg.baseUrl}/odata/standard.odata/${path}?${parts.join('&')}`;

    const auth = Buffer.from(`${cfg.user}:${cfg.password}`).toString('base64');
    const res = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(120_000)
    });

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        let detail = text;
        try {
            const parsed = JSON.parse(text) as { 'odata.error'?: { message?: { value?: string } } };
            detail = parsed['odata.error']?.message?.value ?? text;
        } catch {
            /* тело не JSON — оставляем как есть */
        }
        throw new OnecError(detail.slice(0, 300) || res.statusText, res.status, entity);
    }

    return (await res.json()) as T;
}

/** Список записей сущности. */
export async function listEntity<T>(
    cfg: OnecConfig,
    entity: OnecEntity,
    opts: { top?: number; skip?: number; filter?: string; select?: string; orderby?: string; expand?: string } = {}
): Promise<T[]> {
    const res = await fetchEntity<{ value: T[] }>(cfg, entity, {
        $top: Math.min(opts.top ?? 50, 1000),
        $skip: opts.skip,
        $filter: opts.filter,
        $select: opts.select,
        $orderby: opts.orderby,
        $expand: opts.expand
    });
    return res?.value ?? [];
}

/** Сколько всего записей. Дешевле, чем тянуть список. */
export async function countEntity(cfg: OnecConfig, entity: OnecEntity): Promise<number> {
    const res = await fetchEntity<{ value: unknown[] }>(cfg, entity, { $top: 0, $inlinecount: 'allpages' });
    const raw = res as unknown as Record<string, unknown>;
    const n = Number(raw['odata.count'] ?? raw['@odata.count'] ?? NaN);
    return Number.isFinite(n) ? n : (res?.value?.length ?? 0);
}

/** Что вообще открыто коннектору — для показа человеку. */
export const describeAllowed = (): string => ALLOWED_ENTITIES.join(', ');


// ─── Разворачивание ссылок ───────────────────────────────────────────────────

const EMPTY_GUID = '00000000-0000-0000-0000-000000000000';

/**
 * Регистры хранят ссылки на справочники, а не названия: в строке остатка
 * лежит Номенклатура_Key вида 542544e4-… . Показывать человеку такое нельзя,
 * поэтому собираем уникальные ссылки и спрашиваем названия одним запросом
 * на справочник. $expand тоже работает, но тянет карточку целиком — на сотне
 * строк это мегабайты ради одного поля.
 */
const nameCache = new Map<string, { at: number; names: Map<string, string> }>();
const NAME_TTL = 10 * 60 * 1000;

/**
 * Сколько ссылок влезает в один фильтр. Веб-сервер перед 1С (IIS) режет
 * строку запроса примерно на двух тысячах знаков и отвечает 404.15 —
 * страницей об ошибке, а не JSON. Проверено: 25 ссылок проходят (1696 знаков),
 * 30 уже нет. Берём 20 с запасом.
 */
const REFS_PER_QUERY = 20;

/** Сколько неизвестных ссылок оправдывают выкачивание справочника целиком. */
const WHOLESALE_FROM = 60;
const PAGE = 1000;

export async function resolveNames(
    cfg: OnecConfig,
    entity: OnecEntity,
    keys: Iterable<string>
): Promise<Map<string, string>> {
    const unique = [...new Set([...keys].filter(k => k && k !== EMPTY_GUID))];
    const names = new Map<string, string>();
    if (unique.length === 0) return names;

    // Справочники меняются редко, а один и тот же товар встречается в остатках
    // на десятке складов. Без памяти каждый вызов заново гонял бы сотни ссылок.
    const cached = nameCache.get(entity);
    const fresh = cached && Date.now() - cached.at < NAME_TTL ? cached.names : new Map<string, string>();
    const missing: string[] = [];
    for (const k of unique) {
        const known = fresh.get(k);
        if (known === undefined) missing.push(k);
        else names.set(k, known);
    }

    // Когда неизвестных ссылок много, дешевле забрать справочник целиком.
    // Остатки дают около семисот разных товаров, то есть 35 запросов по 20
    // ссылок — а с ограничителем в 4 запроса в секунду это больше полуминуты
    // ожидания. Номенклатура же целиком (5216 позиций) выкачивается шестью
    // страницами меньше чем за секунду.
    if (missing.length > WHOLESALE_FROM) {
        for (let skip = 0; skip < 50_000; skip += PAGE) {
            const rows = await listEntity<{ Ref_Key: string; Description?: string }>(cfg, entity, {
                top: PAGE,
                skip,
                select: 'Ref_Key,Description',
                // Сортировка обязательна. Без неё 1С не гарантирует порядок строк
                // между запросами, и страницы перекрываются: шесть страниц по
                // тысяче дали 1915 разных записей из 5216, остальное — повторы.
                // Названия у большинства товаров тогда не находились, и остатки
                // схлопывались в одну безымянную кучу.
                orderby: 'Ref_Key'
            });
            for (const r of rows) fresh.set(r.Ref_Key, r.Description ?? '');
            if (rows.length < PAGE) break;
        }
        for (const k of missing) names.set(k, fresh.get(k) ?? '');
    } else {
        for (let i = 0; i < missing.length; i += REFS_PER_QUERY) {
            const chunk = missing.slice(i, i + REFS_PER_QUERY);
            const filter = chunk.map(k => `Ref_Key eq guid'${k}'`).join(' or ');
            const rows = await listEntity<{ Ref_Key: string; Description?: string }>(cfg, entity, {
                top: chunk.length,
                filter,
                select: 'Ref_Key,Description'
            });
            for (const r of rows) {
                const name = r.Description ?? '';
                names.set(r.Ref_Key, name);
                fresh.set(r.Ref_Key, name);
            }
        }
    }
    nameCache.set(entity, { at: cached && Date.now() - cached.at < NAME_TTL ? cached.at : Date.now(), names: fresh });
    return names;
}

export interface OnecStockRow {
    productKey: string;
    product: string;
    warehouseKey: string;
    warehouse: string;
    quantity: number;
}

/** Остатки на складах на текущий момент, только ненулевые. */
export async function getOnecStock(cfg: OnecConfig): Promise<OnecStockRow[]> {
    // Фильтровать по мере регистра нельзя: 1С отвечает «Операция не разрешена
    // в предложении ГДЕ». Поэтому забираем всё и отсеиваем нули у себя.
    //
    // Забираем именно постранично и с сортировкой. Одной страницы сегодня
    // хватало — строк 846 при пределе в 1000, — но это случайность: вырастет
    // склад, и остаток молча покажется неполным. А без сортировки страницы
    // перекрываются, на чём здесь уже обжигались.
    const PAGE_SIZE = 1000;
    const pages: Array<{
        Номенклатура_Key: string;
        СтруктурнаяЕдиница_Key: string;
        КоличествоBalance: number;
    }> = [];
    for (let skip = 0; skip < 40_000; skip += PAGE_SIZE) {
        const rows = await listEntity<{
            Номенклатура_Key: string;
            СтруктурнаяЕдиница_Key: string;
            КоличествоBalance: number;
        }>(cfg, 'AccumulationRegister_ЗапасыНаСкладах/Balance', {
            top: PAGE_SIZE,
            skip,
            orderby: 'Номенклатура_Key'
        });
        pages.push(...rows);
        if (rows.length < PAGE_SIZE) break;
    }
    const raw = pages.filter(r => (r.КоличествоBalance ?? 0) > 0);

    const [products, warehouses] = await Promise.all([
        resolveNames(cfg, 'Catalog_Номенклатура', raw.map(r => r.Номенклатура_Key)),
        resolveNames(cfg, 'Catalog_СтруктурныеЕдиницы', raw.map(r => r.СтруктурнаяЕдиница_Key))
    ]);

    return raw.map(r => ({
        productKey: r.Номенклатура_Key,
        product: products.get(r.Номенклатура_Key) ?? '(без названия)',
        warehouseKey: r.СтруктурнаяЕдиница_Key,
        warehouse: warehouses.get(r.СтруктурнаяЕдиница_Key) ?? '(склад не указан)',
        quantity: r.КоличествоBalance
    }));
}


export interface OnecStockValueRow {
    productKey: string;
    product: string;
    placeKey: string;
    place: string;
    /** Свой склад или контрагент: суммы по ним смешивать нельзя. */
    atPartner: boolean;
    quantity: number;
    sum: number;
    sumNoVat: number;
}

/**
 * Денежная оценка запасов из регистра «Запасы».
 *
 * Две вещи, на которых легко ошибиться.
 *
 * Первая: строк больше тысячи, а без сортировки страницы перекрываются —
 * первый подсчёт дал 1000 строк вместо 2423 и занизил итог вдвое.
 *
 * Вторая: измерение СтруктурнаяЕдиница ссылается то на склад, то на
 * контрагента. По своим складам суммы ведут себя правильно, а по запасам
 * у контрагентов сумма без НДС оказывается БОЛЬШЕ суммы с НДС, чего быть
 * не может. Поэтому части не складываются в одно число, а показываются
 * порознь: пусть расхождение видит человек, а не прячется в итоге.
 */
export async function getOnecStockValue(cfg: OnecConfig): Promise<OnecStockValueRow[]> {
    const PAGE_SIZE = 1000;
    const raw: Array<Record<string, unknown>> = [];
    for (let skip = 0; skip < 40_000; skip += PAGE_SIZE) {
        const rows = await listEntity<Record<string, unknown>>(cfg, 'AccumulationRegister_Запасы/Balance', {
            top: PAGE_SIZE,
            skip,
            orderby: 'Номенклатура_Key'
        });
        raw.push(...rows);
        if (rows.length < PAGE_SIZE) break;
    }

    const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
    const partnerOf = (v: unknown): boolean => String(v ?? '').endsWith('Catalog_Контрагенты');

    const [products, places, partners] = await Promise.all([
        resolveNames(cfg, 'Catalog_Номенклатура', raw.map(r => String(r.Номенклатура_Key ?? ''))),
        resolveNames(
            cfg,
            'Catalog_СтруктурныеЕдиницы',
            raw.filter(r => !partnerOf(r.СтруктурнаяЕдиница_Type)).map(r => String(r.СтруктурнаяЕдиница ?? ''))
        ),
        resolveNames(
            cfg,
            'Catalog_Контрагенты',
            raw.filter(r => partnerOf(r.СтруктурнаяЕдиница_Type)).map(r => String(r.СтруктурнаяЕдиница ?? ''))
        )
    ]);

    return raw.map(r => {
        const atPartner = partnerOf(r.СтруктурнаяЕдиница_Type);
        const placeKey = String(r.СтруктурнаяЕдиница ?? '');
        return {
            productKey: String(r.Номенклатура_Key ?? ''),
            product: products.get(String(r.Номенклатура_Key ?? '')) || '(без названия)',
            placeKey,
            place: (atPartner ? partners : places).get(placeKey) || '(не указано)',
            atPartner,
            quantity: num(r.КоличествоBalance),
            sum: num(r.СуммаBalance),
            sumNoVat: num(r.СуммаБезНДСBalance)
        };
    });
}


// ─── Движение денежных средств ───────────────────────────────────────────────

/** Одна из четырёх касс/счетов, откуда или куда ушли деньги. */
export type CashKind = 'касса' | 'счёт';

export interface CashFlowRow {
    kind: CashKind;
    /** Приход или расход. */
    incoming: boolean;
    number: string;
    date: string;
    sum: number;
    /** Вид операции из 1С: «ОтПокупателя», «Поставщику» и подобное. */
    operation: string;
    partner: string;
    /** Статья движения денежных средств — за что платили. */
    article: string;
    purpose: string;
}

const CASH_SOURCES = [
    { entity: 'Document_ПоступлениеВКассу', kind: 'касса', incoming: true },
    { entity: 'Document_РасходИзКассы', kind: 'касса', incoming: false },
    { entity: 'Document_ПоступлениеНаСчет', kind: 'счёт', incoming: true },
    { entity: 'Document_РасходСоСчета', kind: 'счёт', incoming: false }
] as const;

/**
 * Платежи за период по кассе и расчётному счёту.
 *
 * Единого журнала платежей в базе нет: приход и расход, касса и счёт — четыре
 * разных документа, поэтому собираем их сами и складываем в одну ленту.
 *
 * Берём только проведённые и неудалённые: в выгрузке хватает и черновиков, и
 * помеченного на удаление, а по суммам их не отличить от настоящих платежей.
 */
export async function getOnecCashFlow(
    cfg: OnecConfig,
    dateFrom: string,
    dateTo: string,
    maxPerSource = 5000
): Promise<CashFlowRow[]> {
    // 1С понимает только datetime-литералы, дата без времени отвергается.
    const filter =
        `Posted eq true and DeletionMark eq false` +
        ` and Date ge datetime'${dateFrom}T00:00:00'` +
        ` and Date le datetime'${dateTo}T23:59:59'`;

    const PAGE_SIZE = 500;

    const parts = await Promise.all(
        CASH_SOURCES.map(async src => {
            // Забираем период целиком, а не первую страницу: расходов со счёта
            // за месяц набегает под шесть сотен, и обрезанная выборка выглядела
            // бы как полная — итог занижался молча.
            //
            // Сортировка по Ref_Key обязательна: 1С не гарантирует порядок строк
            // между запросами, и без неё страницы перекрываются.
            const rows: Record<string, unknown>[] = [];
            for (let skip = 0; skip < maxPerSource; skip += PAGE_SIZE) {
                const page = await listEntity<Record<string, unknown>>(cfg, src.entity, {
                    top: PAGE_SIZE,
                    skip,
                    filter,
                    orderby: 'Ref_Key'
                });
                rows.push(...page);
                if (page.length < PAGE_SIZE) break;
            }
            return rows.map(r => ({ src, r }));
        })
    );
    const all = parts.flat();
    if (all.length === 0) return [];

    const [partners, articles] = await Promise.all([
        resolveNames(cfg, 'Catalog_Контрагенты', all.map(x => String(x.r.Контрагент_Key ?? ''))),
        resolveNames(cfg, 'Catalog_СтатьиДвиженияДенежныхСредств', all.map(x => String(x.r.Статья_Key ?? '')))
    ]);

    const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

    return all
        .map(({ src, r }) => ({
            kind: src.kind as CashKind,
            incoming: src.incoming,
            number: String(r.Number ?? '').trim(),
            date: String(r.Date ?? '').slice(0, 10),
            sum: num(r.СуммаДокумента),
            operation: String(r.ВидОперации ?? '').trim(),
            partner: partners.get(String(r.Контрагент_Key ?? '')) || '',
            article: articles.get(String(r.Статья_Key ?? '')) || '',
            purpose: String(r.НазначениеПлатежа ?? r.Комментарий ?? '').replace(/\s+/g, ' ').trim()
        }))
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}
