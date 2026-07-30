process.env.TZ = 'Europe/Moscow';
require('dotenv').config();
if (!process.env.TOKEN) {
    console.error('❌ ТОКЕН НЕ ЗАГРУЖЕН!');
    process.exit(1);
}
console.log(`✅ Токен загружен: ${process.env.TOKEN.substring(0, 15)}...`);

const { Client, GatewayIntentBits, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, EmbedBuilder, ButtonBuilder, ButtonStyle, MessageFlags, REST, Routes } = require('discord.js');
const db = require('./database');
const commands = require('./commands.js');
const {
    getMembersInfo, deductDebt, deductOverdue, deductCritical,
    addManualPayment, formatOverdue, setupTimer, getPendingDetails,
    addToWallet, getWallet, payFromWallet
} = require('./functions.js');

const CONFIG = {
    PICK: process.env.PICK,
    PROCESS: process.env.PROCESS,
    PAY: process.env.PAY,
    ALLOWED_ROLES: process.env.ALLOWED_ROLES ? process.env.ALLOWED_ROLES.split(',') : []
};

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
if (!global.pendingMessages) global.pendingMessages = new Map();

process.on('unhandledRejection', error => console.error('Unhandled rejection:', error));
process.on('uncaughtException', err => console.error('Uncaught exception:', err));

// ========== ЗАПУСК ==========
client.once('clientReady', async () => {
    try {
        const tableInfo = db.prepare("PRAGMA table_info(contract_history)").all();
        const columnNames = tableInfo.map(col => col.name);
        if (!columnNames.includes('title')) { db.prepare("ALTER TABLE contract_history ADD COLUMN title TEXT").run(); }
        if (!columnNames.includes('closedAt')) { db.prepare("ALTER TABLE contract_history ADD COLUMN closedAt INTEGER").run(); }
    } catch (err) { console.error('[DB] Ошибка:', err); }

    const tables = ['pending_payments', 'overdue', 'critical_overdue', 'paid_markers', 'wallets'];
    for (const table of tables) {
        try {
            db.prepare(`CREATE TABLE IF NOT EXISTS ${table} (id INTEGER PRIMARY KEY AUTOINCREMENT)`).run();
            console.log(`[DB] Таблица ${table} проверена`);
        } catch (err) { console.error(`[DB] Ошибка при создании ${table}:`, err); }
    }

    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });

    const treasury = db.prepare('SELECT balance FROM treasury WHERE id = 1').get();
    const debtorsList = db.prepare('SELECT name, amount FROM debtors').all();
    const totalClosed = db.prepare('SELECT COUNT(*) as count FROM contract_history').get();
    const activeCount = db.prepare('SELECT COUNT(*) as count FROM active_contracts').get();

    let logMsg = `\n🚀 Бот ${client.user.tag} запущен!\n📊 --- СТАТИСТИКА ---\n`;
    logMsg += `💰 Казна: ${(treasury?.balance || 0).toLocaleString()} $\n`;
    logMsg += `👥 Должники (${debtorsList.length}):\n`;
    debtorsList.forEach(d => { logMsg += `   • ${d.name}: ${d.amount.toLocaleString()} $\n`; });
    logMsg += `📦 Закрыто контрактов: ${totalClosed?.count || 0}\n⏳ Активных: ${activeCount.count || 0}\n`;

    const pendingPayments = db.prepare('SELECT title, creatorId, totalAmount, deadline, paymentMsgId, contractMsgId FROM pending_payments WHERE paid = 0').all();
    if (pendingPayments.length > 0) {
        logMsg += `💳 Ожидают оплаты (${pendingPayments.length}):\n`;
        const details = await getPendingDetails(client, pendingPayments, CONFIG);
        logMsg += details;
    }

    const overdueStr = formatOverdue('overdue', '⏰ Просрочки');
    if (overdueStr) logMsg += overdueStr;
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
                setupTimer(client, channel, contract.creatorId, contract.endTime);
            }
        } catch (err) { console.error(`Ошибка контракта ${contract.msgId}:`, err); }
    }

    if (process.env.ADMIN_PICK) {
        try {
            const adminChannel = await client.channels.fetch(process.env.ADMIN_PICK);
            if (!adminChannel) { console.error('[ERROR] ADMIN_PICK не найден'); return; }
            const messages = await adminChannel.messages.fetch({ limit: 10 });
            const existingMsg = messages.find(m => m.author.id === client.user.id && m.embeds.length > 0 && m.embeds[0].title === 'Админ-панель');
            if (!existingMsg) {
                await adminChannel.send({
                    embeds: [new EmbedBuilder().setTitle('Админ-панель').setDescription('Создать контракт от имени другого игрока.').setColor(0xFFA500)],
                    components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('start_admin').setLabel('Создать контракт для игрока').setStyle(ButtonStyle.Success))]
                });
                console.log('[INFO] Админ-панель отправлена');
            }
        } catch (err) { console.error('[ERROR] Админ-панель:', err); }
    }
});

// ========== СООБЩЕНИЯ ==========
client.on('messageCreate', async msg => {
    if (msg.author.bot) return;
    
    if (msg.content.startsWith('!импорт_контракт') || msg.content.startsWith('!закрыть_контракт') || msg.content.startsWith('!список')) {
        const hasRole = msg.member.roles.cache.some(role => CONFIG.ALLOWED_ROLES.includes(role.id));
        if (!hasRole) return await msg.reply('❌ Нет прав.');
        if (msg.content.startsWith('!список')) {
            const contracts = db.prepare('SELECT msgId, creatorId, endTime FROM active_contracts').all();
            console.log(`\n📋 АКТИВНЫЕ КОНТРАКТЫ (${contracts.length}):`);
            contracts.forEach(c => console.log(` • ${c.msgId} | ${c.creatorId} | ${Math.round((c.endTime - Date.now()) / 60000)} мин.`));
            return await msg.reply('✅ Список в консоль.');
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

    // !подтвердить
    if (msg.channel.id === CONFIG.PAY && msg.content.trim() === '!подтвердить') {
        const hasRole = msg.member.roles.cache.some(role => CONFIG.ALLOWED_ROLES.includes(role.id));
        if (!hasRole) {
            const reply = await msg.reply('❌ Нет прав.');
            setTimeout(async () => { await msg.delete().catch(() => {}); await reply.delete().catch(() => {}); }, 3000);
            return;
        }
        if (!msg.reference || !msg.reference.messageId) {
            const reply = await msg.reply('❌ Ответьте на сообщение.');
            setTimeout(async () => { await msg.delete().catch(() => {}); await reply.delete().catch(() => {}); }, 3000);
            return;
        }
        try {
            const targetMsg = await msg.channel.messages.fetch(msg.reference.messageId);
            if (!targetMsg) {
                const reply = await msg.reply('❌ Сообщение не найдено.');
                setTimeout(async () => { await msg.delete().catch(() => {}); await reply.delete().catch(() => {}); }, 3000);
                return;
            }
            if (!targetMsg.embeds?.[0]?.fields?.length) {
                const reply = await msg.reply('❌ Это не сообщение с платежом.');
                setTimeout(async () => { await msg.delete().catch(() => {}); await reply.delete().catch(() => {}); }, 3000);
                return;
            }

            console.log(`[LOG] !подтвердить от ${msg.author.tag}`);
            const contractTitle = targetMsg.embeds[0]?.title || 'Неизвестный контракт';
            
            // Удаляем отметки оплаты
            db.prepare('DELETE FROM paid_markers WHERE contractTitle = ?').run(contractTitle);

            let totalPaid = 0;
            const participants = [];
            targetMsg.embeds[0].fields.forEach(field => {
                const amount = parseInt(field.value.replace(/\D/g, '')) || 0;
                if (amount > 0) {
                    participants.push({ name: field.name, amount });
                    deductDebt(field.name, amount);
                    totalPaid += amount;
                }
            });

            db.prepare('DELETE FROM debtors WHERE amount <= 0').run();
            if (totalPaid > 0) db.prepare('UPDATE treasury SET balance = balance + ? WHERE id = 1').run(totalPaid);
            db.prepare('DELETE FROM pending_payments WHERE paymentMsgId = ?').run(targetMsg.id);

            // [!] 1. МЕНЯЕМ ТЕКСТ СООБЩЕНИЯ С КНОПКОЙ
            try {
                // Формируем список участников для красивого отображения
                let details = `✅ **Оплата подтверждена!** Проверяющий: <@${msg.author.id}>\n\n`;
                details += `📋 **${contractTitle}**\n`;
                participants.forEach(p => {
                    details += `• **${p.name}**: ${p.amount.toLocaleString()} $\n`;
                });
                details += `\n💰 Итого в казну: ${totalPaid.toLocaleString()} $`;
                
                await targetMsg.edit({ 
                    content: details, 
                    components: [] 
                });
                console.log(`[EDIT] Сообщение с кнопкой обновлено`);
            } catch (editErr) {
                console.warn('Не удалось отредактировать сообщение:', editErr);
                // Если не получилось отредактировать — удаляем и отправляем новое
                try {
                    await targetMsg.delete();
                    await msg.channel.send({
                        content: `✅ **Оплата подтверждена!** Проверяющий: <@${msg.author.id}>\n\n📋 **${contractTitle}**\n${participants.map(p => `• **${p.name}**: ${p.amount.toLocaleString()} $`).join('\n')}\n\n💰 Итого в казну: ${totalPaid.toLocaleString()} $`
                    });
                } catch (err) {
                    console.warn('Не удалось удалить сообщение:', err);
                }
            }

            // [!] 2. УДАЛЯЕМ СООБЩЕНИЕ ОЖИДАНИЯ
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

            // [!] 3. УДАЛЯЕМ СООБЩЕНИЕ С !подтвердить И ОТВЕТ БОТА
            const replyMsg = await msg.reply('✅ Контракт закрыт, долги обновлены.');
            setTimeout(async () => {
                await msg.delete().catch(() => {});
                await replyMsg.delete().catch(() => {});
            }, 3000);

        } catch (err) {
            console.error('[ERROR] !подтвердить:', err);
            const reply = await msg.reply('❌ Ошибка при подтверждении.');
            setTimeout(async () => {
                await msg.delete().catch(() => {});
                await reply.delete().catch(() => {});
            }, 3000);
        }
        return;
    }

    if (msg.channel.id === CONFIG.PICK || msg.channel.id === CONFIG.PROCESS) {
        await msg.delete().catch(() => {});
        console.log(`[DELETE] ${msg.author.tag} в #${msg.channel.name}`);
    }
});

// ========== ИНТЕРАКЦИИ ==========
client.on('interactionCreate', async i => {
    try {
        // ===== КОНТЕКСТНОЕ МЕНЮ =====
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
                if (!contract) return i.editReply('❌ Контракт не найден.');

                const oldEmbed = i.targetMessage.embeds[0];
                if (!oldEmbed) return i.editReply('❌ Не сообщение с контрактом.');

                const timeField = oldEmbed.fields.find(f => f.name === 'Конец');
                if (timeField) {
                    const match = timeField.value.match(/<t:(\d+):R>/);
                    if (match && Date.now() < parseInt(match[1]) * 1000) {
                        return i.editReply('❌ Рано! Таймер ещё не истёк.');
                    }
                }

                db.prepare('DELETE FROM active_contracts WHERE msgId = ?').run(msgId);
                db.prepare('DELETE FROM paid_markers WHERE contractTitle = ?').run(oldEmbed.title);
                db.prepare('INSERT INTO contract_history (msgId, title, status, closedAt) VALUES (?, ?, ?, ?)')
                    .run(msgId, oldEmbed.title, 'closed', Date.now());

                const participants = oldEmbed.fields.filter(f => f.name !== 'Конец' && f.name !== 'ИНСТРУКЦИЯ');
                const multiplier = participants.length >= 2 ? 0.5 : 0.5;
                const participantNames = participants.map(f => f.name);
                const membersInfo = getMembersInfo(participantNames);
                const executorMentions = membersInfo.mentions.join(' ');

                const payEmbed = new EmbedBuilder()
                    .setTitle(oldEmbed.title)
                    .setColor(0x00FF00)
                    .setDescription(
                        `**Исполнитель:** <@${contract.creatorId}>\n\n` +
                        `<${executorMentions}>, внесите сумму в казну и приложите скриншот\n` +
                        `**Проверяющий:** ответьте \`!подтвердить\`\n` +
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

                await i.targetMessage.edit({
                    content: `✅ Статус: **УСПЕХ ✅**`,
                    components: [],
                    embeds: [EmbedBuilder.from(oldEmbed).setColor(0x00FF00)]
                }).catch(() => {});

                const payChannel = await client.channels.fetch(CONFIG.PAY);
                if (payChannel) {
                    const rolePings = CONFIG.ALLOWED_ROLES.map(r => `<@&${r}>`).join(' ');
                    let pingContent = rolePings + ` | <@${contract.creatorId}>`;
                    if (executorMentions) pingContent += ` | Исполнители: ${executorMentions}`;

                    const payMsg = await payChannel.send({
                        content: pingContent,
                        embeds: [payEmbed],
                        components: [new ActionRowBuilder().addComponents(
                            new ButtonBuilder().setCustomId('pay_confirm').setLabel('Оплатить').setStyle(ButtonStyle.Success)
                        )]
                    });
                    db.prepare(`INSERT INTO pending_payments (contractMsgId, paymentMsgId, creatorId, title, totalAmount, createdAt, deadline) VALUES (?, ?, ?, ?, ?, ?, ?)`)
                        .run(msgId, payMsg.id, contract.creatorId, oldEmbed.title, totalPayAmount, Date.now(), Date.now() + 72 * 60 * 60 * 1000);
                }
                return i.editReply('✅ Контракт закрыт как УСПЕХ.');
            }

            if (i.commandName === 'Напомнить о закрытии') {
                await i.deferReply({ flags: [MessageFlags.Ephemeral] });
                const targetMsg = i.targetMessage;
                let contractName = targetMsg.embeds?.[0]?.title || 'Контракт';
                let creatorId = targetMsg.content.match(/<@!?(\d+)>/)?.[1] || db.prepare('SELECT creatorId FROM active_contracts WHERE msgId = ?').get(targetMsg.id)?.creatorId;
                if (!creatorId) return i.editReply('❌ Не найден создатель.');
                await targetMsg.reply(`⚠️ **НАПОМИНАНИЕ!** Контракт **«${contractName}»** (ID: ${targetMsg.id}) уже должен быть закрыт. <@${creatorId}>`);
                return i.editReply('✅ Напоминание отправлено.');
            }

            if (i.commandName === 'Принудительно оплатить') {
                await i.deferReply({ flags: [MessageFlags.Ephemeral] });
                const targetMsg = i.targetMessage;
                if (!targetMsg.embeds?.[0]?.fields?.length) return i.editReply('❌ Не сообщение с платежом.');

                const embed = targetMsg.embeds[0];
                const contractTitle = embed?.title || 'Неизвестный контракт';
                let totalPaid = 0;
                const participants = [];

                embed.fields.forEach(field => {
                    const amount = parseInt(field.value.replace(/\D/g, '')) || 0;
                    if (amount > 0) { participants.push({ name: field.name, amount }); totalPaid += amount; }
                });

                if (participants.length === 0) return i.editReply('❌ Нет сумм.');
                participants.forEach(p => deductDebt(p.name, p.amount));
                db.prepare('DELETE FROM debtors WHERE amount <= 0').run();
                if (totalPaid > 0) db.prepare('UPDATE treasury SET balance = balance + ? WHERE id = 1').run(totalPaid);
                db.prepare('DELETE FROM pending_payments WHERE paymentMsgId = ?').run(targetMsg.id);

                await targetMsg.edit({ content: `✅ Принудительно оплачено! Проверяющий: <@${i.user.id}>`, components: [] }).catch(() => {});
                return i.editReply(`✅ Оплата по "${contractTitle}" проведена. Сумма: ${totalPaid.toLocaleString()} $`);
            }

            if (i.commandName === 'Импортировать оплату') {
                await i.deferReply({ flags: [MessageFlags.Ephemeral] });
                const targetMsg = i.targetMessage;
                if (!targetMsg.embeds?.[0]?.fields?.length) return i.editReply('❌ Не сообщение с платежом.');

                const embed = targetMsg.embeds[0];
                const contractTitle = embed?.title || 'Неизвестный контракт';
                let creatorId = targetMsg.content.match(/<@!?(\d+)>/)?.[1] || db.prepare('SELECT creatorId FROM active_contracts WHERE msgId = ?').get(targetMsg.id)?.creatorId;
                if (!creatorId) return i.editReply('❌ Не найден создатель.');
                if (db.prepare('SELECT 1 FROM pending_payments WHERE paymentMsgId = ?').get(targetMsg.id)) {
                    return i.editReply('⚠️ Уже в БД.');
                }

                let totalAmount = 0;
                embed.fields.forEach(f => { totalAmount += parseInt(f.value.replace(/\D/g, '')) || 0; });

                db.prepare(`INSERT INTO pending_payments (contractMsgId, paymentMsgId, creatorId, title, totalAmount, createdAt, deadline) VALUES (?, ?, ?, ?, ?, ?, ?)`)
                    .run(targetMsg.id, targetMsg.id, creatorId, contractTitle, totalAmount, Date.now(), Date.now() + 72 * 60 * 60 * 1000);
                return i.editReply(`✅ Оплата "${contractTitle}" добавлена.`);
            }
        }

        // ===== СЛЭШ-КОМАНДЫ =====
        if (i.isChatInputCommand()) {
            console.log(`[LOG] /${i.commandName} от ${i.user.tag}`);

            if (i.commandName !== 'ожидают') {
                const hasRole = i.member.roles.cache.some(role => CONFIG.ALLOWED_ROLES.includes(role.id));
                if (!hasRole) return i.reply({ content: '❌ Нет прав.', flags: [MessageFlags.Ephemeral] });
            }

            switch (i.commandName) {
                case 'контракт_список': {
                    const activeContracts = db.prepare('SELECT msgId, channelId FROM active_contracts').all();
                    if (activeContracts.length === 0) return i.reply({ content: '📋 Активных контрактов нет.', flags: [MessageFlags.Ephemeral] });
                    let text = `📋 **АКТИВНЫЕ (${activeContracts.length}):**\n\n`;
                    for (const c of activeContracts) {
                        try {
                            const channel = await client.channels.fetch(c.channelId);
                            const targetMsg = await channel.messages.fetch(c.msgId);
                            text += ` • **${targetMsg.embeds[0]?.title || 'Без названия'}** | ID: ${c.msgId}\n`;
                        } catch (e) { text += ` • ID: ${c.msgId} (недоступно)\n`; }
                    }
                    return i.reply({ content: text, flags: [MessageFlags.Ephemeral] });
                }

                case 'казна': {
                    const row = db.prepare('SELECT balance FROM treasury WHERE id = 1').get();
                    return i.reply({ content: `💰 Баланс: **${(row?.balance || 0).toLocaleString()} $**`, flags: [MessageFlags.Ephemeral] });
                }

                case 'должники': {
                    const debtors = db.prepare('SELECT * FROM debtors').all();
                    const text = debtors.length ? debtors.map(d => `• **${d.name}**: ${d.amount.toLocaleString()}$`).join('\n') : 'Должников нет.';
                    return i.reply({ content: `📋 **Список должников:**\n${text}`, flags: [MessageFlags.Ephemeral] });
                }

                case 'вызвать': {
                    if (i.channelId !== CONFIG.PICK) return i.reply({ content: '❌ Только в канале пика!', flags: [MessageFlags.Ephemeral] });
                    return i.reply({
                        content: "Правила работы с контрактами Minoru\nУважаемые<@&1373750905274630275><@&1373750899649806449><@&1392858292925108254>, ознакомьтесь с правилами работы. Вы обязаны следить за каналами <#1526654909452390531> и <#1403074323614404738> на наличие вашего никнейма.\n\n1. 📝 Создание контракта 📝\nПосле того как вы взяли контракт в игре, нажмите кнопку [Создать контракт] под этим сообщением.\nВ открывшейся панели заполните все необходимые данные по контракту.\n2. ⚖️ Процентные ставки ⚖️\n**Соло-контракт:** 50% (успех)\n**Группа (2+ человека):** 50% (успех).\nНа контракты пикнутые не в 100% сразу будет налогаться штраф в виде фиксированной суммы 50.000$ В случае успеха контракта, будет все так-же процентно для соло или группы.\n3. 💰 Оплата и штрафы 💰\n**Скриншот:** Присылается в обязательном порядке.\n**Срок оплаты:** 72 часа с момента создания контракта.\n**Просрочка (72ч+):** Сумма увеличивается в 1.25 раза. На оплату этой суммы дается еще 48 часов.\n**Критическая просрочка (120ч+):** Накладывается «мороз» на 48 часов + сумма еще увеличивается в 1.25 раза. Если оплата не поступит в этот срок — АФК-ранг до погашения долга.\n4. ⚠️ Регистрация контрактов ⚠️\nРегистрация контракта **обязательна**. Если контракт завершен, а данных о нем нет в канале — на игрока накладывается штраф: 30% от полученной суммы.\nЕсли у вас вдруг не видно канала <#1526654909452390531> То можно нажать на его название в этом канале и перейти.\n\nПо всем вопросам обращаться к: <@702529657718833162>",
                        components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('start').setLabel('Создать контракт').setStyle(ButtonStyle.Primary))]
                    });
                }

                case 'удалить_контракт': {
                    const msgId = i.options.getString('msgid');
                    const result = db.prepare('DELETE FROM active_contracts WHERE msgId = ?').run(msgId);
                    return i.reply({ content: result.changes > 0 ? `✅ Удалён ID \`${msgId}\`` : `❌ Не найден.`, flags: [MessageFlags.Ephemeral] });
                }

                case 'чек_контракты': {
                    const contracts = db.prepare('SELECT * FROM active_contracts').all();
                    for (const c of contracts) {
                        const channel = await client.channels.fetch(c.channelId);
                        setupTimer(client, channel, c.creatorId, c.endTime);
                    }
                    return i.reply({ content: `✅ Проверено: ${contracts.length}`, flags: [MessageFlags.Ephemeral] });
                }

                case 'внести_оплату': {
                    const title = i.options.getString('название');
                    const amount = i.options.getInteger('сумма');
                    const participants = i.options.getString('участники');
                    if (amount <= 0) return i.reply({ content: '❌ Сумма > 0.', flags: [MessageFlags.Ephemeral] });
                    const names = participants.split(';').filter(n => n.trim());
                    if (names.length === 0) return i.reply({ content: '❌ Укажите участников.', flags: [MessageFlags.Ephemeral] });
                    
                    const paymentId = addManualPayment(title, amount, participants, i.user.id);
                    const embed = new EmbedBuilder().setTitle(title).setColor(0x00FF00)
                        .setDescription(`**Исполнитель:** <@${i.user.id}>\n\n💰 **Сумма:** ${amount.toLocaleString()} $\n👥 **Участники:**\n${names.map(n => `   • ${n}`).join('\n')}\n\n⏳ **Ожидает оплаты...**`)
                        .setFooter({ text: `ID: ${paymentId}` });
                    
                    const payChannel = await client.channels.fetch(CONFIG.PAY);
                    if (payChannel) {
                        await payChannel.send({
                            content: `${CONFIG.ALLOWED_ROLES.map(r => `<@&${r}>`).join(' ')} | <@${i.user.id}>`,
                            embeds: [embed],
                            components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`manual_pay_${paymentId}`).setLabel('✅ Оплачено').setStyle(ButtonStyle.Success))]
                        });
                    }
                    return i.reply({ content: `✅ Оплата внесена!`, flags: [MessageFlags.Ephemeral] });
                }

                case 'отметить_оплачено': {
                    const nick = i.options.getString('ник');
                    const contractTitle = i.options.getString('контракт');
                    const amount = i.options.getInteger('сумма');
                    const existing = db.prepare(`SELECT 1 FROM paid_markers WHERE debtorName = ? AND contractTitle = ? AND amount = ?`).get(nick, contractTitle, amount);
                    if (existing) return i.reply({ content: `⚠️ Уже есть отметка.`, flags: [MessageFlags.Ephemeral] });
                    db.prepare(`INSERT INTO paid_markers (debtorName, contractTitle, amount, markedBy, createdAt) VALUES (?, ?, ?, ?, ?)`).run(nick, contractTitle, amount, i.user.id, Date.now());
                    return i.reply({ content: `✅ Отметка добавлена.`, flags: [MessageFlags.Ephemeral] });
                }

                case 'убрать_отметку': {
                    const nick = i.options.getString('ник');
                    const contractTitle = i.options.getString('контракт');
                    const amount = i.options.getInteger('сумма');
                    const existing = db.prepare(`SELECT 1 FROM paid_markers WHERE debtorName = ? AND contractTitle = ? AND amount = ?`).get(nick, contractTitle, amount);
                    if (!existing) return i.reply({ content: `❌ Отметка не найдена.`, flags: [MessageFlags.Ephemeral] });
                    db.prepare(`DELETE FROM paid_markers WHERE debtorName = ? AND contractTitle = ? AND amount = ?`).run(nick, contractTitle, amount);
                    return i.reply({ content: `✅ Отметка удалена.`, flags: [MessageFlags.Ephemeral] });
                }

                case 'внести_в_кошелек': {
                    const playerName = i.options.getString('ник');
                    const amount = i.options.getInteger('сумма');
                    if (amount <= 0) return i.reply({ content: '❌ Сумма > 0.', flags: [MessageFlags.Ephemeral] });
                    const newBalance = addToWallet(playerName, amount);
                    return i.reply({ content: `✅ Кошелёк **${playerName}** пополнен на ${amount.toLocaleString()} $.\n💰 Баланс: ${newBalance.balance.toLocaleString()} $`, flags: [MessageFlags.Ephemeral] });
                }

                case 'кошелек': {
                    const playerName = i.options.getString('ник');
                    const wallet = getWallet(playerName);
                    if (!wallet) return i.reply({ content: `❌ Кошелёк не найден.`, flags: [MessageFlags.Ephemeral] });
                    return i.reply({ content: `💰 **${playerName}**\nБаланс: ${wallet.balance.toLocaleString()} $\n📅 ${new Date(wallet.updatedAt).toLocaleString()}`, flags: [MessageFlags.Ephemeral] });
                }

                case 'оплатить_с_кошелька': {
                    const playerName = i.options.getString('ник');
                    const contractTitle = i.options.getString('контракт');
                    const amount = i.options.getInteger('сумма_долга');
                    if (amount <= 0) return i.reply({ content: '❌ Сумма > 0.', flags: [MessageFlags.Ephemeral] });
                    try {
                        const newBalance = payFromWallet(playerName, contractTitle, amount, i.user.id);
                        return i.reply({ content: `✅ Оплачено ${amount.toLocaleString()} $ по "${contractTitle}".\n💰 Остаток: ${newBalance.balance.toLocaleString()} $`, flags: [MessageFlags.Ephemeral] });
                    } catch (err) {
                        return i.reply({ content: `❌ ${err.message}`, flags: [MessageFlags.Ephemeral] });
                    }
                }

                case 'пополнить':
                case 'вычесть':
                case 'долг_добавить':
                case 'оплачено':
                case 'оплачено_просрочка':
                case 'оплачено_крит': {
                    const amt = i.options.getInteger('сумма') || 0;
                    const nick = i.options.getString('ник') || '';
                    
                    if (i.commandName === 'пополнить') {
                        db.prepare('UPDATE treasury SET balance = balance + ? WHERE id = 1').run(amt);
                        return i.reply({ content: `✅ +${amt.toLocaleString()} $`, flags: [MessageFlags.Ephemeral] });
                    }
                    if (i.commandName === 'вычесть') {
                        const balance = db.prepare('SELECT balance FROM treasury WHERE id = 1').get().balance || 0;
                        if (amt > balance) return i.reply({ content: `❌ Доступно: ${balance.toLocaleString()} $`, flags: [MessageFlags.Ephemeral] });
                        db.prepare('UPDATE treasury SET balance = balance - ? WHERE id = 1').run(amt);
                        return i.reply({ content: `✅ -${amt.toLocaleString()} $`, flags: [MessageFlags.Ephemeral] });
                    }
                    if (i.commandName === 'долг_добавить') {
                        db.prepare('INSERT OR REPLACE INTO debtors (name, amount) VALUES (?, ?)').run(nick, amt);
                        return i.reply({ content: '✅ Добавлен.', flags: [MessageFlags.Ephemeral] });
                    }
                    if (i.commandName === 'оплачено') { deductDebt(nick, amt); return i.reply({ content: '✅ Оплачен.', flags: [MessageFlags.Ephemeral] }); }
                    if (i.commandName === 'оплачено_просрочка') { deductOverdue(nick, amt); return i.reply({ content: '✅ Оплачена просрочка.', flags: [MessageFlags.Ephemeral] }); }
                    if (i.commandName === 'оплачено_крит') { deductCritical(nick, amt); return i.reply({ content: '✅ Оплачена критическая.', flags: [MessageFlags.Ephemeral] }); }
                    break;
                }

                case 'статистика': {
                    const treasury2 = db.prepare('SELECT balance FROM treasury WHERE id = 1').get();
                    const debtorsList2 = db.prepare('SELECT name, amount FROM debtors').all();
                    const totalClosed2 = db.prepare('SELECT COUNT(*) as count FROM contract_history').get();
                    const activeCount2 = db.prepare('SELECT COUNT(*) as count FROM active_contracts').get();
                    let stats = `📊 СТАТИСТИКА (${i.user.tag})\n💰 Казна: ${(treasury2?.balance || 0).toLocaleString()} $\n👥 Должники: ${debtorsList2.length}\n📦 Закрыто: ${totalClosed2?.count || 0}\n⏳ Активных: ${activeCount2.count || 0}`;
                    console.log(stats);
                    return i.reply({ content: '✅ Статистика в логи.', flags: [MessageFlags.Ephemeral] });
                }

                case 'ожидают': {
                    await i.deferReply({ flags: [MessageFlags.Ephemeral] });
                    
                    let text = `📋 **Ожидают оплаты**\n\n`;
                    const pending = db.prepare(`SELECT title, creatorId, totalAmount, deadline, paymentMsgId, contractMsgId FROM pending_payments WHERE paid = 0`).all();
                    if (pending.length > 0) {
                        const details = await getPendingDetails(client, pending, CONFIG);
                        text += details;
                    } else {
                        text += '💳 Нет ожидающих оплат\n\n';
                    }
                    
                    const allDebtors = new Map();
                    db.prepare('SELECT name, amount FROM debtors WHERE amount > 0').all().forEach(d => {
                        if (!allDebtors.has(d.name)) allDebtors.set(d.name, { debtors: 0, overdue: 0, critical: 0, paidMarkers: [] });
                        allDebtors.get(d.name).debtors = d.amount;
                    });
                    
                    const paidMarkers = db.prepare(`SELECT debtorName, contractTitle, amount FROM paid_markers`).all();
                    db.prepare('SELECT debtorName, amount FROM overdue WHERE resolved = 0').all().forEach(d => {
                        if (!allDebtors.has(d.debtorName)) allDebtors.set(d.debtorName, { debtors: 0, overdue: 0, critical: 0, paidMarkers: [] });
                        allDebtors.get(d.debtorName).overdue += d.amount;
                    });
                    db.prepare('SELECT debtorName, amount FROM critical_overdue WHERE resolved = 0').all().forEach(d => {
                        if (!allDebtors.has(d.debtorName)) allDebtors.set(d.debtorName, { debtors: 0, overdue: 0, critical: 0, paidMarkers: [] });
                        allDebtors.get(d.debtorName).critical += d.amount;
                    });
                    paidMarkers.forEach(m => {
                        if (!allDebtors.has(m.debtorName)) allDebtors.set(m.debtorName, { debtors: 0, overdue: 0, critical: 0, paidMarkers: [] });
                        allDebtors.get(m.debtorName).paidMarkers.push({ contractTitle: m.contractTitle, amount: m.amount });
                    });
                    
                    if (allDebtors.size > 0) {
                        const sortedDebtors = Array.from(allDebtors.entries()).sort((a, b) => a[0].localeCompare(b[0]));
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
                                if (total === 0) continue;
                                
                                let totalPaidMarkers = 0;
                                let paidInfo = [];
                                debts.paidMarkers.forEach(m => {
                                    totalPaidMarkers += m.amount;
                                    paidInfo.push(`${m.amount.toLocaleString()}$ (${m.contractTitle}) ✅`);
                                });
                                
                                let parts = [];
                                if (debts.debtors > 0) parts.push(`обычный ${debts.debtors.toLocaleString()}$`);
                                if (debts.overdue > 0) parts.push(`просрочка ${debts.overdue.toLocaleString()}$`);
                                if (debts.critical > 0) parts.push(`крит ${debts.critical.toLocaleString()}$`);
                                
                                if (totalPaidMarkers > 0 && totalPaidMarkers >= total) {
                                    text += `   • ~~**${name}**: ${total.toLocaleString()} $ (${parts.join(', ')})~~ ✅ **ВСЁ ОПЛАЧЕНО!** (${paidInfo.join(', ')})\n`;
                                } else if (totalPaidMarkers > 0 && totalPaidMarkers < total) {
                                    const remaining = total - totalPaidMarkers;
                                    text += `   • ~~**${name}**~~: ${remaining.toLocaleString()} $ (${parts.join(', ')}) — Оплачено: ${paidInfo.join(', ')}\n`;
                                } else {
                                    text += `   • **${name}**: ${total.toLocaleString()} $ (${parts.join(', ')})\n`;
                                }
                            }
                        }
                    } else {
                        text += '👥 Должников нет\n';
                    }
                    
                    return i.editReply({ content: text });
                }

                case 'просрочка': {
                    const nick = i.options.getString('ник');
                    const amount = i.options.getInteger('сумма');
                    const newAmount = Math.round(amount * 1.25);
                    const existing = db.prepare('SELECT amount FROM debtors WHERE name = ?').get(nick);
                    if (existing) db.prepare('UPDATE debtors SET amount = ? WHERE name = ?').run(existing.amount + newAmount, nick);
                    else db.prepare('INSERT INTO debtors (name, amount) VALUES (?, ?)').run(nick, newAmount);
                    const deadline = Date.now() + 48 * 60 * 60 * 1000;
                    db.prepare(`INSERT INTO overdue (debtorName, amount, deadline, createdAt) VALUES (?, ?, ?, ?)`).run(nick, newAmount, deadline, Date.now());
                    return i.reply({ content: `✅ Штраф для **${nick}**: +${newAmount.toLocaleString()} $`, flags: [MessageFlags.Ephemeral] });
                }

                case 'критическая': {
                    const nick = i.options.getString('ник');
                    const amount = i.options.getInteger('сумма');
                    const newAmount = Math.round(amount * 1.25);
                    const existing = db.prepare('SELECT amount FROM debtors WHERE name = ?').get(nick);
                    if (existing) db.prepare('UPDATE debtors SET amount = ? WHERE name = ?').run(existing.amount + newAmount, nick);
                    else db.prepare('INSERT INTO debtors (name, amount) VALUES (?, ?)').run(nick, newAmount);
                    const deadline = Date.now() + 48 * 60 * 60 * 1000;
                    db.prepare(`INSERT INTO critical_overdue (debtorName, amount, deadline, createdAt) VALUES (?, ?, ?, ?)`).run(nick, newAmount, deadline, Date.now());
                    return i.reply({ content: `✅ Критическая для **${nick}**: +${newAmount.toLocaleString()} $`, flags: [MessageFlags.Ephemeral] });
                }
            }
            return;
        }

        // ===== КНОПКИ =====
        if (i.isButton()) {
            console.log(`[LOG] Кнопка: ${i.customId} от ${i.user.tag}`);

            if (i.customId.startsWith('manual_pay_')) {
                const paymentId = i.customId.replace('manual_pay_', '');
                const contractMsgId = `manual_${paymentId}`;
                const payment = db.prepare('SELECT * FROM pending_payments WHERE contractMsgId = ? AND paid = 0').get(contractMsgId);
                if (!payment) return i.reply({ content: '❌ Оплата не найдена.', flags: [MessageFlags.Ephemeral] });
                const isAdmin = i.member.roles.cache.some(role => CONFIG.ALLOWED_ROLES.includes(role.id));
                if (i.user.id !== payment.creatorId && !isAdmin) return i.reply({ content: '❌ Нет прав.', flags: [MessageFlags.Ephemeral] });
                db.prepare('UPDATE pending_payments SET paid = 1 WHERE contractMsgId = ?').run(contractMsgId);
                const targetMsg = await i.channel.messages.fetch(i.message.id);
                if (targetMsg && targetMsg.embeds && targetMsg.embeds[0]) {
                    const desc = targetMsg.embeds[0].description || '';
                    const match = desc.match(/👥 \*\*Участники:\*\*\n([\s\S]*?)(?=\n\n|$)/);
                    if (match) {
                        match[1].split('\n').forEach(line => {
                            const m = line.match(/• (.+)/);
                            if (m) deductDebt(m[1].trim(), payment.totalAmount);
                        });
                    }
                }
                const updatedEmbed = EmbedBuilder.from(i.message.embeds[0])
                    .setColor(0xFFA500)
                    .setDescription(i.message.embeds[0].description.replace('⏳ Ожидание', '✅ ОПЛАЧЕНО!'));
                await i.update({ embeds: [updatedEmbed], components: [] });
                db.prepare('UPDATE treasury SET balance = balance + ? WHERE id = 1').run(payment.totalAmount);
                return i.followUp({ content: `✅ Оплата подтверждена! +${payment.totalAmount.toLocaleString()} $`, flags: [MessageFlags.Ephemeral] });
            }

            if (i.customId === 'start') {
                const modal = new ModalBuilder().setCustomId('m').setTitle('Создание контракта').addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('n').setLabel('Название').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('Ограбление')),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('nicknames').setLabel('Ники (через ;)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('Artem;Yuto')),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('bills').setLabel('Векселя (через ;)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('25;20')),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('time').setLabel('Время (ЧЧ:ММ)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('ЧЧ:ММ'))
                );
                return i.showModal(modal);
            }

            if (i.customId === 'close') {
                const msgId = i.message.id;
                const oldEmbed = i.message.embeds[0];
                if (!oldEmbed) return i.reply({ content: '❌ Не сообщение с контрактом.', flags: [MessageFlags.Ephemeral] });

                const timeField = oldEmbed.fields.find(f => f.name === 'Конец');
                if (timeField) {
                    const match = timeField.value.match(/<t:(\d+):R>/);
                    if (match && Date.now() < parseInt(match[1]) * 1000) {
                        return i.reply({ content: '❌ Рано! Таймер ещё не истёк.', flags: [MessageFlags.Ephemeral] });
                    }
                }

                let creatorId = db.prepare('SELECT creatorId FROM active_contracts WHERE msgId = ?').get(msgId)?.creatorId;
                if (!creatorId) creatorId = i.message.content.match(/<@!?(\d+)>/)?.[1] || i.user.id;

                const isAdmin = i.member.roles.cache.some(role => CONFIG.ALLOWED_ROLES.includes(role.id));
                if (i.user.id !== creatorId && !isAdmin) return i.reply({ content: '❌ Только создатель или админ.', flags: [MessageFlags.Ephemeral] });

                db.prepare('DELETE FROM active_contracts WHERE msgId = ?').run(msgId);
                db.prepare('DELETE FROM paid_markers WHERE contractTitle = ?').run(oldEmbed.title);
                db.prepare('INSERT INTO contract_history (msgId, title, status, closedAt) VALUES (?, ?, ?, ?)')
                    .run(msgId, oldEmbed.title, 'closed', Date.now());

                const participants = oldEmbed.fields.filter(f => f.name !== 'Конец' && f.name !== 'ИНСТРУКЦИЯ');
                const multiplier = participants.length >= 2 ? 0.5 : 0.5;
                const participantNames = participants.map(f => f.name);
                const membersInfo = getMembersInfo(participantNames);
                const executorMentions = membersInfo.mentions.join(' ');

                const payEmbed = new EmbedBuilder()
                    .setTitle(oldEmbed.title)
                    .setColor(0x00FF00)
                    .setDescription(
                        `**Исполнитель:** <@${creatorId}>\n\n` +
                        `<@${creatorId}>, внесите сумму в казну и приложите скриншот\n` +
                        `**Проверяющий:** ответьте \`!подтвердить\`\n` +
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

                await i.message.edit({
                    content: '✅ Статус: **УСПЕХ ✅**',
                    components: [],
                    embeds: [EmbedBuilder.from(oldEmbed).setColor(0x00FF00)]
                }).catch(() => {});

                const payChannel = await client.channels.fetch(CONFIG.PAY);
                if (payChannel) {
                    const rolePings = CONFIG.ALLOWED_ROLES.map(r => `<@&${r}>`).join(' ');
                    let pingContent = rolePings + ` | <@${creatorId}>`;
                    if (executorMentions) pingContent += ` | Исполнители: ${executorMentions}`;

                    const payMsg = await payChannel.send({
                        content: pingContent,
                        embeds: [payEmbed],
                        components: [new ActionRowBuilder().addComponents(
                            new ButtonBuilder().setCustomId('pay_confirm').setLabel('Оплатить').setStyle(ButtonStyle.Success)
                        )]
                    });
                    db.prepare(`INSERT INTO pending_payments (contractMsgId, paymentMsgId, creatorId, title, totalAmount, createdAt, deadline) VALUES (?, ?, ?, ?, ?, ?, ?)`)
                        .run(msgId, payMsg.id, creatorId, oldEmbed.title, totalPayAmount, Date.now(), Date.now() + 72 * 60 * 60 * 1000);
                }
                return i.reply({ content: '✅ Контракт закрыт, платёж создан.', flags: [MessageFlags.Ephemeral] });
            }

            if (i.customId === 'pay_confirm') {
                const messages = await i.channel.messages.fetch({ limit: 10 });
                if (!messages.some(m => m.attachments.size > 0)) return i.reply({ content: '❌ Прикрепите скриншот!', flags: [MessageFlags.Ephemeral] });
                const pendingMsg = await i.channel.send({ content: `⏳ Ожидание подтверждения...\nОплата от <@${i.user.id}>. Ответьте \`!подтвердить\`` });
                global.pendingMessages.set(i.message.id, pendingMsg.id);
                return i.update({ content: `⏳ Ожидание подтверждения...\nОплата от <@${i.user.id}>. Ответьте \`!подтвердить\``, components: [] });
            }

            if (i.customId === 'start_admin') {
                const hasRole = i.member.roles.cache.some(role => CONFIG.ALLOWED_ROLES.includes(role.id));
                if (!hasRole) return i.reply({ content: '❌ Нет прав.', flags: [MessageFlags.Ephemeral] });
                if (i.channelId !== process.env.ADMIN_PICK) return i.reply({ content: '❌ Только в админ-канале.', flags: [MessageFlags.Ephemeral] });
                const modal = new ModalBuilder().setCustomId('admin_m').setTitle('Создание контракта (админ)')
                    .addComponents(
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('userId').setLabel('ID пользователя').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('123456789012345678')),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('n').setLabel('Название').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('Ограбление')),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('nicknames').setLabel('Ники (через ;)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('Artem;Yuto')),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('bills').setLabel('Векселя (через ;)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('25;20')),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('time').setLabel('Время (ЧЧ:ММ)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('ЧЧ:ММ'))
                    );
                return i.showModal(modal);
            }
        }

        // ===== МОДАЛКИ =====
        if (i.isModalSubmit() && i.customId === 'm') {
            await i.deferReply({ flags: [MessageFlags.Ephemeral] });
            const name = i.fields.getTextInputValue('n').trim();
            const nicknamesRaw = i.fields.getTextInputValue('nicknames').trim();
            const billsRaw = i.fields.getTextInputValue('bills').trim();
            const timeRaw = i.fields.getTextInputValue('time').trim();

            if (!/^[а-яА-ЯёЁ\s]+$/.test(name)) return i.editReply('❌ Название на кириллице.');
            if (!/^[a-zA-Z_\s;]+$/.test(nicknamesRaw)) return i.editReply('❌ Ники: латиница, _, ;');
            if (!/^[0-9;]+$/.test(billsRaw)) return i.editReply('❌ Векселя: цифры и ;');
            if (!/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(timeRaw)) return i.editReply('❌ Время: ЧЧ:ММ');

            const nicknames = nicknamesRaw.split(';');
            const bills = billsRaw.split(';');
            if (nicknames.length !== bills.length) return i.editReply('❌ Количество ников != векселей.');

            const [h, m] = timeRaw.split(':').map(Number);
            const endTime = Date.now() + (h * 60 + m) * 60 * 1000;

            const embed = new EmbedBuilder().setTitle(name).setColor(0x0099FF);
            nicknames.forEach((nick, idx) => embed.addFields({ name: nick.trim(), value: `Векселей: ${bills[idx] || 0}`, inline: false }));
            embed.addFields({ name: 'Конец', value: `<t:${Math.floor(endTime / 1000)}:R>`, inline: false });
            embed.addFields({ name: 'ИНСТРУКЦИЯ', value: 'После таймера нажмите "Закрыть контракт"', inline: false });

            const membersInfo = getMembersInfo(nicknames);
            const executorMentions = membersInfo.mentions.join(' ');

            const processChannel = await client.channels.fetch(CONFIG.PROCESS);
            let content = `Контракт взял: <@${i.user.id}>`;
            if (executorMentions) content += ` | Исполнители: ${executorMentions}`;

            const msg = await processChannel.send({
                content: content,
                embeds: [embed],
                components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('close').setLabel('Закрыть контракт').setStyle(ButtonStyle.Primary))]
            });

            db.prepare('INSERT OR REPLACE INTO active_contracts (msgId, creatorId, endTime, channelId) VALUES (?, ?, ?, ?)').run(msg.id, i.user.id, endTime, msg.channelId);
            setupTimer(client, msg.channel, i.user.id, endTime);
            console.log(`[RESULT] Контракт "${name}" создан от ${i.user.tag}`);
            return i.editReply('✅ Контракт создан!');
        }

        if (i.isModalSubmit() && i.customId === 'admin_m') {
            await i.deferReply({ flags: [MessageFlags.Ephemeral] });
            const userId = i.fields.getTextInputValue('userId').trim();
            const name = i.fields.getTextInputValue('n').trim();
            const nicknamesRaw = i.fields.getTextInputValue('nicknames').trim();
            const billsRaw = i.fields.getTextInputValue('bills').trim();
            const timeRaw = i.fields.getTextInputValue('time').trim();

            if (!/^\d+$/.test(userId)) return i.editReply('❌ ID только цифры.');
            if (!/^[а-яА-ЯёЁ\s]+$/.test(name)) return i.editReply('❌ Название на кириллице.');
            if (!/^[a-zA-Z_\s;]+$/.test(nicknamesRaw)) return i.editReply('❌ Ники: латиница, _, ;');
            if (!/^[0-9;]+$/.test(billsRaw)) return i.editReply('❌ Векселя: цифры и ;');
            if (!/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(timeRaw)) return i.editReply('❌ Время: ЧЧ:ММ');

            const nicknames = nicknamesRaw.split(';');
            const bills = billsRaw.split(';');
            if (nicknames.length !== bills.length) return i.editReply('❌ Количество ников != векселей.');

            const [h, m] = timeRaw.split(':').map(Number);
            const endTime = Date.now() + (h * 60 + m) * 60 * 1000;

            const embed = new EmbedBuilder().setTitle(name).setColor(0x0099FF);
            nicknames.forEach((nick, idx) => embed.addFields({ name: nick.trim(), value: `Векселей: ${bills[idx] || 0}`, inline: false }));
            embed.addFields({ name: 'Конец', value: `<t:${Math.floor(endTime / 1000)}:R>`, inline: false });
            embed.addFields({ name: 'ИНСТРУКЦИЯ', value: 'После таймера нажмите "Закрыть контракт"', inline: false });

            const membersInfo = getMembersInfo(nicknames);
            const executorMentions = membersInfo.mentions.join(' ');

            const processChannel = await client.channels.fetch(CONFIG.PROCESS);
            let content = `Контракт взял: <@${userId}>`;
            if (executorMentions) content += ` | Исполнители: ${executorMentions}`;

            const msg = await processChannel.send({
                content: content,
                embeds: [embed],
                components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('close').setLabel('Закрыть контракт').setStyle(ButtonStyle.Primary))]
            });

            db.prepare('INSERT OR REPLACE INTO active_contracts (msgId, creatorId, endTime, channelId) VALUES (?, ?, ?, ?)').run(msg.id, userId, endTime, msg.channelId);
            setupTimer(client, msg.channel, userId, endTime);
            console.log(`[RESULT] Контракт "${name}" создан админом ${i.user.tag} от ${userId}`);
            return i.editReply(`✅ Контракт создан от <@${userId}>!`);
        }

    } catch (err) {
        console.error('Ошибка взаимодействия:', err);
    }
});

// ========== ЗАВЕРШЕНИЕ ==========
const shutdown = () => {
    try { db.close(); } catch (err) { console.error(err); }
    client.destroy();
    process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

client.login(process.env.TOKEN);