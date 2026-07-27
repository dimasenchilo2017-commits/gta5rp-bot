require('dotenv').config();
if (!process.env.TOKEN) {
    console.error('❌ ТОКЕН НЕ ЗАГРУЖЕН!');
    process.exit(1);
} else {
    console.log(`✅ Токен загружен: ${process.env.TOKEN.substring(0, 15)}...`);
}
const { Client, GatewayIntentBits, ModalBuilder, ApplicationCommandType, TextInputBuilder, TextInputStyle, ActionRowBuilder, EmbedBuilder, ButtonBuilder, ButtonStyle, MessageFlags, REST, Routes, SlashCommandBuilder } = require('discord.js');
const db = require('./database');

// [!] Импортируем список участников фракции
const membersData = require('./members.js');

// [!] Строим Map: игровой ник -> discordId (только те, у кого есть id)
const membersMap = new Map();
membersData.forEach(m => {
    if (m.discordId) {
        membersMap.set(m.gameName, m.discordId);
    }
});

// [!] Функция для получения упоминаний по массиву ников
function getMembersInfo(nicknames) {
    const result = {
        mentions: [],
        displayNames: []
    };
    
    nicknames.forEach(nick => {
        const trimmed = nick.trim();
        const id = membersMap.get(trimmed);
        if (id) {
            result.mentions.push(`<@${id}>`);
            result.displayNames.push(trimmed);
        } else {
            result.displayNames.push(trimmed);
        }
    });
    
    return result;
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
if (!global.pendingMessages) global.pendingMessages = new Map();

process.on('unhandledRejection', error => { console.error('Unhandled rejection:', error); });
process.on('uncaughtException', err => { console.error('Uncaught exception:', err); });

const CONFIG = {
    PICK: process.env.PICK,
    PROCESS: process.env.PROCESS,
    PAY: process.env.PAY,
    ALLOWED_ROLES: process.env.ALLOWED_ROLES ? process.env.ALLOWED_ROLES.split(',') : []
};

// ---- Функция списания обычного долга (только debtors) ----
function deductDebt(debtorName, amount) {
    if (amount <= 0 || !debtorName) return;
    db.prepare('UPDATE debtors SET amount = amount - ? WHERE name = ?').run(amount, debtorName);
    db.prepare('DELETE FROM debtors WHERE amount <= 0').run();
}

// ---- Функция списания просрочки (overdue + остаток в debtors) ----
function deductOverdue(debtorName, amount) {
    if (amount <= 0 || !debtorName) return;
    
    // 1. Сначала списываем из overdue
    const records = db.prepare('SELECT id, amount FROM overdue WHERE debtorName = ? AND resolved = 0 ORDER BY deadline ASC').all(debtorName);
    let remaining = amount;
    for (const rec of records) {
        if (remaining <= 0) break;
        const deduct = Math.min(rec.amount, remaining);
        const newAmount = rec.amount - deduct;
        if (newAmount <= 0) {
            db.prepare('UPDATE overdue SET resolved = 1 WHERE id = ?').run(rec.id);
        } else {
            db.prepare('UPDATE overdue SET amount = ? WHERE id = ?').run(newAmount, rec.id);
        }
        remaining -= deduct;
    }
    
    // 2. Оставшуюся сумму списываем из обычного долга (debtors)
    if (remaining > 0) {
        console.log(`[LOG] Остаток ${remaining} $ по просрочке для ${debtorName} списывается из обычного долга`);
        deductDebt(debtorName, remaining);
    }
}

// ---- Функция списания критической просрочки (critical_overdue + остаток в debtors) ----
function deductCritical(debtorName, amount) {
    if (amount <= 0 || !debtorName) return;
    
    // 1. Сначала списываем из critical_overdue
    const records = db.prepare('SELECT id, amount FROM critical_overdue WHERE debtorName = ? AND resolved = 0 ORDER BY deadline ASC').all(debtorName);
    let remaining = amount;
    for (const rec of records) {
        if (remaining <= 0) break;
        const deduct = Math.min(rec.amount, remaining);
        const newAmount = rec.amount - deduct;
        if (newAmount <= 0) {
            db.prepare('UPDATE critical_overdue SET resolved = 1 WHERE id = ?').run(rec.id);
        } else {
            db.prepare('UPDATE critical_overdue SET amount = ? WHERE id = ?').run(newAmount, rec.id);
        }
        remaining -= deduct;
    }
    
    // 2. Оставшуюся сумму списываем из обычного долга (debtors)
    if (remaining > 0) {
        console.log(`[LOG] Остаток ${remaining} $ по критической просрочке для ${debtorName} списывается из обычного долга`);
        deductDebt(debtorName, remaining);
    }
}

// ---- Функция для внесения оплаты вручную ----
function addManualPayment(title, amount, participants, creatorId) {
    const paymentId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    const deadline = Date.now() + 72 * 60 * 60 * 1000;
    
    db.prepare(`
        INSERT INTO pending_payments 
        (contractMsgId, paymentMsgId, creatorId, title, totalAmount, createdAt, deadline, paid)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        `manual_${paymentId}`,
        `manual_${paymentId}`,
        creatorId,
        title,
        amount,
        Date.now(),
        deadline,
        0
    );
    
    // Добавляем участников в debtors
    participants.split(';').forEach(name => {
        const trimmed = name.trim();
        if (trimmed) {
            const existing = db.prepare('SELECT amount FROM debtors WHERE name = ?').get(trimmed);
            if (existing) {
                db.prepare('UPDATE debtors SET amount = amount + ? WHERE name = ?').run(amount, trimmed);
            } else {
                db.prepare('INSERT INTO debtors (name, amount) VALUES (?, ?)').run(trimmed, amount);
            }
        }
    });
    
    return paymentId;
}

// ---- Вспомогательная функция для получения деталей ожидающих оплат (ОБНОВЛЕНА) ----
async function getPendingDetails(pendingRecords) {
    if (pendingRecords.length === 0) return '';
    const payChannel = await client.channels.fetch(CONFIG.PAY);
    let result = '';
    for (const p of pendingRecords) {
        const isManual = p.contractMsgId && p.contractMsgId.startsWith('manual_');
        
        try {
            const msg = await payChannel.messages.fetch(p.paymentMsgId);
            if (msg.embeds && msg.embeds.length > 0 && msg.embeds[0].fields) {
                const fields = msg.embeds[0].fields;
                let allPaid = true;
                let participantLines = [];
                let hasAnyParticipants = false;
                
                for (const field of fields) {
                    const amountMatch = field.value.match(/([\d, ]+)\s*\$?/);
                    const amount = amountMatch ? amountMatch[1].trim() : '0';
                    const cleanAmount = parseInt(amount.replace(/\s/g, '')) || 0;
                    
                    // [!] Проверяем, есть ли отметка об оплате для этого участника в этом контракте
                    const paidMarker = db.prepare(`
                        SELECT 1 FROM paid_markers 
                        WHERE debtorName = ? AND contractTitle = ? AND amount = ?
                    `).get(field.name, p.title, cleanAmount);
                    
                    const isPaid = !!paidMarker;
                    if (!isPaid) allPaid = false;
                    hasAnyParticipants = true;
                    
                    // [!] Если оплачено - зачёркиваем
                    if (isPaid) {
                        participantLines.push(`   • ~~**${field.name}**: ${amount} $~~ ✅`);
                    } else {
                        participantLines.push(`   • **${field.name}**: ${amount} $`);
                    }
                }
                
                // [!] Если все оплатили - ПРОПУСКАЕМ этот контракт (не показываем)
                if (allPaid && hasAnyParticipants) {
                    continue;
                }
                
                // Показываем контракт только если есть неоплаченные участники
                result += `💳 **${p.title}**${isManual ? ' (📝 ручная оплата)' : ''}\n`;
                result += participantLines.join('\n');
                
                const timeLeft = Math.round((p.deadline - Date.now()) / (1000 * 60 * 60));
                const status = timeLeft > 0 ? `⏳ осталось ${timeLeft} ч.` : '⌛ **ПРОСРОЧЕН!**';
                result += `\n   ${status}\n`;
            } else {
                result += `💳 **${p.title}**${isManual ? ' (📝 ручная оплата)' : ''}\n`;
                result += `   (данные о платеже недоступны, общая сумма: ${p.totalAmount.toLocaleString()} $)\n`;
                const timeLeft = Math.round((p.deadline - Date.now()) / (1000 * 60 * 60));
                const status = timeLeft > 0 ? `⏳ осталось ${timeLeft} ч.` : '⌛ **ПРОСРОЧЕН!**';
                result += `   ${status}\n`;
            }
        } catch (e) {
            result += `💳 **${p.title}**${isManual ? ' (📝 ручная оплата)' : ''}\n`;
            result += `   (сообщение с платежом не найдено, общая сумма: ${p.totalAmount.toLocaleString()} $)\n`;
            const timeLeft = Math.round((p.deadline - Date.now()) / (1000 * 60 * 60));
            const status = timeLeft > 0 ? `⏳ осталось ${timeLeft} ч.` : '⌛ **ПРОСРОЧЕН!**';
            result += `   ${status}\n`;
        }
        result += '\n';
    }
    return result;
}

// ---- Вспомогательная функция для форматирования просрочек ----
function formatOverdue(tableName, label) {
    const records = db.prepare(`SELECT debtorName, amount, deadline FROM ${tableName} WHERE resolved = 0`).all();
    if (records.length === 0) return null;
    let result = `${label} (${records.length}):\n`;
    for (const rec of records) {
        const timeLeft = Math.round((rec.deadline - Date.now()) / (1000 * 60 * 60));
        const status = timeLeft > 0 ? `⏳ осталось ${timeLeft} ч.` : '⌛ **ПРОСРОЧЕН!**';
        result += `   • **${rec.debtorName}** — ${rec.amount.toLocaleString()} $ — ${status}\n`;
    }
    return result;
}

const setupTimer = async (channel, creatorId, endTime) => {
    const remaining = endTime - Date.now();
    setTimeout(async () => {
        try {
            await channel.send(`⚠️ **ВРЕМЯ ВЫШЛО!** <@${creatorId}>, проверьте и закройте контракт после того как он завершится в игре!`);
        } catch (err) { console.error('Ошибка таймера:', err); }
    }, Math.max(0, remaining));
};

const commands = [
    new SlashCommandBuilder().setName('вызвать').setDescription('Создать контракт'),
    new SlashCommandBuilder().setName('казна').setDescription('Показать баланс казны'),
    new SlashCommandBuilder().setName('пополнить').setDescription('Пополнить казну').addIntegerOption(o => o.setName('сумма').setDescription('Сумма').setRequired(true)),
    new SlashCommandBuilder().setName('вычесть').setDescription('Списать из казны').addIntegerOption(o => o.setName('сумма').setDescription('Сумма').setRequired(true)),
    new SlashCommandBuilder().setName('должники').setDescription('Список должников'),
    new SlashCommandBuilder().setName('долг_добавить').setDescription('Добавить должника').addStringOption(o => o.setName('ник').setDescription('Ник').setRequired(true)).addIntegerOption(o => o.setName('сумма').setDescription('Сумма').setRequired(true)),
    new SlashCommandBuilder().setName('оплачено').setDescription('Закрыть обычный долг').addStringOption(o => o.setName('ник').setDescription('Ник').setRequired(true)).addIntegerOption(o => o.setName('сумма').setDescription('Сумма').setRequired(true)),
    new SlashCommandBuilder().setName('оплачено_просрочка').setDescription('Закрыть долг из просрочки').addStringOption(o => o.setName('ник').setDescription('Ник').setRequired(true)).addIntegerOption(o => o.setName('сумма').setDescription('Сумма').setRequired(true)),
    new SlashCommandBuilder().setName('оплачено_крит').setDescription('Закрыть долг из критической просрочки').addStringOption(o => o.setName('ник').setDescription('Ник').setRequired(true)).addIntegerOption(o => o.setName('сумма').setDescription('Сумма').setRequired(true)),
    new SlashCommandBuilder().setName('чек_контракты').setDescription('Принудительно проверить все таймеры'),
    new SlashCommandBuilder().setName('статистика').setDescription('Показать актуальную статистику бота'),
    new SlashCommandBuilder().setName('контракт_список').setDescription('Список активных контрактов'),
    new SlashCommandBuilder().setName('ожидают').setDescription('Показать контракты, ожидающие оплаты'),
    new SlashCommandBuilder()
        .setName('просрочка')
        .setDescription('Начислить штраф за просрочку (сумма × 1.25) + дедлайн 48ч')
        .addStringOption(o => o.setName('ник').setDescription('Ник должника').setRequired(true))
        .addIntegerOption(o => o.setName('сумма').setDescription('Сумма долга').setRequired(true)),
    new SlashCommandBuilder()
        .setName('критическая')
        .setDescription('Начислить штраф за критическую просрочку (сумма × 1.25) + дедлайн 48ч')
        .addStringOption(o => o.setName('ник').setDescription('Ник должника').setRequired(true))
        .addIntegerOption(o => o.setName('сумма').setDescription('Сумма долга').setRequired(true)),
    new SlashCommandBuilder()
        .setName('внести_оплату')
        .setDescription('Внести оплату по контракту (вручную)')
        .addStringOption(o => o.setName('название').setDescription('Название контракта').setRequired(true))
        .addIntegerOption(o => o.setName('сумма').setDescription('Сумма оплаты').setRequired(true))
        .addStringOption(o => o.setName('участники').setDescription('Ники участников через ;').setRequired(true)),
    new SlashCommandBuilder()
        .setName('отметить_оплачено')
        .setDescription('Отметить долг как оплаченный (ТОЛЬКО отметка, НЕ списывает из debtors)')
        .addStringOption(o => o.setName('ник').setDescription('Ник должника').setRequired(true))
        .addStringOption(o => o.setName('контракт').setDescription('Название контракта').setRequired(true))
        .addIntegerOption(o => o.setName('сумма').setDescription('Сумма долга').setRequired(true)),
    new SlashCommandBuilder()
        .setName('убрать_отметку')
        .setDescription('Удалить отметку об оплате (на крайний случай)')
        .addStringOption(o => o.setName('ник').setDescription('Ник должника').setRequired(true))
        .addStringOption(o => o.setName('контракт').setDescription('Название контракта').setRequired(true))
        .addIntegerOption(o => o.setName('сумма').setDescription('Сумма').setRequired(true)),
    { name: 'Импортировать контракт', type: ApplicationCommandType.Message },
    { name: 'Закрыть контракт', type: ApplicationCommandType.Message },
    { name: 'Напомнить о закрытии', type: ApplicationCommandType.Message },
    { name: 'Принудительно оплатить', type: ApplicationCommandType.Message },
    { name: 'Импортировать оплату', type: ApplicationCommandType.Message },
    new SlashCommandBuilder()
        .setName('удалить_контракт')
        .setDescription('Принудительно удалить контракт из БД (без редактирования сообщения)')
        .addStringOption(o => o
            .setName('msgid')
            .setDescription('ID сообщения с контрактом')
            .setRequired(true)
        )
];

client.once('clientReady', async () => {
    // ---- Автоматическое создание колонок title и closedAt, если их нет ----
    try {
        const tableInfo = db.prepare("PRAGMA table_info(contract_history)").all();
        const columnNames = tableInfo.map(col => col.name);
        if (!columnNames.includes('title')) {
            db.prepare("ALTER TABLE contract_history ADD COLUMN title TEXT").run();
            console.log('[DB] Добавлена колонка title');
        }
        if (!columnNames.includes('closedAt')) {
            db.prepare("ALTER TABLE contract_history ADD COLUMN closedAt INTEGER").run();
            console.log('[DB] Добавлена колонка closedAt');
        }
    } catch (err) {
        console.error('[DB] Ошибка при добавлении колонок:', err);
    }

    // ---- Создание таблицы pending_payments, если её нет ----
    try {
        db.prepare(`
            CREATE TABLE IF NOT EXISTS pending_payments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                contractMsgId TEXT NOT NULL,
                paymentMsgId TEXT NOT NULL,
                creatorId TEXT NOT NULL,
                title TEXT,
                totalAmount INTEGER NOT NULL,
                createdAt INTEGER NOT NULL,
                deadline INTEGER NOT NULL,
                paid INTEGER DEFAULT 0
            )
        `).run();
        console.log('[DB] Таблица pending_payments проверена/создана');
    } catch (err) {
        console.error('[DB] Ошибка при создании pending_payments:', err);
    }

    // ---- Создание таблицы overdue, если её нет ----
    try {
        db.prepare(`
            CREATE TABLE IF NOT EXISTS overdue (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                debtorName TEXT NOT NULL,
                amount INTEGER NOT NULL,
                deadline INTEGER NOT NULL,
                createdAt INTEGER NOT NULL,
                resolved INTEGER DEFAULT 0
            )
        `).run();
        console.log('[DB] Таблица overdue проверена/создана');
    } catch (err) {
        console.error('[DB] Ошибка при создании overdue:', err);
    }

    // ---- Создание таблицы critical_overdue, если её нет ----
    try {
        db.prepare(`
            CREATE TABLE IF NOT EXISTS critical_overdue (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                debtorName TEXT NOT NULL,
                amount INTEGER NOT NULL,
                deadline INTEGER NOT NULL,
                createdAt INTEGER NOT NULL,
                resolved INTEGER DEFAULT 0
            )
        `).run();
        console.log('[DB] Таблица critical_overdue проверена/создана');
    } catch (err) {
        console.error('[DB] Ошибка при создании critical_overdue:', err);
    }

    // ---- Создание таблицы paid_markers для отметок оплаты ----
    try {
        db.prepare(`
            CREATE TABLE IF NOT EXISTS paid_markers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                debtorName TEXT NOT NULL,
                contractTitle TEXT NOT NULL,
                amount INTEGER NOT NULL,
                markedBy TEXT NOT NULL,
                createdAt INTEGER NOT NULL
            )
        `).run();
        console.log('[DB] Таблица paid_markers проверена/создана');
    } catch (err) {
        console.error('[DB] Ошибка при создании paid_markers:', err);
    }

    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });

    const treasury = db.prepare('SELECT balance FROM treasury WHERE id = 1').get();
    const debtorsList = db.prepare('SELECT name, amount FROM debtors').all();
    const totalClosed = db.prepare('SELECT COUNT(*) as count FROM contract_history').get();
    const activeCount = db.prepare('SELECT COUNT(*) as count FROM active_contracts').get();

    let logMsg = `\n🚀 Бот ${client.user.tag} запущен!\n📊 --- СТАТИСТИКА БОТА ---\n`;
    logMsg += `💰 Баланс казны: ${(treasury?.balance || 0).toLocaleString()} $\n`;
    logMsg += `👥 Должники (${debtorsList.length} чел.):\n`;
    debtorsList.forEach(d => { logMsg += `   • ${d.name}: ${d.amount.toLocaleString()} $\n`; });
    logMsg += `📦 Закрыто контрактов: ${totalClosed?.count || 0}\n`;
    logMsg += `⏳ Активных контрактов: ${activeCount.count || 0}\n`;

    // Добавляем список активных контрактов с названиями
    const activeContractsForLog = db.prepare('SELECT * FROM active_contracts').all();
    if (activeContractsForLog.length > 0) {
        logMsg += `📋 Список активных контрактов:\n`;
        for (const contract of activeContractsForLog) {
            try {
                const channel = await client.channels.fetch(contract.channelId);
                const targetMsg = await channel.messages.fetch(contract.msgId);
                const title = targetMsg.embeds[0]?.title || 'Без названия';
                logMsg += `   • **${title}** (ID: ${contract.msgId})\n`;
            } catch (e) {
                logMsg += `   • ID: ${contract.msgId} (сообщение недоступно)\n`;
            }
        }
    } else {
        logMsg += `   (нет активных контрактов)\n`;
    }

    // ---- Ожидающие оплаты ----
    const pendingPayments = db.prepare('SELECT title, creatorId, totalAmount, deadline, paymentMsgId, contractMsgId FROM pending_payments WHERE paid = 0').all();
    if (pendingPayments.length > 0) {
        logMsg += `💳 Ожидают оплаты (${pendingPayments.length}):\n`;
        const details = await getPendingDetails(pendingPayments);
        logMsg += details;
    } else {
        logMsg += `💳 Ожидающих оплаты: нет\n`;
    }

    // ---- Просрочки ----
    const overdueStr = formatOverdue('overdue', '⏰ Просрочки');
    if (overdueStr) logMsg += overdueStr;

    // ---- Критические просрочки ----
    const criticalStr = formatOverdue('critical_overdue', '🔥 Критические просрочки');
    if (criticalStr) logMsg += criticalStr;

    logMsg += `--------------------------`;
    console.log(logMsg);

    const activeContracts = db.prepare('SELECT * FROM active_contracts').all();
    for (const contract of activeContracts) {
        try {
            const channel = await client.channels.fetch(contract.channelId);
            if (Date.now() >= contract.endTime) {
                await channel.send(`⚠️ **ВРЕМЯ КОНТРАКТА ВЫШЛО!** <@${contract.creatorId}>, проверьте и закройте контракт после того как он завершится в игре!`);
                db.prepare('DELETE FROM active_contracts WHERE msgId = ?').run(contract.msgId);
            } else {
                setupTimer(channel, contract.creatorId, contract.endTime);
                console.log(`[TIMER] Восстановлен таймер для контракта ${contract.msgId}`);
            }
        } catch (err) { console.error(`Ошибка восстановления контракта ${contract.msgId}:`, err); }
    }

    // ---- Админ-панель ----
    if (process.env.ADMIN_PICK) {
        try {
            const adminChannel = await client.channels.fetch(process.env.ADMIN_PICK);
            if (!adminChannel) {
                console.error('[ERROR] Канал ADMIN_PICK не найден');
                return;
            }
            const messages = await adminChannel.messages.fetch({ limit: 10 });
            const existingMsg = messages.find(m =>
                m.author.id === client.user.id &&
                m.embeds.length > 0 &&
                m.embeds[0].title === 'Админ-панель'
            );
            if (!existingMsg) {
                const adminEmbed = new EmbedBuilder()
                    .setTitle('Админ-панель')
                    .setDescription('Используйте кнопку ниже, чтобы создать контракт от имени другого игрока.')
                    .setColor(0xFFA500)
                    .setFooter({ text: 'Доступно только для администраторов' });
                await adminChannel.send({
                    embeds: [adminEmbed],
                    components: [
                        new ActionRowBuilder().addComponents(
                            new ButtonBuilder()
                                .setCustomId('start_admin')
                                .setLabel('Создать контракт для игрока')
                                .setStyle(ButtonStyle.Success)
                        )
                    ]
                });
                console.log('[INFO] Админ-панель отправлена в канал');
            } else {
                console.log('[INFO] Админ-панель уже существует');
            }
        } catch (err) {
            console.error('[ERROR] Не удалось отправить админ-панель:', err);
        }
    } else {
        console.log('[INFO] ADMIN_PICK не задан, админ-панель пропущена.');
    }
});

client.on('messageCreate', async msg => {
    if (msg.author.bot) return;
    // --- АДМИН КОМАНДЫ ---
    if (msg.content.startsWith('!импорт_контракт') || msg.content.startsWith('!закрыть_контракт') || msg.content.startsWith('!список')) {
        const hasRole = msg.member.roles.cache.some(role => CONFIG.ALLOWED_ROLES.includes(role.id));
        if (!hasRole) return await msg.reply('❌ Нет прав.');
        if (msg.content.startsWith('!список')) {
            const activeContracts = db.prepare('SELECT msgId, creatorId, endTime FROM active_contracts').all();
            console.log(`\n📋 АКТИВНЫЕ КОНТРАКТЫ (${activeContracts.length}):`);
            if (activeContracts.length === 0) {
                console.log(' - Активных контрактов нет.');
            } else {
                activeContracts.forEach(c => {
                    const timeLeft = Math.round((c.endTime - Date.now()) / 60000);
                    console.log(` • MsgID: ${c.msgId} | Creator: ${c.creatorId} | Осталось: ${timeLeft > 0 ? timeLeft + ' мин.' : 'Истекло'}`);
                });
            }
            console.log('------------------------------------\n');
            return await msg.reply('✅ Список контрактов выведен в консоль Railway.');
        }
        if (!msg.reference) return await msg.reply('❌ Ответь на сообщение!');
        try {
            const targetMsg = await msg.channel.messages.fetch(msg.reference.messageId);
            if (msg.content.startsWith('!импорт_контракт')) {
                db.prepare('INSERT OR REPLACE INTO active_contracts (msgId, creatorId, endTime, channelId) VALUES (?, ?, ?, ?)')
                    .run(targetMsg.id, targetMsg.author.id, Date.now() + 86400000, targetMsg.channelId);
                await msg.reply('✅ Импортировано.');
            }
            if (msg.content.startsWith('!закрыть_контракт')) {
                db.prepare('DELETE FROM active_contracts WHERE msgId = ?').run(targetMsg.id);
                await targetMsg.edit({ components: [] });
                await msg.reply('✅ Закрыто.');
            }
        } catch (err) { await msg.reply('❌ Ошибка.'); }
        return;
    }

    // ---- Обработка !подтвердить ----
    if (msg.channel.id === CONFIG.PAY && msg.content.trim() === '!подтвердить') {
        const hasRole = msg.member.roles.cache.some(role => CONFIG.ALLOWED_ROLES.includes(role.id));
        if (!hasRole) {
            const reply = await msg.reply('❌ У вас нет прав проверяющего.');
            setTimeout(async () => {
                await msg.delete().catch(() => {});
                await reply.delete().catch(() => {});
            }, 5000);
            return;
        }
        if (!msg.reference || !msg.reference.messageId) {
            const reply = await msg.reply('❌ Ответьте на сообщение с контрактом.');
            setTimeout(async () => {
                await msg.delete().catch(() => {});
                await reply.delete().catch(() => {});
            }, 5000);
            return;
        }

        try {
            const targetMsg = await msg.channel.messages.fetch(msg.reference.messageId);
            if (!targetMsg) {
                const reply = await msg.reply('❌ Сообщение не найдено.');
                setTimeout(async () => {
                    await msg.delete().catch(() => {});
                    await reply.delete().catch(() => {});
                }, 5000);
                return;
            }

            // Проверяем, что это сообщение с платежом
            if (!targetMsg.embeds || targetMsg.embeds.length === 0 || !targetMsg.embeds[0].fields || targetMsg.embeds[0].fields.length === 0) {
                const reply = await msg.reply('❌ Это не сообщение с платежом. Ответьте на сообщение, которое содержит список долгов.');
                setTimeout(async () => {
                    await msg.delete().catch(() => {});
                    await reply.delete().catch(() => {});
                }, 5000);
                return;
            }

            console.log(`[LOG] !подтвердить от ${msg.author.tag}`);
            console.log(`[LOG] Контракт: ${targetMsg.embeds[0]?.title || 'неизвестно'}`);

            // [!] Удаляем отметки об оплате для этого контракта
            const contractTitle = targetMsg.embeds[0]?.title || 'Неизвестный контракт';
            const deletedMarkers = db.prepare('DELETE FROM paid_markers WHERE contractTitle = ?').run(contractTitle);
            if (deletedMarkers.changes > 0) {
                console.log(`[DB] Удалены отметки оплаты для контракта "${contractTitle}" (${deletedMarkers.changes} шт.)`);
            }

            let totalPaid = 0;
            targetMsg.embeds[0].fields.forEach(field => {
                const amount = parseInt(field.value.replace(/\D/g, '')) || 0;
                if (amount > 0) {
                    deductDebt(field.name, amount);
                    const debtor = db.prepare('SELECT amount FROM debtors WHERE name = ?').get(field.name);
                    console.log(`   -> ${field.name}: ${amount.toLocaleString()} $ (Остаток: ${debtor ? debtor.amount.toLocaleString() : 0} $)`);
                    totalPaid += amount;
                }
            });

            db.prepare('DELETE FROM debtors WHERE amount <= 0').run();
            if (totalPaid > 0) db.prepare('UPDATE treasury SET balance = balance + ? WHERE id = 1').run(totalPaid);
            console.log(`[LOG] Итого в казну: ${totalPaid.toLocaleString()} $`);

            // Удаляем запись из pending_payments, если есть
            const paymentMsgId = targetMsg.id;
            const deleted = db.prepare('DELETE FROM pending_payments WHERE paymentMsgId = ?').run(paymentMsgId);
            if (deleted.changes > 0) {
                console.log(`[DB] Удалена запись из pending_payments для сообщения ${paymentMsgId}`);
            }

            // Редактируем или удаляем исходное сообщение с кнопкой
            try {
                await targetMsg.edit({ content: `✅ **Оплата подтверждена! Проверяющий: <@${msg.author.id}>**`, components: [] });
            } catch (editErr) {
                console.warn('Не удалось отредактировать исходное сообщение, удаляем и отправляем подробное подтверждение:', editErr);

                // Формируем подробное сообщение
                const embed = targetMsg.embeds[0];
                const contractTitle2 = embed?.title || 'Неизвестный контракт';
                let details = `📋 **${contractTitle2}**\n`;
                if (embed && embed.fields && embed.fields.length > 0) {
                    embed.fields.forEach(field => {
                        const amountMatch = field.value.match(/([\d, ]+)\s*\$?/);
                        const amount = amountMatch ? amountMatch[1].trim() : '0';
                        details += `• **${field.name}**: ${amount} $\n`;
                    });
                } else {
                    details += '*(данные о платеже отсутствуют)*\n';
                }
                details += `\n✅ **Оплата подтверждена!** Проверяющий: <@${msg.author.id}>`;

                try {
                    await targetMsg.delete();
                } catch (deleteErr) {
                    console.warn('Не удалось удалить исходное сообщение:', deleteErr);
                }
                await msg.channel.send(details);
            }

            // Удаляем сообщение ожидания (если оно есть)
            const pendingMsgId = global.pendingMessages?.get(targetMsg.id);
            if (pendingMsgId) {
                try {
                    const pendingMsg = await msg.channel.messages.fetch(pendingMsgId);
                    if (pendingMsg) {
                        await pendingMsg.delete();
                        console.log(`[DELETE] Удалено сообщение ожидания ${pendingMsgId}`);
                    }
                } catch (err) {
                    console.warn('Не удалось найти/удалить сообщение ожидания:', err);
                }
                global.pendingMessages.delete(targetMsg.id);
            }

            const replyMsg = await msg.reply('✅ Контракт закрыт, долги обновлены.');
            setTimeout(async () => {
                await msg.delete().catch(() => {});
                await replyMsg.delete().catch(() => {});
            }, 5000);

        } catch (err) {
            console.error(err);
            const reply = await msg.reply('❌ Ошибка при поиске сообщения.');
            setTimeout(async () => {
                await msg.delete().catch(() => {});
                await reply.delete().catch(() => {});
            }, 5000);
        }
        return;
    }

    // --------------------- УДАЛЕНИЕ СООБЩЕНИЙ В КАНАЛАХ PICK/PROCESS ---
    if (msg.channel.id === CONFIG.PICK || msg.channel.id === CONFIG.PROCESS) {
        await msg.delete().catch(() => {});
        console.log(`[DELETE] Удалено сообщение от ${msg.author.tag} в #${msg.channel.name}: "${msg.content.substring(0, 50)}"`);
        return;
    }
});

client.on('interactionCreate', async i => {
    try {
        // --- 1. ОБРАБОТКА КОНТЕКСТНОГО МЕНЮ ---
        if (i.isMessageContextMenuCommand()) {
            const hasRole = i.member.roles.cache.some(role => CONFIG.ALLOWED_ROLES.includes(role.id));
            if (!hasRole) return i.reply({ content: '❌ Нет прав.', flags: [MessageFlags.Ephemeral] });

            if (i.commandName === 'Импортировать контракт') {
                const targetMsg = i.targetMessage;
                const mentionMatch = targetMsg.content.match(/<@!?(\d+)>/);
                let creatorId = mentionMatch ? mentionMatch[1] : targetMsg.author.id;

                db.prepare('INSERT OR REPLACE INTO active_contracts (msgId, creatorId, endTime, channelId) VALUES (?, ?, ?, ?)')
                    .run(targetMsg.id, creatorId, Date.now() + 86400000, targetMsg.channelId);
                return i.reply({ content: '✅ Импортировано.', flags: [MessageFlags.Ephemeral] });
            }

            if (i.commandName === 'Закрыть контракт') {
                await i.deferReply({ flags: [MessageFlags.Ephemeral] });
                const msgId = i.targetMessage.id;
                const contract = db.prepare('SELECT creatorId, channelId FROM active_contracts WHERE msgId = ?').get(msgId);
                if (!contract) {
                    return i.editReply({ content: '❌ Контракт не найден или уже закрыт.' });
                }

                const oldEmbed = i.targetMessage.embeds[0];
                if (!oldEmbed) {
                    return i.editReply({ content: '❌ Это не сообщение с контрактом.' });
                }

                const timeField = oldEmbed.fields.find(f => f.name === 'Конец');
                if (timeField) {
                    const timestampMatch = timeField.value.match(/<t:(\d+):R>/);
                    if (timestampMatch) {
                        const endTime = parseInt(timestampMatch[1]) * 1000;
                        if (Date.now() < endTime) {
                            return i.editReply({ content: '❌ Рано! Таймер ещё не истёк.' });
                        }
                    }
                }

                db.prepare('DELETE FROM active_contracts WHERE msgId = ?').run(msgId);

                // [!] Удаляем отметки об оплате для этого контракта
                const deletedMarkers = db.prepare('DELETE FROM paid_markers WHERE contractTitle = ?').run(oldEmbed.title);
                if (deletedMarkers.changes > 0) {
                    console.log(`[DB] Удалены отметки оплаты для контракта "${oldEmbed.title}" (${deletedMarkers.changes} шт.)`);
                }

                db.prepare('INSERT INTO contract_history (msgId, title, status, closedAt) VALUES (?, ?, ?, ?)')
                    .run(msgId, oldEmbed.title, 'closed', Date.now());
                console.log(`[HISTORY] Контракт "${oldEmbed.title}" закрыт (msgId: ${msgId})`);

                try {
                    const recentMessages = await i.targetMessage.channel.messages.fetch({ limit: 20 });
                    const timerMsg = recentMessages.find(m => m.author.id === client.user.id && m.content.includes('ВРЕМЯ ВЫШЛО'));
                    if (timerMsg) await timerMsg.delete();
                } catch (err) { /* игнорируем */ }

                const participants = oldEmbed.fields.filter(f => f.name !== 'Конец' && f.name !== 'ИНСТРУКЦИЯ');
                const multiplier = participants.length >= 2 ? 0.5 : 0.5;

                console.log(`[LOG] Контракт "${oldEmbed.title}" закрыт как УСПЕХ пользователем ${i.user.tag}`);
                participants.forEach(f => console.log(`   -> ${f.name}: ${f.value}`));

                // [!] Формируем пинги для исполнителей
                const participantNames = participants.map(f => f.name);
                const membersInfo = getMembersInfo(participantNames);
                const executorMentions = membersInfo.mentions.join(' ');

                const payEmbed = new EmbedBuilder()
                    .setTitle(oldEmbed.title)
                    .setColor(0x00FF00)
                    .setDescription(
                        `**Исполнитель:** <@${contract.creatorId}>\n\n` +
                        `<@${contract.creatorId}>, внесите сумму в казну и приложите скриншот, после нажмите кнопку **Оплатить**\n` +
                        `**Проверяющий:** после оплаты ответьте на это сообщение командой \`!подтвердить\`\n` +
                        `**Оплатить нужно в течении 72 часов**`
                    );

                let totalPayAmount = 0;
                participants.forEach(f => {
                    const toPay = Math.round((parseInt(f.value.replace(/\D/g, '')) || 0) * 1000 * multiplier);
                    totalPayAmount += toPay;
                    db.prepare('INSERT OR REPLACE INTO debtors (name, amount) VALUES (?, IFNULL((SELECT amount FROM debtors WHERE name = ?), 0) + ?)')
                        .run(f.name, f.name, toPay);
                    payEmbed.addFields({ name: f.name, value: `${toPay.toLocaleString()} $` });
                });

                try {
                    await i.targetMessage.edit({
                        content: `✅ Статус: **УСПЕХ ✅**`,
                        components: [],
                        embeds: [EmbedBuilder.from(oldEmbed).setColor(0x00FF00)]
                    });
                } catch (editErr) {
                    console.warn('Не удалось отредактировать исходное сообщение, удаляем и отправляем новое:', editErr);
                    try {
                        await i.targetMessage.delete();
                    } catch (deleteErr) {
                        console.warn('Не удалось удалить исходное сообщение:', deleteErr);
                    }
                    await i.channel.send({
                        content: `✅ Статус: **УСПЕХ ✅**`,
                        embeds: [EmbedBuilder.from(oldEmbed).setColor(0x00FF00)]
                    });
                }

                const payChannel = await client.channels.fetch(CONFIG.PAY);
                if (payChannel) {
                    // [!] Формируем пинги: роли | пикающий | исполнители
                    const rolePings = CONFIG.ALLOWED_ROLES.map(r => `<@&${r}>`).join(' ');
                    let pingContent = rolePings + ` | <@${contract.creatorId}>`;
                    if (executorMentions) {
                        pingContent += ` | Исполнители: ${executorMentions}`;
                    }

                    const payMsg = await payChannel.send({
                        content: pingContent,
                        embeds: [payEmbed],
                        components: [new ActionRowBuilder().addComponents(
                            new ButtonBuilder().setCustomId('pay_confirm').setLabel('Оплатить').setStyle(ButtonStyle.Success)
                        )]
                    });
                    db.prepare(`
                        INSERT INTO pending_payments 
                        (contractMsgId, paymentMsgId, creatorId, title, totalAmount, createdAt, deadline)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                    `).run(
                        msgId,
                        payMsg.id,
                        contract.creatorId,
                        oldEmbed.title,
                        totalPayAmount,
                        Date.now(),
                        Date.now() + 72 * 60 * 60 * 1000
                    );
                    console.log(`[DB] Добавлен в ожидающие: ${oldEmbed.title}`);
                }

                await i.editReply({ content: '✅ Контракт закрыт как УСПЕХ.' });
                return;
            }

            if (i.commandName === 'Напомнить о закрытии') {
                await i.deferReply({ flags: [MessageFlags.Ephemeral] });
                const targetMsg = i.targetMessage;

                let contractName = 'Контракт';
                if (targetMsg.embeds && targetMsg.embeds.length > 0 && targetMsg.embeds[0].title) {
                    contractName = targetMsg.embeds[0].title;
                }

                const mentionMatch = targetMsg.content.match(/<@!?(\d+)>/);
                let creatorId = mentionMatch ? mentionMatch[1] : null;
                if (!creatorId) {
                    const contractFromDb = db.prepare('SELECT creatorId FROM active_contracts WHERE msgId = ?').get(targetMsg.id);
                    if (contractFromDb) creatorId = contractFromDb.creatorId;
                }
                if (!creatorId) {
                    return i.editReply({ content: '❌ Не удалось определить создателя контракта.' });
                }

                const contract = db.prepare('SELECT channelId FROM active_contracts WHERE msgId = ?').get(targetMsg.id);
                if (!contract) {
                    return i.editReply({ content: '❌ Контракт не найден или уже закрыт.' });
                }

                try {
                    await targetMsg.reply(
                        `⚠️ **НАПОМИНАНИЕ!** Контракт **«${contractName}»** (ID: ${targetMsg.id}) уже должен быть закрыт. ` +
                        `<@${creatorId}>, проверьте и закройте контракт!`
                    );
                    await i.editReply({ content: '✅ Напоминание отправлено.' });
                } catch (err) {
                    console.error('Ошибка отправки напоминания:', err);
                    await i.editReply({ content: '❌ Не удалось отправить напоминание.' });
                }
                return;
            }

            if (i.commandName === 'Принудительно оплатить') {
                await i.deferReply({ flags: [MessageFlags.Ephemeral] });
                const targetMsg = i.targetMessage;

                if (!targetMsg.embeds || targetMsg.embeds.length === 0 || !targetMsg.embeds[0].fields || targetMsg.embeds[0].fields.length === 0) {
                    return i.editReply({ content: '❌ Это не сообщение с платежом. Должен быть embed со списком долгов.' });
                }

                const embed = targetMsg.embeds[0];
                const contractTitle = embed?.title || 'Неизвестный контракт';

                console.log(`[LOG] Принудительная оплата от ${i.user.tag} для контракта "${contractTitle}"`);

                // Формируем список участников и сумм ДО списания
                const participants = [];
                let totalPaid = 0;
                embed.fields.forEach(field => {
                    const amount = parseInt(field.value.replace(/\D/g, '')) || 0;
                    if (amount > 0) {
                        participants.push({ name: field.name, amount: amount });
                        totalPaid += amount;
                    }
                });

                if (participants.length === 0) {
                    return i.editReply({ content: '❌ Нет сумм для оплаты.' });
                }

                // Списываем только из debtors (как !подтвердить)
                participants.forEach(p => {
                    deductDebt(p.name, p.amount);
                    const debtor = db.prepare('SELECT amount FROM debtors WHERE name = ?').get(p.name);
                    console.log(`   -> ${p.name}: ${p.amount.toLocaleString()} $ (Остаток: ${debtor ? debtor.amount.toLocaleString() : 0} $)`);
                });

                db.prepare('DELETE FROM debtors WHERE amount <= 0').run();
                if (totalPaid > 0) db.prepare('UPDATE treasury SET balance = balance + ? WHERE id = 1').run(totalPaid);
                console.log(`[LOG] Принудительно оплачено: ${totalPaid.toLocaleString()} $`);

                // Удаляем запись из pending_payments
                db.prepare('DELETE FROM pending_payments WHERE paymentMsgId = ?').run(targetMsg.id);
                // Удаляем сообщение ожидания, если есть
                const pendingMsgId = global.pendingMessages?.get(targetMsg.id);
                if (pendingMsgId) {
                    try {
                        const pendingMsg = await i.channel.messages.fetch(pendingMsgId);
                        if (pendingMsg) {
                            await pendingMsg.delete();
                            console.log(`[DELETE] Удалено сообщение ожидания ${pendingMsgId}`);
                        }
                    } catch (err) {
                        console.warn('Не удалось найти/удалить сообщение ожидания:', err);
                    }
                    global.pendingMessages.delete(targetMsg.id);
                }

                // Формируем подробное сообщение с информацией о контракте
                let details = `📋 **${contractTitle}**\n`;
                participants.forEach(p => {
                    details += `• **${p.name}**: ${p.amount.toLocaleString()} $\n`;
                });
                details += `\n✅ **Оплата подтверждена принудительно!** Проверяющий: <@${i.user.id}>`;

                // Пытаемся отредактировать исходное сообщение
                try {
                    await targetMsg.edit({ content: details, components: [] });
                } catch (editErr) {
                    console.warn('Не удалось отредактировать исходное сообщение, удаляем и отправляем новое:', editErr);
                    try {
                        await targetMsg.delete();
                    } catch (deleteErr) {
                        console.warn('Не удалось удалить исходное сообщение:', deleteErr);
                    }
                    await i.channel.send(details);
                }

                await i.editReply({ content: `✅ Оплата по контракту **"${contractTitle}"** проведена принудительно. Сумма: ${totalPaid.toLocaleString()} $` });
                return;
            }

            if (i.commandName === 'Импортировать оплату') {
                await i.deferReply({ flags: [MessageFlags.Ephemeral] });
                const targetMsg = i.targetMessage;

                if (!targetMsg.embeds || targetMsg.embeds.length === 0 || !targetMsg.embeds[0].fields || targetMsg.embeds[0].fields.length === 0) {
                    return i.editReply({ content: '❌ Это не сообщение с платежом. Должен быть embed со списком долгов.' });
                }

                const embed = targetMsg.embeds[0];
                const contractTitle = embed?.title || 'Неизвестный контракт';

                const mentionMatch = targetMsg.content.match(/<@!?(\d+)>/);
                let creatorId = mentionMatch ? mentionMatch[1] : null;
                if (!creatorId) {
                    const contractFromDb = db.prepare('SELECT creatorId FROM active_contracts WHERE msgId = ?').get(targetMsg.id);
                    if (contractFromDb) creatorId = contractFromDb.creatorId;
                }
                if (!creatorId) {
                    return i.editReply({ content: '❌ Не удалось определить создателя контракта.' });
                }

                const existing = db.prepare('SELECT 1 FROM pending_payments WHERE paymentMsgId = ?').get(targetMsg.id);
                if (existing) {
                    return i.editReply({ content: '⚠️ Запись об оплате уже существует в БД.' });
                }

                let totalAmount = 0;
                embed.fields.forEach(field => {
                    const amount = parseInt(field.value.replace(/\D/g, '')) || 0;
                    totalAmount += amount;
                });

                db.prepare(`
                    INSERT INTO pending_payments 
                    (contractMsgId, paymentMsgId, creatorId, title, totalAmount, createdAt, deadline)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `).run(
                    targetMsg.id,
                    targetMsg.id,
                    creatorId,
                    contractTitle,
                    totalAmount,
                    Date.now(),
                    Date.now() + 72 * 60 * 60 * 1000
                );

                console.log(`[DB] Импортирована оплата для контракта "${contractTitle}" (paymentMsgId: ${targetMsg.id})`);
                await i.editReply({ content: `✅ Запись об оплате для контракта "${contractTitle}" добавлена в ожидающие.` });
                return;
            }
        }

        // --- 2. ОБРАБОТКА СЛЭШ-КОМАНД ---
        if (i.isChatInputCommand()) {
            console.log(`[LOG] /${i.commandName} от ${i.user.tag}`);

            if (i.commandName !== 'ожидают') {
                const hasRole = i.member.roles.cache.some(role => CONFIG.ALLOWED_ROLES.includes(role.id));
                if (!hasRole) return i.reply({ content: '❌ Нет прав.', flags: [MessageFlags.Ephemeral] });
            }

            if (i.commandName === 'контракт_список') {
                const activeContracts = db.prepare('SELECT msgId, channelId FROM active_contracts').all();
                if (activeContracts.length === 0) {
                    return i.reply({ content: '📋 Активных контрактов нет.', flags: [MessageFlags.Ephemeral] });
                }
                let text = `📋 **АКТИВНЫЕ КОНТРАКТЫ (${activeContracts.length}):**\n\n`;
                for (const c of activeContracts) {
                    try {
                        const channel = await client.channels.fetch(c.channelId);
                        const targetMsg = await channel.messages.fetch(c.msgId);
                        const title = targetMsg.embeds[0]?.title || 'Без названия';
                        text += ` • **${title}** | ID: ${c.msgId}\n`;
                    } catch (e) {
                        text += ` • ID: ${c.msgId} (Сообщение недоступно)\n`;
                    }
                }
                return i.reply({ content: text, flags: [MessageFlags.Ephemeral] });
            }

            if (i.commandName === 'казна') {
                const row = db.prepare('SELECT balance FROM treasury WHERE id = 1').get();
                return i.reply({ content: `💰 Баланс: **${(row?.balance || 0).toLocaleString()} $**`, flags: [MessageFlags.Ephemeral] });
            }

            if (i.commandName === 'должники') {
                const debtors = db.prepare('SELECT * FROM debtors').all();
                const text = debtors.length ? debtors.map(d => `• **${d.name}**: ${d.amount.toLocaleString()}$`).join('\n') : 'Должников нет.';
                return i.reply({ content: `📋 **Список должников:**\n${text}`, flags: [MessageFlags.Ephemeral] });
            }

            if (i.commandName === 'вызвать') {
                if (i.channelId !== CONFIG.PICK) return i.reply({ content: '❌ Только в канале пика!', flags: [MessageFlags.Ephemeral] });
                return i.reply({
                    content: "Правила работы с контрактами Minoru\nУважаемые<@&1373750905274630275><@&1373750899649806449><@&1392858292925108254>, ознакомьтесь с правилами работы. Вы обязаны следить за каналами <#1526654909452390531> и <#1403074323614404738> на наличие вашего никнейма.\n\n1. 📝 Создание контракта 📝\nПосле того как вы взяли контракт в игре, нажмите кнопку [Создать контракт] под этим сообщением.\nВ открывшейся панели заполните все необходимые данные по контракту.\n2. ⚖️ Процентные ставки ⚖️\n**Соло-контракт:** 40% (успех)\n**Группа (2+ человека):** 20% (успех).\nНа контракты пикнутые не в 100% сразу будет налогаться штраф в виде фиксированной суммы 40.000$ В случае успеха контракта, будет все так-же процентно для соло или группы.\n3. 💰 Оплата и штрафы 💰\n**Скриншот:** Присылается в обязательном порядке.\n**Срок оплаты:** 72 часа с момента создания контракта.\n**Просрочка (72ч+):** Сумма увеличивается в 1.25 раза. На оплату этой суммы дается еще 48 часов.\n**Критическая просрочка (120ч+):** Накладывается «мороз» на 48 часов + сумма еще увеличивается в 1.25 раза. Если оплата не поступит в этот срок — АФК-ранг до погашения долга.\n4. ⚠️ Регистрация контрактов ⚠️\nРегистрация контракта **обязательна**. Если контракт завершен, а данных о нем нет в канале — на игрока накладывается штраф: 30% от полученной суммы.\nЕсли у вас вдруг не видно канала <#1526654909452390531> То можно нажать на его название в этом канале и перейти.\n\nПо всем вопросам обращаться к: <@702529657718833162>",
                    components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('start').setLabel('Создать контракт').setStyle(ButtonStyle.Primary))]
                });
            }

            if (i.commandName === 'удалить_контракт') {
                const msgId = i.options.getString('msgid');
                const result = db.prepare('DELETE FROM active_contracts WHERE msgId = ?').run(msgId);
                if (result.changes > 0) {
                    await i.reply({ content: `✅ Контракт с ID \`${msgId}\` успешно удалён из БД.`, flags: [MessageFlags.Ephemeral] });
                    console.log(`[LOG] /удалить_контракт ${msgId} от ${i.user.tag}`);
                } else {
                    await i.reply({ content: `❌ Контракт с ID \`${msgId}\` не найден.`, flags: [MessageFlags.Ephemeral] });
                }
                return;
            }

            if (i.commandName === 'чек_контракты') {
                const activeContracts = db.prepare('SELECT * FROM active_contracts').all();
                for (const contract of activeContracts) {
                    const channel = await client.channels.fetch(contract.channelId);
                    setupTimer(channel, contract.creatorId, contract.endTime);
                }
                return i.reply({ content: `✅ Проверено: ${activeContracts.length}`, flags: [MessageFlags.Ephemeral] });
            }

            // ---- Обработка команды /внести_оплату ----
            if (i.commandName === 'внести_оплату') {
                const title = i.options.getString('название');
                const amount = i.options.getInteger('сумма');
                const participants = i.options.getString('участники');
                
                // Проверяем, что сумма положительная
                if (amount <= 0) {
                    return i.reply({ content: '❌ Сумма должна быть больше 0.', flags: [MessageFlags.Ephemeral] });
                }
                
                // Проверяем участников
                const names = participants.split(';').filter(n => n.trim());
                if (names.length === 0) {
                    return i.reply({ content: '❌ Укажите хотя бы одного участника.', flags: [MessageFlags.Ephemeral] });
                }
                
                // Создаём запись оплаты
                const paymentId = addManualPayment(title, amount, participants, i.user.id);
                
                // Формируем embed для отображения в /ожидают
                const embed = new EmbedBuilder()
                    .setTitle(title)
                    .setColor(0x00FF00)
                    .setDescription(
                        `**Исполнитель:** <@${i.user.id}>\n\n` +
                        `💰 **Сумма:** ${amount.toLocaleString()} $\n` +
                        `👥 **Участники:**\n${names.map(n => `   • ${n}`).join('\n')}\n\n` +
                        `⏳ **Ожидает оплаты...**\n` +
                        `📌 **Статус:** ⏳ Ожидание`
                    )
                    .setFooter({ text: `ID: ${paymentId} | Создано: ${new Date().toLocaleString()}` });
                
                // Отправляем сообщение в канал оплаты
                const payChannel = await client.channels.fetch(CONFIG.PAY);
                if (payChannel) {
                    const rolePings = CONFIG.ALLOWED_ROLES.map(r => `<@&${r}>`).join(' ');
                    const msg = await payChannel.send({
                        content: `${rolePings} | <@${i.user.id}>`,
                        embeds: [embed],
                        components: [new ActionRowBuilder().addComponents(
                            new ButtonBuilder()
                                .setCustomId(`manual_pay_${paymentId}`)
                                .setLabel('✅ Оплачено')
                                .setStyle(ButtonStyle.Success)
                        )]
                    });
                    
                    // Обновляем paymentMsgId в БД
                    db.prepare('UPDATE pending_payments SET paymentMsgId = ? WHERE contractMsgId = ?')
                        .run(msg.id, `manual_${paymentId}`);
                }
                
                await i.reply({ 
                    content: `✅ Оплата по контракту **"${title}"** на сумму ${amount.toLocaleString()} $ внесена!`,
                    flags: [MessageFlags.Ephemeral] 
                });
                return;
            }

            // ---- Обработка команды /отметить_оплачено (ТОЛЬКО отметка, БЕЗ списания) ----
            if (i.commandName === 'отметить_оплачено') {
                const nick = i.options.getString('ник');
                const contractTitle = i.options.getString('контракт');
                const amount = i.options.getInteger('сумма');
                
                // Проверяем, есть ли уже отметка для этого контракта и должника
                const existing = db.prepare(`
                    SELECT 1 FROM paid_markers 
                    WHERE debtorName = ? AND contractTitle = ? AND amount = ?
                `).get(nick, contractTitle, amount);
                
                if (existing) {
                    return i.reply({ 
                        content: `⚠️ Для **${nick}** по контракту **"${contractTitle}"** на сумму ${amount.toLocaleString()} $ уже есть отметка об оплате.`,
                        flags: [MessageFlags.Ephemeral] 
                    });
                }
                
                // Добавляем только отметку, НЕ списываем из debtors
                db.prepare(`
                    INSERT INTO paid_markers (debtorName, contractTitle, amount, markedBy, createdAt)
                    VALUES (?, ?, ?, ?, ?)
                `).run(nick, contractTitle, amount, i.user.id, Date.now());
                
                // [!] НЕ СПИСЫВАЕМ! Только отметка
                // deductDebt(nick, amount); // <-- УБРАНО!
                
                await i.reply({ 
                    content: `✅ Отметка об оплате для **${nick}** по контракту **"${contractTitle}"** на сумму ${amount.toLocaleString()} $ добавлена!`,
                    flags: [MessageFlags.Ephemeral] 
                });
                return;
            }

            // ---- Обработка команды /убрать_отметку ----
            if (i.commandName === 'убрать_отметку') {
                const nick = i.options.getString('ник');
                const contractTitle = i.options.getString('контракт');
                const amount = i.options.getInteger('сумма');
                
                // Проверяем, есть ли отметка
                const existing = db.prepare(`
                    SELECT 1 FROM paid_markers 
                    WHERE debtorName = ? AND contractTitle = ? AND amount = ?
                `).get(nick, contractTitle, amount);
                
                if (!existing) {
                    return i.reply({ 
                        content: `❌ Отметка для **${nick}** по контракту **"${contractTitle}"** на сумму ${amount.toLocaleString()} $ не найдена.`,
                        flags: [MessageFlags.Ephemeral] 
                    });
                }
                
                // Удаляем отметку
                db.prepare(`
                    DELETE FROM paid_markers 
                    WHERE debtorName = ? AND contractTitle = ? AND amount = ?
                `).run(nick, contractTitle, amount);
                
                await i.reply({ 
                    content: `✅ Отметка об оплате для **${nick}** по контракту **"${contractTitle}"** на сумму ${amount.toLocaleString()} $ удалена.`,
                    flags: [MessageFlags.Ephemeral] 
                });
                return;
            }

            if (['пополнить', 'вычесть', 'долг_добавить', 'оплачено', 'оплачено_просрочка', 'оплачено_крит'].includes(i.commandName)) {
                const amt = i.options.getInteger('сумма') || 0;
                const nick = i.options.getString('ник') || '';
                
                if (i.commandName === 'пополнить') {
                    db.prepare('UPDATE treasury SET balance = balance + ? WHERE id = 1').run(amt);
                    console.log(`[LOG] /пополнить: +${amt} $ (казну пополнил ${i.user.tag})`);
                    return i.reply({ content: `✅ Пополнено на ${amt.toLocaleString()} $`, flags: [MessageFlags.Ephemeral] });
                }
                
                if (i.commandName === 'вычесть') {
                    const currentBalance = db.prepare('SELECT balance FROM treasury WHERE id = 1').get().balance || 0;
                    if (amt > currentBalance) {
                        return i.reply({ content: `❌ Недостаточно средств. Доступно: ${currentBalance.toLocaleString()} $`, flags: [MessageFlags.Ephemeral] });
                    }
                    db.prepare('UPDATE treasury SET balance = balance - ? WHERE id = 1').run(amt);
                    console.log(`[LOG] /вычесть: -${amt} $ (списал ${i.user.tag})`);
                    return i.reply({ content: `✅ Списано ${amt.toLocaleString()} $`, flags: [MessageFlags.Ephemeral] });
                }
                
                if (i.commandName === 'долг_добавить') {
                    db.prepare('INSERT OR REPLACE INTO debtors (name, amount) VALUES (?, ?)').run(nick, amt);
                    console.log(`[LOG] /долг_добавить: ${nick} +${amt} $ (добавил ${i.user.tag})`);
                    return i.reply({ content: '✅ Выполнено.', flags: [MessageFlags.Ephemeral] });
                }
                
                if (i.commandName === 'оплачено') {
                    deductDebt(nick, amt);
                    console.log(`[LOG] /оплачено: ${nick} -${amt} $ (закрыл ${i.user.tag})`);
                    return i.reply({ content: '✅ Обычный долг оплачен.', flags: [MessageFlags.Ephemeral] });
                }
                
                if (i.commandName === 'оплачено_просрочка') {
                    deductOverdue(nick, amt);
                    console.log(`[LOG] /оплачено_просрочка: ${nick} -${amt} $ (закрыл ${i.user.tag})`);
                    return i.reply({ content: '✅ Просрочка оплачена.', flags: [MessageFlags.Ephemeral] });
                }
                
                if (i.commandName === 'оплачено_крит') {
                    deductCritical(nick, amt);
                    console.log(`[LOG] /оплачено_крит: ${nick} -${amt} $ (закрыл ${i.user.tag})`);
                    return i.reply({ content: '✅ Критическая просрочка оплачена.', flags: [MessageFlags.Ephemeral] });
                }
            }

            if (i.commandName === 'статистика') {
                const treasury = db.prepare('SELECT balance FROM treasury WHERE id = 1').get();
                const debtorsList = db.prepare('SELECT name, amount FROM debtors').all();
                const totalClosed = db.prepare('SELECT COUNT(*) as count FROM contract_history').get();
                const activeCount = db.prepare('SELECT COUNT(*) as count FROM active_contracts').get();

                let logMsg = `\n📊 --- СТАТИСТИКА БОТА (запрос от ${i.user.tag}) ---\n`;
                logMsg += `💰 Баланс казны: ${(treasury?.balance || 0).toLocaleString()} $\n`;
                logMsg += `👥 Должники (${debtorsList.length} чел.):\n`;
                debtorsList.forEach(d => { logMsg += `   • ${d.name}: ${d.amount.toLocaleString()} $\n`; });
                logMsg += `📦 Закрыто контрактов: ${totalClosed?.count || 0}\n`;
                logMsg += `⏳ Активных контрактов: ${activeCount.count || 0}\n`;

                const activeContracts = db.prepare('SELECT * FROM active_contracts').all();
                if (activeContracts.length > 0) {
                    logMsg += `📋 Список активных контрактов:\n`;
                    for (const contract of activeContracts) {
                        try {
                            const channel = await client.channels.fetch(contract.channelId);
                            const targetMsg = await channel.messages.fetch(contract.msgId);
                            const title = targetMsg.embeds[0]?.title || 'Без названия';
                            logMsg += `   • **${title}** (ID: ${contract.msgId})\n`;
                        } catch (e) {
                            logMsg += `   • ID: ${contract.msgId} (сообщение недоступно)\n`;
                        }
                    }
                } else {
                    logMsg += `   (нет активных контрактов)\n`;
                }

                const pendingPayments = db.prepare('SELECT title, creatorId, totalAmount, deadline, paymentMsgId, contractMsgId FROM pending_payments WHERE paid = 0').all();
                if (pendingPayments.length > 0) {
                    logMsg += `💳 Ожидают оплаты (${pendingPayments.length}):\n`;
                    const details = await getPendingDetails(pendingPayments);
                    logMsg += details;
                } else {
                    logMsg += `💳 Ожидающих оплаты: нет\n`;
                }

                const overdueStr = formatOverdue('overdue', '⏰ Просрочки');
                if (overdueStr) logMsg += overdueStr;

                const criticalStr = formatOverdue('critical_overdue', '🔥 Критические просрочки');
                if (criticalStr) logMsg += criticalStr;

                logMsg += `--------------------------`;
                console.log(logMsg);
                return i.reply({ content: '✅ Статистика выведена в логи.', flags: [MessageFlags.Ephemeral] });
            }

            // ---- ОБНОВЛЁННАЯ КОМАНДА /ожидают (с зачёркиванием при полной оплате) ----
            if (i.commandName === 'ожидают') {
                let text = `📋 **Ожидают оплаты**\n\n`;

                // 1. Ожидающие оплаты из pending_payments (контракты)
                const pending = db.prepare(`
                    SELECT title, creatorId, totalAmount, deadline, paymentMsgId, contractMsgId
                    FROM pending_payments
                    WHERE paid = 0
                `).all();
                if (pending.length > 0) {
                    const details = await getPendingDetails(pending);
                    text += details;
                } else {
                    text += '💳 Ожидающих оплаты: нет\n\n';
                }

                // 2. Собираем всех должников из всех таблиц
                const allDebtors = new Map();
                
                // debtors
                const debtors = db.prepare('SELECT name, amount FROM debtors WHERE amount > 0').all();
                debtors.forEach(d => {
                    if (!allDebtors.has(d.name)) {
                        allDebtors.set(d.name, { debtors: 0, overdue: 0, critical: 0, paidMarkers: [] });
                    }
                    allDebtors.get(d.name).debtors = d.amount;
                });
                
                // [!] Получаем отметки об оплате
                const paidMarkers = db.prepare(`
                    SELECT debtorName, contractTitle, amount FROM paid_markers
                `).all();
                
                // overdue
                const overdueRecords = db.prepare('SELECT debtorName, amount FROM overdue WHERE resolved = 0').all();
                overdueRecords.forEach(d => {
                    if (!allDebtors.has(d.debtorName)) {
                        allDebtors.set(d.debtorName, { debtors: 0, overdue: 0, critical: 0, paidMarkers: [] });
                    }
                    allDebtors.get(d.debtorName).overdue += d.amount;
                });
                
                // critical_overdue
                const criticalRecords = db.prepare('SELECT debtorName, amount FROM critical_overdue WHERE resolved = 0').all();
                criticalRecords.forEach(d => {
                    if (!allDebtors.has(d.debtorName)) {
                        allDebtors.set(d.debtorName, { debtors: 0, overdue: 0, critical: 0, paidMarkers: [] });
                    }
                    allDebtors.get(d.debtorName).critical += d.amount;
                });

                // [!] Добавляем отметки об оплате в Map
                paidMarkers.forEach(m => {
                    if (!allDebtors.has(m.debtorName)) {
                        allDebtors.set(m.debtorName, { debtors: 0, overdue: 0, critical: 0, paidMarkers: [] });
                    }
                    allDebtors.get(m.debtorName).paidMarkers.push({
                        contractTitle: m.contractTitle,
                        amount: m.amount
                    });
                });

                if (allDebtors.size > 0) {
                    // [!] Сортируем должников по алфавиту
                    const sortedDebtors = Array.from(allDebtors.entries()).sort((a, b) => a[0].localeCompare(b[0]));
                    
                    // [!] Считаем количество должников с долгом > 0
                    let activeDebtors = 0;
                    for (const [name, debts] of sortedDebtors) {
                        const total = debts.debtors + debts.overdue + debts.critical;
                        if (total > 0) activeDebtors++;
                    }
                    
                    if (activeDebtors === 0) {
                        text += '👥 Должников нет\n';
                    } else {
                        text += `👥 **Все должники (${activeDebtors} чел.):**\n`;
                        for (const [name, debts] of sortedDebtors) {
                            const total = debts.debtors + debts.overdue + debts.critical;
                            
                            // [!] Пропускаем, если долг = 0
                            if (total === 0) continue;
                            
                            // [!] Считаем сумму всех отметок об оплате
                            let totalPaidMarkers = 0;
                            let paidInfo = [];
                            debts.paidMarkers.forEach(m => {
                                totalPaidMarkers += m.amount;
                                paidInfo.push(`${m.amount.toLocaleString()}$ (${m.contractTitle}) ✅`);
                            });
                            
                            // [!] Если сумма отметок равна долгу - зачёркиваем полностью
                            if (totalPaidMarkers > 0 && totalPaidMarkers >= total) {
                                let parts = [];
                                if (debts.debtors > 0) parts.push(`обычный ${debts.debtors.toLocaleString()}$`);
                                if (debts.overdue > 0) parts.push(`просрочка ${debts.overdue.toLocaleString()}$`);
                                if (debts.critical > 0) parts.push(`крит ${debts.critical.toLocaleString()}$`);
                                text += `   • ~~**${name}**: ${total.toLocaleString()} $ (${parts.join(', ')})~~ ✅ **ВСЁ ОПЛАЧЕНО!** (${paidInfo.join(', ')})\n`;
                            } else if (totalPaidMarkers > 0 && totalPaidMarkers < total) {
                                // Частично оплачено - ник зачёркнут, но остаток виден
                                let parts = [];
                                if (debts.debtors > 0) parts.push(`обычный ${debts.debtors.toLocaleString()}$`);
                                if (debts.overdue > 0) parts.push(`просрочка ${debts.overdue.toLocaleString()}$`);
                                if (debts.critical > 0) parts.push(`крит ${debts.critical.toLocaleString()}$`);
                                const remaining = total - totalPaidMarkers;
                                text += `   • ~~**${name}**~~: ${remaining.toLocaleString()} $ (${parts.join(', ')}) — Оплачено: ${paidInfo.join(', ')}\n`;
                            } else {
                                // Нет отметок об оплате - показываем как обычно
                                let parts = [];
                                if (debts.debtors > 0) parts.push(`обычный ${debts.debtors.toLocaleString()}$`);
                                if (debts.overdue > 0) parts.push(`просрочка ${debts.overdue.toLocaleString()}$`);
                                if (debts.critical > 0) parts.push(`крит ${debts.critical.toLocaleString()}$`);
                                text += `   • **${name}**: ${total.toLocaleString()} $ (${parts.join(', ')})\n`;
                            }
                        }
                    }
                } else {
                    text += '👥 Должников нет\n';
                }

                return i.reply({ content: text, flags: [MessageFlags.Ephemeral] });
            }

            if (i.commandName === 'просрочка') {
                const nick = i.options.getString('ник');
                const amount = i.options.getInteger('сумма');
                const newAmount = Math.round(amount * 1.25);
                const existing = db.prepare('SELECT amount FROM debtors WHERE name = ?').get(nick);
                if (existing) {
                    const total = existing.amount + newAmount;
                    db.prepare('UPDATE debtors SET amount = ? WHERE name = ?').run(total, nick);
                } else {
                    db.prepare('INSERT INTO debtors (name, amount) VALUES (?, ?)').run(nick, newAmount);
                }
                const deadline = Date.now() + 48 * 60 * 60 * 1000;
                db.prepare(`
                    INSERT INTO overdue (debtorName, amount, deadline, createdAt)
                    VALUES (?, ?, ?, ?)
                `).run(nick, newAmount, deadline, Date.now());
                console.log(`[LOG] /просрочка: ${nick} +${newAmount} $ (дедлайн ${new Date(deadline).toLocaleString()})`);
                await i.reply({ content: `✅ Штраф за просрочку для **${nick}** начислен: +${newAmount.toLocaleString()} $ (сумма × 1.25). Дедлайн оплаты – 48 часов.`, flags: [MessageFlags.Ephemeral] });
                return;
            }

            if (i.commandName === 'критическая') {
                const nick = i.options.getString('ник');
                const amount = i.options.getInteger('сумма');
                const newAmount = Math.round(amount * 1.25);
                const existing = db.prepare('SELECT amount FROM debtors WHERE name = ?').get(nick);
                if (existing) {
                    const total = existing.amount + newAmount;
                    db.prepare('UPDATE debtors SET amount = ? WHERE name = ?').run(total, nick);
                } else {
                    db.prepare('INSERT INTO debtors (name, amount) VALUES (?, ?)').run(nick, newAmount);
                }
                const deadline = Date.now() + 48 * 60 * 60 * 1000;
                db.prepare(`
                    INSERT INTO critical_overdue (debtorName, amount, deadline, createdAt)
                    VALUES (?, ?, ?, ?)
                `).run(nick, newAmount, deadline, Date.now());
                console.log(`[LOG] /критическая: ${nick} +${newAmount} $ (дедлайн ${new Date(deadline).toLocaleString()})`);
                await i.reply({ content: `✅ Критическая просрочка для **${nick}** зафиксирована: +${newAmount.toLocaleString()} $ (сумма × 1.25). Дедлайн оплаты – 48 часов.`, flags: [MessageFlags.Ephemeral] });
                return;
            }
        }

        // --- 3. ОБРАБОТКА КНОПОК ---
        if (i.isButton()) {
            console.log(`[LOG] Кнопка: ${i.customId} от ${i.user.tag}`);

            // [!] Обработка кнопки для ручной оплаты
            if (i.customId.startsWith('manual_pay_')) {
                const paymentId = i.customId.replace('manual_pay_', '');
                const contractMsgId = `manual_${paymentId}`;
                
                // Проверяем, что оплата ещё не подтверждена
                const payment = db.prepare('SELECT * FROM pending_payments WHERE contractMsgId = ? AND paid = 0').get(contractMsgId);
                if (!payment) {
                    return i.reply({ content: '❌ Оплата уже подтверждена или не найдена.', flags: [MessageFlags.Ephemeral] });
                }
                
                // Проверяем права (только создатель или админ)
                const isAdmin = i.member.roles.cache.some(role => CONFIG.ALLOWED_ROLES.includes(role.id));
                if (i.user.id !== payment.creatorId && !isAdmin) {
                    return i.reply({ content: '❌ Только создатель или администратор может подтвердить оплату!', flags: [MessageFlags.Ephemeral] });
                }
                
                // Отмечаем как оплачено
                db.prepare('UPDATE pending_payments SET paid = 1 WHERE contractMsgId = ?').run(contractMsgId);
                
                // Находим участников из embed и списываем долги
                const targetMsg = await i.channel.messages.fetch(i.message.id);
                if (targetMsg && targetMsg.embeds && targetMsg.embeds[0]) {
                    const embed = targetMsg.embeds[0];
                    const description = embed.description || '';
                    const participantsMatch = description.match(/👥 \*\*Участники:\*\*\n([\s\S]*?)(?=\n\n|$)/);
                    if (participantsMatch) {
                        const lines = participantsMatch[1].split('\n');
                        lines.forEach(line => {
                            const match = line.match(/• (.+)/);
                            if (match) {
                                const name = match[1].trim();
                                // Списываем долг
                                deductDebt(name, payment.totalAmount);
                            }
                        });
                    }
                }
                
                // Обновляем embed
                const updatedEmbed = EmbedBuilder.from(i.message.embeds[0])
                    .setColor(0xFFA500)
                    .setDescription(
                        i.message.embeds[0].description.replace('⏳ Ожидание', '✅ ОПЛАЧЕНО!')
                    );
                
                await i.update({
                    content: i.message.content,
                    embeds: [updatedEmbed],
                    components: []
                });
                
                // Добавляем деньги в казну
                db.prepare('UPDATE treasury SET balance = balance + ? WHERE id = 1').run(payment.totalAmount);
                
                await i.followUp({ 
                    content: `✅ Оплата по контракту **"${payment.title}"** подтверждена! Сумма ${payment.totalAmount.toLocaleString()} $ добавлена в казну.`,
                    flags: [MessageFlags.Ephemeral] 
                });
                return;
            }

            if (i.customId === 'start') {
                console.log(`[LOG] Открыта форма создания контракта от ${i.user.tag}`);
                const modal = new ModalBuilder().setCustomId('m').setTitle('Создание контракта').addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('n').setLabel('Название').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('Ограбление')),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('nicknames').setLabel('Ники (через ;)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('Artem Minoru;Yuto Minoru')),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('bills').setLabel('Векселя (через ;)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('25;20')),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('time').setLabel('Время (ЧЧ:ММ)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('ЧЧ:ММ'))
                );
                return i.showModal(modal);
            }

            if (i.customId === 'close') {
                const msgId = i.message.id;
                const oldEmbed = i.message.embeds[0];
                if (!oldEmbed) {
                    return i.reply({ content: '❌ Это не сообщение с контрактом.', flags: [MessageFlags.Ephemeral] });
                }

                const timeField = oldEmbed.fields.find(f => f.name === 'Конец');
                if (timeField) {
                    const timestampMatch = timeField.value.match(/<t:(\d+):R>/);
                    if (timestampMatch) {
                        const endTime = parseInt(timestampMatch[1]) * 1000;
                        if (Date.now() < endTime) {
                            return i.reply({ content: '❌ Рано! Таймер ещё не истёк.', flags: [MessageFlags.Ephemeral] });
                        }
                    }
                }

                let contract = db.prepare('SELECT creatorId FROM active_contracts WHERE msgId = ?').get(msgId);
                let creatorId = contract?.creatorId;

                if (!creatorId) {
                    const mentionMatch = i.message.content.match(/<@!?(\d+)>/);
                    if (mentionMatch) {
                        creatorId = mentionMatch[1];
                    }
                }

                if (!creatorId) {
                    creatorId = i.user.id;
                }

                const isAdmin = i.member.roles.cache.some(role => CONFIG.ALLOWED_ROLES.includes(role.id));
                if (i.user.id !== creatorId && !isAdmin) {
                    console.log(`[RESULT] close от ${i.user.tag}: ОТКАЗАНО.`);
                    return i.reply({ content: '❌ Только создатель или администратор может это сделать!', flags: [MessageFlags.Ephemeral] });
                }

                db.prepare('DELETE FROM active_contracts WHERE msgId = ?').run(msgId);

                // [!] Удаляем отметки об оплате для этого контракта
                const deletedMarkers = db.prepare('DELETE FROM paid_markers WHERE contractTitle = ?').run(oldEmbed.title);
                if (deletedMarkers.changes > 0) {
                    console.log(`[DB] Удалены отметки оплаты для контракта "${oldEmbed.title}" (${deletedMarkers.changes} шт.)`);
                }

                const existingHistory = db.prepare('SELECT 1 FROM contract_history WHERE msgId = ?').get(msgId);
                if (!existingHistory) {
                    db.prepare('INSERT INTO contract_history (msgId, title, status, closedAt) VALUES (?, ?, ?, ?)')
                        .run(msgId, oldEmbed.title, 'closed', Date.now());
                    console.log(`[HISTORY] Контракт "${oldEmbed.title}" закрыт (msgId: ${msgId})`);
                }

                try {
                    const recentMessages = await i.channel.messages.fetch({ limit: 20 });
                    const timerMsg = recentMessages.find(m => m.author.id === client.user.id && m.content.includes('ВРЕМЯ ВЫШЛО'));
                    if (timerMsg) {
                        await timerMsg.delete();
                        console.log(`[DELETE] Удалено сообщение "ВРЕМЯ ВЫШЛО" msgId: ${timerMsg.id}`);
                    }
                } catch (err) {
                    console.error('[ERROR] Не удалось удалить сообщение таймера:', err);
                }

                const participants = oldEmbed.fields.filter(f => f.name !== 'Конец' && f.name !== 'ИНСТРУКЦИЯ');
                const multiplier = participants.length >= 2 ? 0.5 : 0.5;

                console.log(`[LOG] Контракт "${oldEmbed.title}" завершён как УСПЕХ пользователем ${i.user.tag}`);
                participants.forEach(f => console.log(`   -> ${f.name}: ${f.value}`));

                // [!] Формируем пинги для исполнителей
                const participantNames = participants.map(f => f.name);
                const membersInfo = getMembersInfo(participantNames);
                const executorMentions = membersInfo.mentions.join(' ');

                const payEmbed = new EmbedBuilder()
                    .setTitle(oldEmbed.title)
                    .setColor(0x00FF00)
                    .setDescription(
                        `**Исполнитель:** <@${creatorId}>\n\n` +
                        `<@${creatorId}>, внесите сумму в казну и приложите скриншот, после нажмите кнопку **Оплатить**\n` +
                        `**Проверяющий:** после оплаты ответьте на это сообщение командой \`!подтвердить\`\n` +
                        `**Оплатить нужно в течении 72 часов**`
                    );

                let totalPayAmount = 0;
                participants.forEach(f => {
                    const toPay = Math.round((parseInt(f.value.replace(/\D/g, '')) || 0) * 1000 * multiplier);
                    totalPayAmount += toPay;
                    db.prepare('INSERT OR REPLACE INTO debtors (name, amount) VALUES (?, IFNULL((SELECT amount FROM debtors WHERE name = ?), 0) + ?)')
                        .run(f.name, f.name, toPay);
                    payEmbed.addFields({ name: f.name, value: `${toPay.toLocaleString()} $` });
                });

                try {
                    await i.message.edit({
                        content: '✅ Статус: **УСПЕХ ✅**',
                        components: [],
                        embeds: [EmbedBuilder.from(oldEmbed).setColor(0x00FF00)]
                    });
                } catch (editErr) {
                    console.warn('Не удалось отредактировать исходное сообщение, удаляем и отправляем новое:', editErr);
                    try {
                        await i.message.delete();
                    } catch (deleteErr) {
                        console.warn('Не удалось удалить исходное сообщение:', deleteErr);
                    }
                    await i.channel.send({
                        content: '✅ Статус: **УСПЕХ ✅**',
                        embeds: [EmbedBuilder.from(oldEmbed).setColor(0x00FF00)]
                    });
                }

                const payChannel = await client.channels.fetch(CONFIG.PAY);
                if (payChannel) {
                    // [!] Формируем пинги: роли | пикающий | исполнители
                    const rolePings = CONFIG.ALLOWED_ROLES.map(r => `<@&${r}>`).join(' ');
                    let pingContent = rolePings + ` | <@${creatorId}>`;
                    if (executorMentions) {
                        pingContent += ` | Исполнители: ${executorMentions}`;
                    }

                    const payMsg = await payChannel.send({
                        content: pingContent,
                        embeds: [payEmbed],
                        components: [new ActionRowBuilder().addComponents(
                            new ButtonBuilder().setCustomId('pay_confirm').setLabel('Оплатить').setStyle(ButtonStyle.Success)
                        )]
                    });
                    db.prepare(`
                        INSERT INTO pending_payments 
                        (contractMsgId, paymentMsgId, creatorId, title, totalAmount, createdAt, deadline)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                    `).run(
                        msgId,
                        payMsg.id,
                        creatorId,
                        oldEmbed.title,
                        totalPayAmount,
                        Date.now(),
                        Date.now() + 72 * 60 * 60 * 1000
                    );
                    console.log(`[DB] Добавлен в ожидающие: ${oldEmbed.title}`);
                }

                await i.reply({ content: '✅ Контракт закрыт, платёж создан.', flags: [MessageFlags.Ephemeral] });
            }

            if (i.customId === 'pay_confirm') {
                const messages = await i.channel.messages.fetch({ limit: 10 });
                if (!messages.some(m => m.attachments.size > 0)) {
                    return i.reply({ content: '❌ Сначала прикрепите скриншот!', flags: [MessageFlags.Ephemeral] });
                }
                const pendingMsg = await i.channel.send({
                    content: `⏳ **Ожидание подтверждения...**\nОплата от <@${i.user.id}>. Проверяющий, ответьте на это сообщение командой \`!подтвердить\`.`,
                    components: []
                });
                global.pendingMessages.set(i.message.id, pendingMsg.id);
                await i.update({
                    content: `⏳ **Ожидание подтверждения...**\nОплата от <@${i.user.id}>. Проверяющий, ответьте на это сообщение командой \`!подтвердить\`.`,
                    components: []
                });
            }

            if (i.customId === 'start_admin') {
                const hasRole = i.member.roles.cache.some(role => CONFIG.ALLOWED_ROLES.includes(role.id));
                if (!hasRole) {
                    return i.reply({ content: '❌ У вас нет прав для этой операции.', flags: [MessageFlags.Ephemeral] });
                }
                if (i.channelId !== process.env.ADMIN_PICK) {
                    return i.reply({ content: '❌ Эта кнопка работает только в специальном канале.', flags: [MessageFlags.Ephemeral] });
                }
                const modal = new ModalBuilder()
                    .setCustomId('admin_m')
                    .setTitle('Создание контракта (админ)')
                    .addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('userId')
                                .setLabel('ID пользователя (от чьего имени)')
                                .setStyle(TextInputStyle.Short)
                                .setRequired(true)
                                .setPlaceholder('123456789012345678')
                        ),
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('n')
                                .setLabel('Название')
                                .setStyle(TextInputStyle.Short)
                                .setRequired(true)
                                .setPlaceholder('Ограбление')
                        ),
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('nicknames')
                                .setLabel('Ники (через ;)')
                                .setStyle(TextInputStyle.Short)
                                .setRequired(true)
                                .setPlaceholder('Artem Minoru;Yuto Minoru')
                        ),
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('bills')
                                .setLabel('Векселя (через ;)')
                                .setStyle(TextInputStyle.Short)
                                .setRequired(true)
                                .setPlaceholder('25;20')
                        ),
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('time')
                                .setLabel('Время (ЧЧ:ММ)')
                                .setStyle(TextInputStyle.Short)
                                .setRequired(true)
                                .setPlaceholder('ЧЧ:ММ')
                        )
                    );
                return i.showModal(modal);
            }
        }

        // --- 4. ОБРАБОТКА МОДАЛОК ---
        if (i.isModalSubmit() && i.customId === 'm') {
            await i.deferReply({ flags: [MessageFlags.Ephemeral] });

            const name = i.fields.getTextInputValue('n').trim();
            const nicknamesRaw = i.fields.getTextInputValue('nicknames').trim();
            const billsRaw = i.fields.getTextInputValue('bills').trim();
            const timeRaw = i.fields.getTextInputValue('time').trim();

            if (!/^[а-яА-ЯёЁ\s]+$/.test(name)) return i.editReply('❌ Название должно быть на кириллице.');
            if (!/^[a-zA-Z_\s;]+$/.test(nicknamesRaw)) return i.editReply('❌ Ники: только латиница, _, ;');
            if (!/^[0-9;]+$/.test(billsRaw)) return i.editReply('❌ Векселя: только цифры и ;');
            if (!/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(timeRaw)) return i.editReply('❌ Время: формат ЧЧ:ММ');

            const nicknames = nicknamesRaw.split(';');
            const bills = billsRaw.split(';');
            if (nicknames.length !== bills.length) return i.editReply('❌ Количество ников не совпадает с количеством векселей.');

            const [h, m] = timeRaw.split(':').map(Number);
            const endTime = Date.now() + (h * 60 + m) * 60 * 1000;

            const embed = new EmbedBuilder().setTitle(name).setColor(0x0099FF);
            nicknames.forEach((nick, idx) => {
                embed.addFields({ name: nick.trim(), value: `Векселей: ${bills[idx] || 0}`, inline: false });
            });
            embed.addFields(
                { name: 'Конец', value: `<t:${Math.floor(endTime / 1000)}:R>`, inline: false },
                { name: 'ИНСТРУКЦИЯ', value: 'После окончания таймера нажмите кнопку "Закрыть контракт", если контракт уже завершился в игре.', inline: false }
            );

            // [!] Формируем упоминания для исполнителей
            const membersInfo = getMembersInfo(nicknames);
            const executorMentions = membersInfo.mentions.join(' ');

            const processChannel = await client.channels.fetch(CONFIG.PROCESS);
            
            // [!] Формируем сообщение: пикающий + исполнители с пингами
            let content = `Контракт взял: <@${i.user.id}>`;
            if (executorMentions) {
                content += ` | Исполнители: ${executorMentions}`;
            }

            const msg = await processChannel.send({
                content: content,
                embeds: [embed],
                components: [new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('close').setLabel('Закрыть контракт').setStyle(ButtonStyle.Primary)
                )]
            });

            db.prepare('INSERT OR REPLACE INTO active_contracts (msgId, creatorId, endTime, channelId) VALUES (?, ?, ?, ?)').run(msg.id, i.user.id, endTime, msg.channelId);
            setupTimer(msg.channel, i.user.id, endTime);

            console.log(`[RESULT] Контракт "${name}" создан от ${i.user.tag}`);
            console.log(`[LOG] Участники:`);
            nicknames.forEach((nick, idx) => console.log(`   -> ${nick.trim()}: ${bills[idx] || 0} векселей`));

            await i.editReply('✅ Контракт успешно создан!');
        }

        if (i.isModalSubmit() && i.customId === 'admin_m') {
            await i.deferReply({ flags: [MessageFlags.Ephemeral] });

            const userId = i.fields.getTextInputValue('userId').trim();
            const name = i.fields.getTextInputValue('n').trim();
            const nicknamesRaw = i.fields.getTextInputValue('nicknames').trim();
            const billsRaw = i.fields.getTextInputValue('bills').trim();
            const timeRaw = i.fields.getTextInputValue('time').trim();

            if (!/^\d+$/.test(userId)) {
                return i.editReply('❌ ID пользователя должен содержать только цифры.');
            }
            if (!/^[а-яА-ЯёЁ\s]+$/.test(name)) return i.editReply('❌ Название должно быть на кириллице.');
            if (!/^[a-zA-Z_\s;]+$/.test(nicknamesRaw)) return i.editReply('❌ Ники: только латиница, _, ;');
            if (!/^[0-9;]+$/.test(billsRaw)) return i.editReply('❌ Векселя: только цифры и ;');
            if (!/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(timeRaw)) return i.editReply('❌ Время: формат ЧЧ:ММ');

            const nicknames = nicknamesRaw.split(';');
            const bills = billsRaw.split(';');
            if (nicknames.length !== bills.length) return i.editReply('❌ Количество ников не совпадает с количеством векселей.');

            const [h, m] = timeRaw.split(':').map(Number);
            const endTime = Date.now() + (h * 60 + m) * 60 * 1000;

            const embed = new EmbedBuilder()
                .setTitle(name)
                .setColor(0x0099FF);
            nicknames.forEach((nick, idx) => {
                embed.addFields({ name: nick.trim(), value: `Векселей: ${bills[idx] || 0}`, inline: false });
            });
            embed.addFields(
                { name: 'Конец', value: `<t:${Math.floor(endTime / 1000)}:R>`, inline: false },
                { name: 'ИНСТРУКЦИЯ', value: 'После окончания таймера нажмите кнопку "Закрыть контракт", если контракт уже завершился в игре.', inline: false }
            );

            // [!] Формируем упоминания для исполнителей
            const membersInfo = getMembersInfo(nicknames);
            const executorMentions = membersInfo.mentions.join(' ');

            const processChannel = await client.channels.fetch(CONFIG.PROCESS);
            
            // [!] Формируем сообщение: пикающий (админ указал userId) + исполнители с пингами
            let content = `Контракт взял: <@${userId}>`;
            if (executorMentions) {
                content += ` | Исполнители: ${executorMentions}`;
            }

            const msg = await processChannel.send({
                content: content,
                embeds: [embed],
                components: [new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('close').setLabel('Закрыть контракт').setStyle(ButtonStyle.Primary)
                )]
            });

            db.prepare('INSERT OR REPLACE INTO active_contracts (msgId, creatorId, endTime, channelId) VALUES (?, ?, ?, ?)')
                .run(msg.id, userId, endTime, msg.channelId);
            setupTimer(msg.channel, userId, endTime);

            console.log(`[RESULT] Контракт "${name}" создан админом ${i.user.tag} от имени пользователя ${userId}`);
            console.log(`[LOG] Участники:`);
            nicknames.forEach((nick, idx) => console.log(`   -> ${nick.trim()}: ${bills[idx] || 0} векселей`));

            await i.editReply(`✅ Контракт успешно создан от имени <@${userId}>!`);
        }

    } catch (err) {
        console.error('Ошибка взаимодействия:', err);
    }
});

const shutdown = () => {
    try { db.close(); } catch (err) { console.error(err); }
    client.destroy();
    process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

client.login(process.env.TOKEN);