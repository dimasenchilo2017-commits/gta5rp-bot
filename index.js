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
    addToWallet, getWallet, payFromWallet,
    logAction, logCommand, logButton, logModal, logMessage
} = require('./functions.js');

const CONFIG = {
    PICK: process.env.PICK,
    PROCESS: process.env.PROCESS,
    PAY: process.env.PAY,
    ALLOWED_ROLES: process.env.ALLOWED_ROLES ? process.env.ALLOWED_ROLES.split(',') : []
};

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
if (!global.pendingMessages) global.pendingMessages = new Map();
if (!global.pendingPayments) global.pendingPayments = new Map();

process.on('unhandledRejection', error => console.error('Unhandled rejection:', error));
process.on('uncaughtException', err => console.error('Uncaught exception:', err));

// ========== ЗАПУСК ==========
client.once('clientReady', async () => {
    logAction('SYSTEM', client.user, 'Бот запускается');
    
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
    logAction('SYSTEM', client.user, 'Команды зарегистрированы');

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
                logAction('TIMER', { id: contract.creatorId }, `Контракт ${contract.msgId} удалён по таймауту`);
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
                logAction('SYSTEM', client.user, 'Админ-панель отправлена');
            }
        } catch (err) { console.error('[ERROR] Админ-панель:', err); }
    }
});

// ========== СООБЩЕНИЯ ==========
client.on('messageCreate', async msg => {
    if (msg.author.bot) return;
    
    if (msg.content.startsWith('!импорт_контракт') || msg.content.startsWith('!закрыть_контракт') || msg.content.startsWith('!список')) {
        logMessage(msg);
        const hasRole = msg.member.roles.cache.some(role => CONFIG.ALLOWED_ROLES.includes(role.id));
        if (!hasRole) {
            logAction('WARN', msg.author, `Нет прав на ${msg.content}`);
            return await msg.reply('❌ Нет прав.');
        }
        if (msg.content.startsWith('!список')) {
            const contracts = db.prepare('SELECT msgId, creatorId, endTime FROM active_contracts').all();
            console.log(`\n📋 АКТИВНЫЕ КОНТРАКТЫ (${contracts.length}):`);
            contracts.forEach(c => console.log(` • ${c.msgId} | ${c.creatorId} | ${Math.round((c.endTime - Date.now()) / 60000)} мин.`));
            logAction('ADMIN', msg.author, `!список (${contracts.length} контрактов)`);
            return await msg.reply('✅ Список в консоль.');
        }
        if (!msg.reference) return await msg.reply('❌ Ответь на сообщение!');
        try {
            const targetMsg = await msg.channel.messages.fetch(msg.reference.messageId);
            if (msg.content.startsWith('!импорт_контракт')) {
                db.prepare('INSERT OR REPLACE INTO active_contracts (msgId, creatorId, endTime, channelId) VALUES (?, ?, ?, ?)')
                    .run(targetMsg.id, targetMsg.author.id, Date.now() + 86400000, targetMsg.channelId);
                logAction('ADMIN', msg.author, `Импортирован контракт ${targetMsg.id}`);
                await msg.reply('✅ Импортировано.');
            }
            if (msg.content.startsWith('!закрыть_контракт')) {
                db.prepare('DELETE FROM active_contracts WHERE msgId = ?').run(targetMsg.id);
                await targetMsg.edit({ components: [] });
                logAction('ADMIN', msg.author, `Закрыт контракт ${targetMsg.id}`);
                await msg.reply('✅ Закрыто.');
            }
        } catch (err) { await msg.reply('❌ Ошибка.'); }
        return;
    }

    // !подтвердить - ОБНОВЛЁННЫЙ С ПОИСКОМ ПО УПОМИНАНИЮ
    if (msg.channel.id === CONFIG.PAY && msg.content.trim() === '!подтвердить') {
        logMessage(msg);
        const hasRole = msg.member.roles.cache.some(role => CONFIG.ALLOWED_ROLES.includes(role.id));
        if (!hasRole) {
            logAction('WARN', msg.author, 'Нет прав на !подтвердить');
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

            const paymentData = global.pendingPayments?.get(targetMsg.id);
            if (!paymentData) {
                const reply = await msg.reply('❌ Нет данных об оплате.');
                setTimeout(async () => { await msg.delete().catch(() => {}); await reply.delete().catch(() => {}); }, 3000);
                return;
            }

            const { participantName, amount, buttonMessageId, buttonCustomId, contractTitle } = paymentData;
            
            if (amount <= 0) {
                const reply = await msg.reply('❌ Сумма не найдена.');
                setTimeout(async () => { await msg.delete().catch(() => {}); await reply.delete().catch(() => {}); }, 3000);
                return;
            }

            // [!] ПОЛУЧАЕМ УПОМИНАНИЕ ДЛЯ ПОИСКА В ЭМБЕДЕ
            const memberInfo2 = getMembersInfo([participantName]);
            const mention2 = memberInfo2.mentions.length > 0 ? memberInfo2.mentions[0] : null;
            const searchPatterns2 = [participantName];
            if (mention2) searchPatterns2.push(mention2);

            logAction('PAYMENT', msg.author, `${participantName} | ${amount.toLocaleString()}$`);

            deductDebt(participantName, amount);
            db.prepare('UPDATE treasury SET balance = balance + ? WHERE id = 1').run(amount);
            db.prepare('DELETE FROM pending_payments WHERE paymentMsgId = ?').run(buttonCustomId);

            let buttonMsg = null;
            try {
                buttonMsg = await msg.channel.messages.fetch(buttonMessageId);
                if (buttonMsg && buttonMsg.components && buttonMsg.components.length > 0) {
                    const rows = buttonMsg.components;
                    let updated = false;
                    for (const row of rows) {
                        for (const comp of row.components) {
                            if (comp.customId === buttonCustomId) {
                                const disabledButton = ButtonBuilder.from(comp).setDisabled(true);
                                const index = row.components.indexOf(comp);
                                row.components[index] = disabledButton;
                                updated = true;
                                break;
                            }
                        }
                        if (updated) break;
                    }
                    if (updated) {
                        const embed = buttonMsg.embeds[0];
                        if (embed) {
                            const desc = embed.description || '';
                            const lines = desc.split('\n');
                            let newLines = [];
                            let inDebtSection = false;
                            for (const line of lines) {
                                if (line.includes('**Долги участников:**') || line.includes('Долги участников:')) {
                                    inDebtSection = true;
                                    newLines.push(line);
                                    continue;
                                }
                                if (inDebtSection && (line.trim().startsWith('•') || line.trim().startsWith('-'))) {
                                    const matches = searchPatterns2.some(pattern => line.includes(pattern));
                                    if (matches) {
                                        const cleanLine = line.replace(/^[•-\s]+/, '').trim();
                                        newLines.push(`   • ~~${cleanLine}~~ ✅`);
                                    } else {
                                        newLines.push(line);
                                    }
                                } else {
                                    newLines.push(line);
                                }
                            }
                            const newDesc = newLines.join('\n');
                            const newEmbed = EmbedBuilder.from(embed).setDescription(newDesc);
                            await buttonMsg.edit({ embeds: [newEmbed], components: rows });
                        } else {
                            await buttonMsg.edit({ components: rows });
                        }
                    }
                }
            } catch (err) {
                console.warn('Не удалось обновить сообщение с кнопками:', err);
            }

            // [!] ПРОВЕРЯЕМ, ВСЕ ЛИ ОПЛАТИЛИ
            if (buttonMsg) {
                try {
                    const freshMsg = await msg.channel.messages.fetch(buttonMessageId);
                    if (freshMsg && freshMsg.components) {
                        let allDisabled = true;
                        for (const row of freshMsg.components) {
                            for (const comp of row.components) {
                                if (comp.customId && comp.customId.startsWith('pay_') && !comp.disabled) {
                                    allDisabled = false;
                                    break;
                                }
                            }
                            if (!allDisabled) break;
                        }
                     
                        if (allDisabled) {
                            const embed = freshMsg.embeds[0];
                            if (embed) {
                                const desc = embed.description || '';
                                const lines = desc.split('\n');
                                let newLines = [];
                                let inDebtSection = false;
                                for (const line of lines) {
                                    if (line.includes('**Долги участников:**') || line.includes('Долги участников:')) {
                                        inDebtSection = true;
                                        newLines.push(line);
                                        continue;
                                    }
                                    if (inDebtSection && (line.trim().startsWith('•') || line.trim().startsWith('-'))) {
                                        if (!line.includes('~~')) {
                                            const cleanLine = line.replace(/^[•-\s]+/, '').trim();
                                            newLines.push(`   • ~~${cleanLine}~~ ✅`);
                                        } else {
                                            newLines.push(line);
                                        }
                                    } else {
                                        newLines.push(line);
                                    }
                                }
                                newLines.push('\n✅ **ВСЕ ОПЛАЧЕНО!** 🎉');
                                const newDesc = newLines.join('\n');
                                const newEmbed = EmbedBuilder.from(embed).setDescription(newDesc);
                                
                                await freshMsg.edit({ 
                                    embeds: [newEmbed], 
                                    components: [] 
                                });
                                
                                db.prepare(`INSERT INTO paid_markers (debtorName, contractTitle, amount, markedBy, createdAt) VALUES (?, ?, ?, ?, ?)`)
                                    .run('ВСЕ УЧАСТНИКИ', contractTitle || 'Неизвестный контракт', 0, 'SYSTEM', Date.now());
                            }
                        }
                    }
                } catch (err) {
                    console.warn('Не удалось проверить все оплаты:', err);
                }
            }

            const pendingMsgId = global.pendingMessages?.get(targetMsg.id);
            if (pendingMsgId) {
                try {
                    const pendingMsg = await msg.channel.messages.fetch(pendingMsgId);
                    if (pendingMsg) await pendingMsg.delete();
                } catch (err) {}
                global.pendingMessages.delete(targetMsg.id);
            }

            global.pendingPayments.delete(targetMsg.id);

            const replyMsg = await msg.reply(`✅ Оплата для **${participantName}** подтверждена! (${amount.toLocaleString()} $)`);
            setTimeout(async () => {
                await msg.delete().catch(() => {});
                await replyMsg.delete().catch(() => {});
            }, 5000);

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
        logAction('DELETE', msg.author, `Автоудаление в #${msg.channel.name}: "${msg.content.substring(0, 50)}"`);
    }
});

// ========== ИНТЕРАКЦИИ ==========
client.on('interactionCreate', async i => {
    try {
        // ===== КОНТЕКСТНОЕ МЕНЮ =====
        if (i.isMessageContextMenuCommand()) {
            logAction('CONTEXT', i.user, `${i.commandName} | msg: ${i.targetMessage.id}`);
            const hasRole = i.member.roles.cache.some(role => CONFIG.ALLOWED_ROLES.includes(role.id));
            if (!hasRole) return i.reply({ content: '❌ Нет прав.', flags: [MessageFlags.Ephemeral] });

            if (i.commandName === 'Импортировать контракт') {
                const targetMsg = i.targetMessage;
                const mentionMatch = targetMsg.content.match(/<@!?(\d+)>/);
                let creatorId = mentionMatch ? mentionMatch[1] : targetMsg.author.id;
                db.prepare('INSERT OR REPLACE INTO active_contracts (msgId, creatorId, endTime, channelId) VALUES (?, ?, ?, ?)')
                    .run(targetMsg.id, creatorId, Date.now() + 86400000, targetMsg.channelId);
                logAction('IMPORT', i.user, `Контракт ${targetMsg.id} от ${creatorId}`);
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

                await i.targetMessage.edit({
                    content: `✅ Статус: **УСПЕХ ✅**`,
                    components: [],
                    embeds: [EmbedBuilder.from(oldEmbed).setColor(0x00FF00)]
                }).catch(() => {});

                const payChannel = await client.channels.fetch(CONFIG.PAY);
                if (!payChannel) return i.editReply('❌ Канал оплаты не найден.');

                const paymentData = [];
                for (const participant of participants) {
                    const name = participant.name;
                    const billValue = parseInt(participant.value.replace(/\D/g, '')) || 0;
                    const toPay = Math.round(billValue * 1000 * multiplier);
                    if (toPay <= 0) continue;
                    
                    paymentData.push({ name, amount: toPay });
                    db.prepare('INSERT OR REPLACE INTO debtors (name, amount) VALUES (?, IFNULL((SELECT amount FROM debtors WHERE name = ?), 0) + ?)')
                        .run(name, name, toPay);
                }

                if (paymentData.length === 0) return i.editReply('❌ Нет участников для оплаты.');

                let description = `**Исполнители:** ${executorMentions}\n\n`;
                description += `Каждый участник должен оплатить свою долю в течение 72 часов.\n`;
                description += `Проверяющий: после оплаты участника нажмите кнопку и ответьте \`!подтвердить\`\n\n`;
                description += `**Долги участников:**\n`;
                
                const buttons = [];
                for (const p of paymentData) {
                    const memberInfo = getMembersInfo([p.name]);
                    const memberMention = memberInfo.mentions.length > 0 ? memberInfo.mentions[0] : p.name;
                    description += `• ${memberMention}: **${p.amount.toLocaleString()} $**\n`;
                    
                    const uniqueId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
                    const customId = `pay_${uniqueId}`;
                    buttons.push(
                        new ButtonBuilder()
                            .setCustomId(customId)
                            .setLabel(`Оплатить ${p.name}`)
                            .setStyle(ButtonStyle.Success)
                    );
                }

                const payEmbed = new EmbedBuilder()
                    .setTitle(oldEmbed.title)
                    .setColor(0x00FF00)
                    .setDescription(description);

                const rows = [];
                for (let i = 0; i < buttons.length; i += 5) {
                    rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
                }

                const payMsg = await payChannel.send({
                    content: CONFIG.ALLOWED_ROLES.map(r => `<@&${r}>`).join(' ') + ` | ${executorMentions}`,
                    embeds: [payEmbed],
                    components: rows
                });

                for (let i = 0; i < paymentData.length; i++) {
                    const p = paymentData[i];
                    const customId = buttons[i].data.custom_id;
                    db.prepare(`INSERT INTO pending_payments (contractMsgId, paymentMsgId, creatorId, title, totalAmount, createdAt, deadline) VALUES (?, ?, ?, ?, ?, ?, ?)`)
                        .run(
                            msgId, 
                            customId,
                            contract.creatorId, 
                            `${oldEmbed.title} - ${p.name}`, 
                            p.amount, 
                            Date.now(), 
                            Date.now() + 72 * 60 * 60 * 1000
                        );
                }

                logAction('CONTRACT_CLOSE', i.user, `${oldEmbed.title} | ${paymentData.length} участников`);
                return i.editReply(`✅ Контракт закрыт, созданы кнопки для ${paymentData.length} участников.`);
            }

            if (i.commandName === 'Напомнить о закрытии') {
                await i.deferReply({ flags: [MessageFlags.Ephemeral] });
                const targetMsg = i.targetMessage;
                let contractName = targetMsg.embeds?.[0]?.title || 'Контракт';
                let creatorId = targetMsg.content.match(/<@!?(\d+)>/)?.[1] || db.prepare('SELECT creatorId FROM active_contracts WHERE msgId = ?').get(targetMsg.id)?.creatorId;
                if (!creatorId) return i.editReply('❌ Не найден создатель.');
                await targetMsg.reply(`⚠️ **НАПОМИНАНИЕ!** Контракт **«${contractName}»** (ID: ${targetMsg.id}) уже должен быть закрыт. <@${creatorId}>`);
                logAction('REMINDER', i.user, `${contractName} | ${targetMsg.id}`);
                return i.editReply('✅ Напоминание отправлено.');
            }

            if (i.commandName === 'Принудительно оплатить') {
                await i.deferReply({ flags: [MessageFlags.Ephemeral] });
                const targetMsg = i.targetMessage;
                if (!targetMsg.embeds?.[0]?.description) return i.editReply('❌ Не сообщение с платежом.');

                const embed = targetMsg.embeds[0];
                const description = embed.description || '';
                const lines = description.split('\n');
                const participants = [];
                let totalPaid = 0;
                
                for (const line of lines) {
                    if (line.includes('**') && line.includes('$')) {
                        const nameMatch = line.match(/\*\*([^*]+)\*\*/);
                        const amountMatch = line.match(/\*\*([\d, ]+)\s*\$?/);
                        if (nameMatch && amountMatch) {
                            const name = nameMatch[1].trim().replace(/<@!?\d+>/g, '').trim();
                            const amount = parseInt(amountMatch[1].replace(/\s/g, ''));
                            if (amount > 0 && name) {
                                participants.push({ name, amount });
                                totalPaid += amount;
                            }
                        }
                    }
                }

                if (participants.length === 0) {
                    return i.editReply('❌ Нет участников для принудительной оплаты.');
                }

                for (const p of participants) {
                    deductDebt(p.name, p.amount);
                }
                
                db.prepare('DELETE FROM debtors WHERE amount <= 0').run();
                if (totalPaid > 0) db.prepare('UPDATE treasury SET balance = balance + ? WHERE id = 1').run(totalPaid);
                db.prepare('DELETE FROM pending_payments WHERE contractMsgId = ?').run(targetMsg.id);

                await targetMsg.edit({ 
                    content: `✅ Принудительно оплачено! Проверяющий: <@${i.user.id}>`, 
                    components: [] 
                }).catch(() => {});
                
                logAction('FORCE_PAY', i.user, `${participants.length} участников | ${totalPaid.toLocaleString()}$`);
                return i.editReply(`✅ Принудительная оплата проведена! Сумма: ${totalPaid.toLocaleString()} $`);
            }

            if (i.commandName === 'Импортировать оплату') {
                await i.deferReply({ flags: [MessageFlags.Ephemeral] });
                const targetMsg = i.targetMessage;
                
                if (!targetMsg.embeds?.[0]?.description) {
                    return i.editReply('❌ Не сообщение с платежом.');
                }

                const embed = targetMsg.embeds[0];
                const contractTitle = embed?.title || 'Неизвестный контракт';
                const description = embed.description || '';
                
                // [!] НАХОДИМ СОЗДАТЕЛЯ
                let creatorId = targetMsg.content.match(/<@!?(\d+)>/)?.[1] || 
                                db.prepare('SELECT creatorId FROM active_contracts WHERE msgId = ?').get(targetMsg.id)?.creatorId;
                if (!creatorId) {
                    return i.editReply('❌ Не найден создатель контракта.');
                }
                
                // [!] ПРОВЕРЯЕМ, НЕТ ЛИ УЖЕ В БД
                if (db.prepare('SELECT 1 FROM pending_payments WHERE contractMsgId = ?').get(targetMsg.id)) {
                    return i.editReply('⚠️ Этот контракт уже импортирован в БД.');
                }

                // [!] ИЗВЛЕКАЕМ УЧАСТНИКОВ И ИХ ДОЛГИ
                const lines = description.split('\n');
                const participants = [];
                let inDebtSection = false;
                let totalAmount = 0;
                
                for (const line of lines) {
                    // Ищем секцию с долгами
                    if (line.includes('**Долги участников:**') || line.includes('Долги участников:')) {
                        inDebtSection = true;
                        continue;
                    }
                    
                    if (inDebtSection && (line.trim().startsWith('•') || line.trim().startsWith('-'))) {
                        // Парсим строку типа: "• Artem: **25 000 $**" или "• <@123>: **25 000 $**"
                        const cleanLine = line.replace(/^[•-\s]+/, '').trim();
                        
                        // Извлекаем имя (до двоеточия)
                        const nameMatch = cleanLine.match(/^([^:]+):/);
                        if (!nameMatch) continue;
                        
                        const rawName = nameMatch[1].trim();
                        // Убираем упоминания из имени
                        const name = rawName.replace(/<@!?\d+>/g, '').trim();
                        
                        // Извлекаем сумму (в ** или просто число)
                        let amount = 0;
                        const amountMatch = cleanLine.match(/\*\*([\d, ]+)\s*\$?/);
                        if (amountMatch) {
                            amount = parseInt(amountMatch[1].replace(/\s/g, ''));
                        } else {
                            // Если без **, ищем просто число с $
                            const simpleMatch = cleanLine.match(/([\d, ]+)\s*\$?/);
                            if (simpleMatch) {
                                amount = parseInt(simpleMatch[1].replace(/\s/g, ''));
                            }
                        }
                        
                        if (amount > 0 && name) {
                            participants.push({ name, amount });
                            totalAmount += amount;
                        }
                    }
                }

                if (participants.length === 0) {
                    return i.editReply('❌ Не найдены участники для оплаты.');
                }

                // [!] СОХРАНЯЕМ В БД и СОЗДАЁМ КНОПКИ
                const payChannel = await client.channels.fetch(CONFIG.PAY);
                if (!payChannel) {
                    return i.editReply('❌ Канал оплаты не найден.');
                }

                // Добавляем должников
                for (const p of participants) {
                    db.prepare('INSERT OR REPLACE INTO debtors (name, amount) VALUES (?, IFNULL((SELECT amount FROM debtors WHERE name = ?), 0) + ?)')
                        .run(p.name, p.name, p.amount);
                }

                // Формируем эмбед для оплаты
                let description2 = `**Исполнители:** ${targetMsg.content.match(/<@!?(\d+)>/g)?.join(' ') || 'Неизвестно'}\n\n`;
                description2 += `Каждый участник должен оплатить свою долю в течение 72 часов.\n`;
                description2 += `Проверяющий: после оплаты участника нажмите кнопку и ответьте \`!подтвердить\`\n\n`;
                description2 += `**Долги участников:**\n`;
                
                const buttons = [];
                const paymentData = [];
                
                for (const p of participants) {
                    // Находим discord ID для упоминания
                    const memberInfo = getMembersInfo([p.name]);
                    const memberMention = memberInfo.mentions.length > 0 ? memberInfo.mentions[0] : p.name;
                    description2 += `• ${memberMention}: **${p.amount.toLocaleString()} $**\n`;
                    
                    const uniqueId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
                    const customId = `pay_${uniqueId}`;
                    buttons.push(
                        new ButtonBuilder()
                            .setCustomId(customId)
                            .setLabel(`Оплатить ${p.name}`)
                            .setStyle(ButtonStyle.Success)
                    );
                    
                    paymentData.push({
                        name: p.name,
                        amount: p.amount,
                        customId: customId
                    });
                }

                const payEmbed = new EmbedBuilder()
                    .setTitle(contractTitle)
                    .setColor(0x00FF00)
                    .setDescription(description2);

                const rows = [];
                for (let i = 0; i < buttons.length; i += 5) {
                    rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
                }

                const payMsg = await payChannel.send({
                    content: CONFIG.ALLOWED_ROLES.map(r => `<@&${r}>`).join(' ') + ` | ${targetMsg.content.match(/<@!?(\d+)>/g)?.join(' ') || ''}`,
                    embeds: [payEmbed],
                    components: rows
                });

                // Сохраняем в pending_payments
                for (const p of paymentData) {
                    db.prepare(`INSERT INTO pending_payments (contractMsgId, paymentMsgId, creatorId, title, totalAmount, createdAt, deadline) VALUES (?, ?, ?, ?, ?, ?, ?)`)
                        .run(
                            targetMsg.id, 
                            p.customId,
                            creatorId, 
                            `${contractTitle} - ${p.name}`, 
                            p.amount, 
                            Date.now(), 
                            Date.now() + 72 * 60 * 60 * 1000
                        );
                }

                logAction('IMPORT_PAY', i.user, `${contractTitle} | ${participants.length} участников | ${totalAmount.toLocaleString()}$`);
                
                return i.editReply(`✅ Оплата "${contractTitle}" импортирована!\n` +
                                `👥 Участников: ${participants.length}\n` +
                                `💰 Общая сумма: ${totalAmount.toLocaleString()} $\n` +
                                `📌 Кнопки созданы в <#${payChannel.id}>`);
            }
        }

        // ===== СЛЭШ-КОМАНДЫ =====
        if (i.isChatInputCommand()) {
            const options = i.options.data.map(o => `${o.name}:${o.value}`).join(' ');
            logCommand(i, options);

            if (i.commandName !== 'ожидают') {
                const hasRole = i.member.roles.cache.some(role => CONFIG.ALLOWED_ROLES.includes(role.id));
                if (!hasRole) {
                    logAction('WARN', i.user, `Нет прав на /${i.commandName}`);
                    return i.reply({ content: '❌ Нет прав.', flags: [MessageFlags.Ephemeral] });
                }
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
                    logAction('TREASURY', i.user, `Проверка казны: ${(row?.balance || 0).toLocaleString()}$`);
                    return i.reply({ content: `💰 Баланс: **${(row?.balance || 0).toLocaleString()} $**`, flags: [MessageFlags.Ephemeral] });
                }

                case 'должники': {
                    const debtors = db.prepare('SELECT * FROM debtors').all();
                    const text = debtors.length ? debtors.map(d => `• **${d.name}**: ${d.amount.toLocaleString()}$`).join('\n') : 'Должников нет.';
                    logAction('DEBTORS', i.user, `${debtors.length} должников`);
                    return i.reply({ content: `📋 **Список должников:**\n${text}`, flags: [MessageFlags.Ephemeral] });
                }

                case 'вызвать': {
                    if (i.channelId !== CONFIG.PICK) return i.reply({ content: '❌ Только в канале пика!', flags: [MessageFlags.Ephemeral] });
                    logAction('COMMAND', i.user, '/вызвать');
                    return i.reply({
                        content: "Правила работы с контрактами Minoru\nУважаемые<@&1373750905274630275><@&1373750899649806449><@&1392858292925108254>, ознакомьтесь с правилами работы. Вы обязаны следить за каналами <#1526654909452390531> и <#1403074323614404738> на наличие вашего никнейма.\n\n1. 📝 Создание контракта 📝\nПосле того как вы взяли контракт в игре, нажмите кнопку [Создать контракт] под этим сообщением.\nВ открывшейся панели заполните все необходимые данные по контракту.\n2. ⚖️ Процентные ставки ⚖️\n**Соло-контракт:** 50% (успех)\n**Группа (2+ человека):** 50% (успех).\nНа контракты пикнутые не в 100% сразу будет налогаться штраф в виде фиксированной суммы 50.000$ В случае успеха контракта, будет все так-же процентно для соло или группы.\n3. 💰 Оплата и штрафы 💰\n**Скриншот:** Присылается в обязательном порядке.\n**Срок оплаты:** 72 часа с момента создания контракта.\n**Просрочка (72ч+):** Сумма увеличивается в 1.25 раза. На оплату этой суммы дается еще 48 часов.\n**Критическая просрочка (120ч+):** Накладывается «мороз» на 48 часов + сумма еще увеличивается в 1.25 раза. Если оплата не поступит в этот срок — АФК-ранг до погашения долга.\n4. ⚠️ Регистрация контрактов ⚠️\nРегистрация контракта **обязательна**. Если контракт завершен, а данных о нем нет в канале — на игрока накладывается штраф: 30% от полученной суммы.\nЕсли у вас вдруг не видно канала <#1526654909452390531> То можно нажать на его название в этом канале и перейти.\n\nПо всем вопросам обращаться к: <@702529657718833162>",
                        components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('start').setLabel('Создать контракт').setStyle(ButtonStyle.Primary))]
                    });
                }

                case 'удалить_контракт': {
                    const msgId = i.options.getString('msgid');
                    const result = db.prepare('DELETE FROM active_contracts WHERE msgId = ?').run(msgId);
                    logAction('DELETE_CONTRACT', i.user, `${msgId} | ${result.changes > 0 ? 'удалён' : 'не найден'}`);
                    return i.reply({ content: result.changes > 0 ? `✅ Удалён ID \`${msgId}\`` : `❌ Не найден.`, flags: [MessageFlags.Ephemeral] });
                }

                case 'чек_контракты': {
                    const contracts = db.prepare('SELECT * FROM active_contracts').all();
                    for (const c of contracts) {
                        const channel = await client.channels.fetch(c.channelId);
                        setupTimer(client, channel, c.creatorId, c.endTime);
                    }
                    logAction('CHECK_TIMERS', i.user, `${contracts.length} контрактов проверено`);
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
                    logAction('MANUAL_PAY', i.user, `${title} | ${amount.toLocaleString()}$ | ${names.length} участников`);
                    return i.reply({ content: `✅ Оплата внесена!`, flags: [MessageFlags.Ephemeral] });
                }

                case 'отметить_оплачено': {
                    const nick = i.options.getString('ник');
                    const contractTitle = i.options.getString('контракт');
                    const amount = i.options.getInteger('сумма');
                    const existing = db.prepare(`SELECT 1 FROM paid_markers WHERE debtorName = ? AND contractTitle = ? AND amount = ?`).get(nick, contractTitle, amount);
                    if (existing) return i.reply({ content: `⚠️ Уже есть отметка.`, flags: [MessageFlags.Ephemeral] });
                    db.prepare(`INSERT INTO paid_markers (debtorName, contractTitle, amount, markedBy, createdAt) VALUES (?, ?, ?, ?, ?)`).run(nick, contractTitle, amount, i.user.id, Date.now());
                    logAction('MARK_PAID', i.user, `${nick} | ${contractTitle} | ${amount.toLocaleString()}$`);
                    return i.reply({ content: `✅ Отметка добавлена.`, flags: [MessageFlags.Ephemeral] });
                }

                case 'убрать_отметку': {
                    const nick = i.options.getString('ник');
                    const contractTitle = i.options.getString('контракт');
                    const amount = i.options.getInteger('сумма');
                    const existing = db.prepare(`SELECT 1 FROM paid_markers WHERE debtorName = ? AND contractTitle = ? AND amount = ?`).get(nick, contractTitle, amount);
                    if (!existing) return i.reply({ content: `❌ Отметка не найдена.`, flags: [MessageFlags.Ephemeral] });
                    db.prepare(`DELETE FROM paid_markers WHERE debtorName = ? AND contractTitle = ? AND amount = ?`).run(nick, contractTitle, amount);
                    logAction('UNMARK_PAID', i.user, `${nick} | ${contractTitle} | ${amount.toLocaleString()}$`);
                    return i.reply({ content: `✅ Отметка удалена.`, flags: [MessageFlags.Ephemeral] });
                }

                case 'внести_в_кошелек': {
                    const playerName = i.options.getString('ник');
                    const amount = i.options.getInteger('сумма');
                    if (amount <= 0) return i.reply({ content: '❌ Сумма > 0.', flags: [MessageFlags.Ephemeral] });
                    const newBalance = addToWallet(playerName, amount);
                    logAction('WALLET_ADD', i.user, `${playerName} | +${amount.toLocaleString()}$ | Баланс: ${newBalance.balance.toLocaleString()}$`);
                    return i.reply({ content: `✅ Кошелёк **${playerName}** пополнен на ${amount.toLocaleString()} $.\n💰 Баланс: ${newBalance.balance.toLocaleString()} $`, flags: [MessageFlags.Ephemeral] });
                }

                case 'кошелек': {
                    const playerName = i.options.getString('ник');
                    const wallet = getWallet(playerName);
                    if (!wallet) return i.reply({ content: `❌ Кошелёк не найден.`, flags: [MessageFlags.Ephemeral] });
                    logAction('WALLET_CHECK', i.user, `${playerName} | Баланс: ${wallet.balance.toLocaleString()}$`);
                    return i.reply({ content: `💰 **${playerName}**\nБаланс: ${wallet.balance.toLocaleString()} $\n📅 ${new Date(wallet.updatedAt).toLocaleString()}`, flags: [MessageFlags.Ephemeral] });
                }

                case 'оплатить_с_кошелька': {
                    const playerName = i.options.getString('ник');
                    const contractTitle = i.options.getString('контракт');
                    const amount = i.options.getInteger('сумма_долга');
                    if (amount <= 0) return i.reply({ content: '❌ Сумма > 0.', flags: [MessageFlags.Ephemeral] });
                    try {
                        const newBalance = payFromWallet(playerName, contractTitle, amount, i.user.id);
                        logAction('WALLET_PAY', i.user, `${playerName} | ${contractTitle} | -${amount.toLocaleString()}$ | Остаток: ${newBalance.balance.toLocaleString()}$`);
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
                        logAction('TREASURY_ADD', i.user, `+${amt.toLocaleString()}$`);
                        return i.reply({ content: `✅ +${amt.toLocaleString()} $`, flags: [MessageFlags.Ephemeral] });
                    }
                    if (i.commandName === 'вычесть') {
                        const balance = db.prepare('SELECT balance FROM treasury WHERE id = 1').get().balance || 0;
                        if (amt > balance) return i.reply({ content: `❌ Доступно: ${balance.toLocaleString()} $`, flags: [MessageFlags.Ephemeral] });
                        db.prepare('UPDATE treasury SET balance = balance - ? WHERE id = 1').run(amt);
                        logAction('TREASURY_SUB', i.user, `-${amt.toLocaleString()}$`);
                        return i.reply({ content: `✅ -${amt.toLocaleString()} $`, flags: [MessageFlags.Ephemeral] });
                    }
                    if (i.commandName === 'долг_добавить') {
                        db.prepare('INSERT OR REPLACE INTO debtors (name, amount) VALUES (?, ?)').run(nick, amt);
                        logAction('DEBT_ADD', i.user, `${nick} | +${amt.toLocaleString()}$`);
                        return i.reply({ content: '✅ Добавлен.', flags: [MessageFlags.Ephemeral] });
                    }
                    if (i.commandName === 'оплачено') { 
                        deductDebt(nick, amt);
                        logAction('DEBT_PAY', i.user, `${nick} | -${amt.toLocaleString()}$`);
                        return i.reply({ content: '✅ Оплачен.', flags: [MessageFlags.Ephemeral] });
                    }
                    if (i.commandName === 'оплачено_просрочка') { 
                        deductOverdue(nick, amt);
                        logAction('OVERDUE_PAY', i.user, `${nick} | -${amt.toLocaleString()}$`);
                        return i.reply({ content: '✅ Оплачена просрочка.', flags: [MessageFlags.Ephemeral] });
                    }
                    if (i.commandName === 'оплачено_крит') { 
                        deductCritical(nick, amt);
                        logAction('CRITICAL_PAY', i.user, `${nick} | -${amt.toLocaleString()}$`);
                        return i.reply({ content: '✅ Оплачена критическая.', flags: [MessageFlags.Ephemeral] });
                    }
                    break;
                }

                case 'статистика': {
                    const treasury2 = db.prepare('SELECT balance FROM treasury WHERE id = 1').get();
                    const debtorsList2 = db.prepare('SELECT name, amount FROM debtors').all();
                    const totalClosed2 = db.prepare('SELECT COUNT(*) as count FROM contract_history').get();
                    const activeCount2 = db.prepare('SELECT COUNT(*) as count FROM active_contracts').get();
                    let stats = `📊 СТАТИСТИКА (${i.user.tag})\n💰 Казна: ${(treasury2?.balance || 0).toLocaleString()} $\n👥 Должники: ${debtorsList2.length}\n📦 Закрыто: ${totalClosed2?.count || 0}\n⏳ Активных: ${activeCount2.count || 0}`;
                    console.log(stats);
                    logAction('STATS', i.user, `Запрошена статистика`);
                    return i.reply({ content: '✅ Статистика в логи.', flags: [MessageFlags.Ephemeral] });
                }

                case 'ожидают': {
                    await i.deferReply({ flags: [MessageFlags.Ephemeral] });
                    logAction('PENDING', i.user, 'Запрос ожидающих оплат');
                    
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
                    
                    const currentDebt = db.prepare('SELECT amount FROM debtors WHERE name = ?').get(nick);
                    const remainingDebt = currentDebt ? Math.max(0, currentDebt.amount - amount) : 0;
                    
                    if (remainingDebt === 0) {
                        db.prepare('DELETE FROM debtors WHERE name = ?').run(nick);
                    } else {
                        db.prepare('UPDATE debtors SET amount = ? WHERE name = ?').run(remainingDebt, nick);
                    }
                    
                    const deadline = Date.now() + 48 * 60 * 60 * 1000;
                    db.prepare(`INSERT INTO overdue (debtorName, amount, deadline, createdAt) VALUES (?, ?, ?, ?)`)
                        .run(nick, newAmount, deadline, Date.now());
                    
                    logAction('OVERDUE_ADD', i.user, `${nick} | ${amount} → ${newAmount} (×1.25)`);
                    return i.reply({ 
                        content: `✅ Штраф для **${nick}**: ${newAmount.toLocaleString()} $ (${amount.toLocaleString()} × 1.25)\n📌 Старый долг списан, просрочка добавлена отдельно.`, 
                        flags: [MessageFlags.Ephemeral] 
                    });
                }

                case 'критическая': {
                    const nick = i.options.getString('ник');
                    const amount = i.options.getInteger('сумма');
                    const newAmount = Math.round(amount * 1.25);
                    
                    const currentDebt = db.prepare('SELECT amount FROM debtors WHERE name = ?').get(nick);
                    const remainingDebt = currentDebt ? Math.max(0, currentDebt.amount - amount) : 0;
                    
                    if (remainingDebt === 0) {
                        db.prepare('DELETE FROM debtors WHERE name = ?').run(nick);
                    } else {
                        db.prepare('UPDATE debtors SET amount = ? WHERE name = ?').run(remainingDebt, nick);
                    }
                    
                    const deadline = Date.now() + 48 * 60 * 60 * 1000;
                    db.prepare(`INSERT INTO critical_overdue (debtorName, amount, deadline, createdAt) VALUES (?, ?, ?, ?)`)
                        .run(nick, newAmount, deadline, Date.now());
                    
                    logAction('CRITICAL_ADD', i.user, `${nick} | ${amount} → ${newAmount} (×1.25)`);
                    return i.reply({ 
                        content: `✅ Критическая для **${nick}**: ${newAmount.toLocaleString()} $ (${amount.toLocaleString()} × 1.25)\n📌 Старый долг списан, критическая просрочка добавлена отдельно.`, 
                        flags: [MessageFlags.Ephemeral] 
                    });
                }
                case 'очистить_контракт': {
                    const hasRole = i.member.roles.cache.some(role => CONFIG.ALLOWED_ROLES.includes(role.id));
                    if (!hasRole) {
                        logAction('WARN', i.user, 'Попытка очистить контракт без прав');
                        return i.reply({ content: '❌ Нет прав.', flags: [MessageFlags.Ephemeral] });
                    }
                    
                    const title = i.options.getString('название');
                    
                    // Считаем сколько записей будет удалено
                    const count = db.prepare('SELECT COUNT(*) as count FROM pending_payments WHERE title LIKE ?').get(`%${title}%`);
                    
                    // Удаляем из pending_payments
                    db.prepare('DELETE FROM pending_payments WHERE title LIKE ?').run(`%${title}%`);
                    
                    logAction('ADMIN', i.user, `Очищен контракт "${title}" | Удалено ${count.count} записей`);
                    return i.reply({ 
                        content: `✅ Контракт **"${title}"** очищен!\n📌 Удалено записей: ${count.count}`,
                        flags: [MessageFlags.Ephemeral] 
                    });
                    
                }
                case 'бд': {
                    const hasRole = i.member.roles.cache.some(role => CONFIG.ALLOWED_ROLES.includes(role.id));
                    if (!hasRole) {
                        logAction('WARN', i.user, 'Попытка использовать /бд без прав');
                        return i.reply({ content: '❌ Нет прав.', flags: [MessageFlags.Ephemeral] });
                    }
                    
                    const table = i.options.getString('таблица');
                    const nick = i.options.getString('ник');
                    
                    let rows = [];
                    
                    if (nick) {
                        const columnMap = {
                            'wallets': 'playerName',
                            'debtors': 'name',
                            'overdue': 'debtorName',
                            'critical_overdue': 'debtorName',
                            'pending_payments': 'title',
                            'paid_markers': 'debtorName'
                        };
                        const column = columnMap[table] || 'name';
                        
                        if (table === 'pending_payments') {
                            rows = db.prepare(`SELECT * FROM ${table} WHERE ${column} LIKE ? LIMIT 20`).all(`%${nick}%`);
                        } else {
                            rows = db.prepare(`SELECT * FROM ${table} WHERE ${column} = ? LIMIT 20`).all(nick);
                        }
                    } else {
                        rows = db.prepare(`SELECT * FROM ${table} LIMIT 20`).all();
                    }
                    
                    if (rows.length === 0) {
                        return i.reply({ 
                            content: nick ? `❌ В таблице **${table}** ничего не найдено для **${nick}**.` : `❌ В таблице **${table}** нет записей.`,
                            flags: [MessageFlags.Ephemeral] 
                        });
                    }
                    
                    let text = `📊 **Таблица: ${table}**\n`;
                    text += `📌 Найдено: ${rows.length} записей${nick ? ` для **${nick}**` : ''}\n\n`;
                    
                    const headers = Object.keys(rows[0]);
                    text += `📋 ${headers.join(' | ')}\n`;
                    text += `${'─'.repeat(Math.min(60, text.length))}\n`;
                    
                    for (const row of rows.slice(0, 10)) {
                        const values = headers.map(h => {
                            let val = row[h];
                            if (val === null || val === undefined) return 'NULL';
                            if (typeof val === 'number') return val.toLocaleString();
                            if (typeof val === 'string' && val.length > 30) return val.substring(0, 27) + '...';
                            if (h === 'updatedAt' || h === 'createdAt' || h === 'deadline' || h === 'closedAt') {
                                if (typeof val === 'number' && val > 1000000000000) {
                                    return new Date(val).toLocaleString('ru-RU');
                                }
                            }
                            return String(val);
                        });
                        text += `${values.join(' | ')}\n`;
                    }
                    
                    if (rows.length > 10) {
                        text += `\n... и ещё ${rows.length - 10} записей`;
                    }
                    
                    if (text.length > 1900) {
                        text = text.substring(0, 1900) + '\n... (обрезано)';
                    }
                    
                    logAction('ADMIN', i.user, `/бд ${table}${nick ? ' ник:' + nick : ''} | ${rows.length} записей`);
                    return i.reply({ content: text, flags: [MessageFlags.Ephemeral] });
                }
            }
            return;
        }

        // ===== КНОПКИ =====
        if (i.isButton()) {
            logButton(i);

            // ===== НОВАЯ КНОПКА С АВТО-ОПЛАТОЙ ИЗ КОШЕЛЬКА =====
            if (i.customId.startsWith('pay_')) {
                await i.deferReply({ flags: [MessageFlags.Ephemeral] });
                
                const payment = db.prepare('SELECT * FROM pending_payments WHERE paymentMsgId = ? AND paid = 0').get(i.customId);
                
                if (!payment) {
                    return i.editReply({ content: '❌ Платёж не найден или уже оплачен.' });
                }
                
                const participantName = payment.title.split(' - ')[1] || 'Неизвестный участник';
                const amount = payment.totalAmount;

                // [!] ПОЛУЧАЕМ УПОМИНАНИЕ ДЛЯ ПОИСКА В ЭМБЕДЕ
                const memberInfo = getMembersInfo([participantName]);
                const mention = memberInfo.mentions.length > 0 ? memberInfo.mentions[0] : null;
                const searchPatterns = [participantName];
                if (mention) searchPatterns.push(mention);

                // [!] ПРОВЕРЯЕМ КОШЕЛЁК
                const wallet = db.prepare('SELECT balance FROM wallets WHERE playerName = ?').get(participantName);
                let walletAmount = wallet ? wallet.balance : 0;
                let remainingAmount = amount;
                let paidFromWallet = 0;
                let needManualPayment = false;
                
                if (walletAmount > 0) {
                    if (walletAmount >= amount) {
                        paidFromWallet = amount;
                        remainingAmount = 0;
                        db.prepare('UPDATE wallets SET balance = balance - ?, updatedAt = ? WHERE playerName = ?')
                            .run(amount, Date.now(), participantName);
                        logAction('WALLET_AUTO_PAY', i.user, `${participantName} | ${amount.toLocaleString()}$ (полностью из кошелька)`);
                    } else {
                        paidFromWallet = walletAmount;
                        remainingAmount = amount - walletAmount;
                        needManualPayment = true;
                        db.prepare('UPDATE wallets SET balance = 0, updatedAt = ? WHERE playerName = ?')
                            .run(Date.now(), participantName);
                        logAction('WALLET_AUTO_PAY', i.user, `${participantName} | ${paidFromWallet.toLocaleString()}$ из кошелька, осталось ${remainingAmount.toLocaleString()}$`);
                    }
                } else {
                    needManualPayment = true;
                }

                // [!] Если не хватает — запрашиваем скриншот
                if (needManualPayment && remainingAmount > 0) {
                    const messages = await i.channel.messages.fetch({ limit: 20 });
                    const userMessage = messages.find(m => m.author.id === i.user.id && m.attachments.size > 0);
                    if (!userMessage) {
                        return i.editReply({
                            content: `❌ На кошельке **${participantName}** недостаточно средств!\n` +
                                    `💰 В кошельке: ${walletAmount.toLocaleString()} $\n` +
                                    `💳 Нужно оплатить: ${amount.toLocaleString()} $\n` +
                                    `📌 Остаток к оплате: ${remainingAmount.toLocaleString()} $\n\n` +
                                    `Прикрепите скриншот оплаты на ${remainingAmount.toLocaleString()} $ и нажмите кнопку снова.`
                        });
                    }
                }

                // Отключаем кнопку
                const rows = i.message.components;
                let updated = false;
                for (const row of rows) {
                    for (const comp of row.components) {
                        if (comp.customId === i.customId) {
                            if (comp.disabled) {
                                return i.editReply({ content: '⚠️ Эта кнопка уже была нажата.' });
                            }
                            const disabledButton = ButtonBuilder.from(comp).setDisabled(true);
                            const index = row.components.indexOf(comp);
                            row.components[index] = disabledButton;
                            updated = true;
                            break;
                        }
                    }
                    if (updated) break;
                }
                
                if (!updated) {
                    return i.editReply({ content: '❌ Не удалось найти кнопку.' });
                }

                // [!] СРАЗУ ЗАЧЁРКИВАЕМ В ЭМБЕДЕ (до подтверждения!)
                try {
                    const embed = i.message.embeds[0];
                    if (embed) {
                        const desc = embed.description || '';
                        const lines = desc.split('\n');
                        let newLines = [];
                        let inDebtSection = false;
                        for (const line of lines) {
                            if (line.includes('**Долги участников:**') || line.includes('Долги участников:')) {
                                inDebtSection = true;
                                newLines.push(line);
                                continue;
                            }
                            if (inDebtSection) {
                                const matches = searchPatterns.some(pattern => line.includes(pattern));
                                if (matches) {
                                    const cleanLine = line.replace(/^[•-\s]+/, '').trim();
                                    newLines.push(`   • ~~${cleanLine}~~ ⏳ (ожидает подтверждения)`);
                                } else {
                                    newLines.push(line);
                                }
                            } else {
                                newLines.push(line);
                            }
                        }
                        const newDesc = newLines.join('\n');
                        const newEmbed = EmbedBuilder.from(embed).setDescription(newDesc);
                        await i.message.edit({ embeds: [newEmbed], components: rows });
                    } else {
                        await i.message.edit({ components: rows });
                    }
                } catch (err) {
                    console.warn('Не удалось обновить эмбед при нажатии:', err);
                    await i.message.edit({ components: rows });
                }

                // [!] Полностью из кошелька — сразу подтверждаем
                if (!needManualPayment) {
                    const newWallet = db.prepare('SELECT balance FROM wallets WHERE playerName = ?').get(participantName);
                    const newBalance = newWallet ? newWallet.balance : 0;
                    
                    deductDebt(participantName, amount);
                    db.prepare('UPDATE treasury SET balance = balance + ? WHERE id = 1').run(amount);
                    db.prepare('DELETE FROM pending_payments WHERE paymentMsgId = ?').run(i.customId);
                    
                    db.prepare(`INSERT INTO paid_markers (debtorName, contractTitle, amount, markedBy, createdAt) VALUES (?, ?, ?, ?, ?)`)
                        .run(participantName, payment.title.split(' - ')[0] || 'Неизвестный контракт', amount, i.user.id, Date.now());
                    
                    try {
                        const embed = i.message.embeds[0];
                        if (embed) {
                            const desc = embed.description || '';
                            const lines = desc.split('\n');
                            let newLines = [];
                            let inDebtSection = false;
                            let found = false;
                            for (const line of lines) {
                                if (line.includes('**Долги участников:**') || line.includes('Долги участников:')) {
                                    inDebtSection = true;
                                    newLines.push(line);
                                    continue;
                                }
                                if (inDebtSection) {
                                    const matches = searchPatterns.some(pattern => line.includes(pattern));
                                    if (matches && line.includes('⏳ (ожидает подтверждения)')) {
                                        const cleanLine = line.replace(/^[•-\s]+/, '').trim();
                                        const amountMatch = cleanLine.match(/\*\*([\d, ]+)\s*\$?/);
                                        const amountStr = amountMatch ? amountMatch[1] : amount.toLocaleString();
                                        newLines.push(`   • ~~${cleanLine}~~ ✅`);
                                        found = true;
                                    } else {
                                        newLines.push(line);
                                    }
                                } else {
                                    newLines.push(line);
                                }
                            }
                            if (!found) {
                                for (const line of lines) {
                                    if (inDebtSection) {
                                        const matches = searchPatterns.some(pattern => line.includes(pattern));
                                        if (matches) {
                                            const cleanLine = line.replace(/^[•-\s]+/, '').trim();
                                            newLines.push(`   • ~~${cleanLine}~~ ✅`);
                                            break;
                                        }
                                    }
                                }
                            }
                            const newDesc = newLines.join('\n');
                            const newEmbed = EmbedBuilder.from(embed).setDescription(newDesc);
                            await i.message.edit({ embeds: [newEmbed], components: rows });
                        }
                    } catch (err) {
                        console.warn('Не удалось обновить эмбед:', err);
                    }
                    
                    logAction('WALLET_PAY_CONFIRM', i.user, `${participantName} | ${amount.toLocaleString()}$ (авто из кошелька)`);
                    return i.followUp({
                        content: `✅ Оплата **${participantName}** автоматически списана с кошелька!\n` +
                                `💰 Сумма: ${amount.toLocaleString()} $\n` +
                                `📌 Остаток на кошельке: ${newBalance.toLocaleString()} $`,
                        flags: [MessageFlags.Ephemeral] 
                    });
                }

                // [!] Частичная оплата или полностью наличными
                let messageContent = `⏳ **Ожидание подтверждения оплаты**\n`;
                messageContent += `👤 Участник: **${participantName}**\n`;
                messageContent += `💰 Сумма: **${amount.toLocaleString()} $**\n`;
                if (paidFromWallet > 0) {
                    messageContent += `💳 Оплачено с кошелька: **${paidFromWallet.toLocaleString()} $**\n`;
                    messageContent += `📌 Остаток к оплате: **${remainingAmount.toLocaleString()} $**\n`;
                }
                messageContent += `🔄 Оплата от <@${i.user.id}>\n\n`;
                messageContent += `Проверяющий, проверьте скриншот и ответьте на это сообщение командой \`!подтвердить\``;

                const pendingMsg = await i.channel.send({ content: messageContent });

                global.pendingMessages.set(pendingMsg.id, pendingMsg.id);
                global.pendingPayments.set(pendingMsg.id, {
                    participantName: participantName,
                    amount: remainingAmount,
                    buttonMessageId: i.message.id,
                    buttonCustomId: i.customId,
                    paidFromWallet: paidFromWallet,
                    totalAmount: amount,
                    contractTitle: payment.title.split(' - ')[0] || 'Неизвестный контракт'
                });
                logAction('PAY_BUTTON', i.user, `${participantName} | ${amount.toLocaleString()}$ (${paidFromWallet > 0 ? paidFromWallet.toLocaleString() + '$ из кошелька' : 'наличными'})`);
                return i.followUp({
                    content: `✅ Кнопка для **${participantName}** нажата.\n` +
                            (paidFromWallet > 0 ? `💳 С кошелька списано: ${paidFromWallet.toLocaleString()} $\n` : '') +
                            `📌 Ожидайте подтверждения проверяющего.`,
                    flags: [MessageFlags.Ephemeral] 
                });
            }

            if (i.customId === 'start') {
                logAction('MODAL_OPEN', i.user, 'Создание контракта');
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
                if (i.user.id !== creatorId && !isAdmin) {
                    logAction('WARN', i.user, `Попытка закрыть чужой контракт ${msgId}`);
                    return i.reply({ content: '❌ Только создатель или админ.', flags: [MessageFlags.Ephemeral] });
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

                await i.message.edit({
                    content: '✅ Статус: **УСПЕХ ✅**',
                    components: [],
                    embeds: [EmbedBuilder.from(oldEmbed).setColor(0x00FF00)]
                }).catch(() => {});

                const payChannel = await client.channels.fetch(CONFIG.PAY);
                if (!payChannel) return i.reply({ content: '❌ Канал оплаты не найден.', flags: [MessageFlags.Ephemeral] });

                const paymentData = [];
                for (const participant of participants) {
                    const name = participant.name;
                    const billValue = parseInt(participant.value.replace(/\D/g, '')) || 0;
                    const toPay = Math.round(billValue * 1000 * multiplier);
                    if (toPay <= 0) continue;
                    
                    paymentData.push({ name, amount: toPay });
                    db.prepare('INSERT OR REPLACE INTO debtors (name, amount) VALUES (?, IFNULL((SELECT amount FROM debtors WHERE name = ?), 0) + ?)')
                        .run(name, name, toPay);
                }

                if (paymentData.length === 0) return i.reply({ content: '❌ Нет участников для оплаты.', flags: [MessageFlags.Ephemeral] });

                let description = `**Исполнители:** ${executorMentions}\n\n`;
                description += `Каждый участник должен оплатить свою долю в течение 72 часов.\n`;
                description += `Проверяющий: после оплаты участника нажмите кнопку и ответьте \`!подтвердить\`\n\n`;
                description += `**Долги участников:**\n`;
                
                const buttons = [];
                for (const p of paymentData) {
                    const memberInfo = getMembersInfo([p.name]);
                    const memberMention = memberInfo.mentions.length > 0 ? memberInfo.mentions[0] : p.name;
                    description += `• ${memberMention}: **${p.amount.toLocaleString()} $**\n`;
                    
                    const uniqueId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
                    const customId = `pay_${uniqueId}`;
                    buttons.push(
                        new ButtonBuilder()
                            .setCustomId(customId)
                            .setLabel(`Оплатить ${p.name}`)
                            .setStyle(ButtonStyle.Success)
                    );
                }

                const payEmbed = new EmbedBuilder()
                    .setTitle(oldEmbed.title)
                    .setColor(0x00FF00)
                    .setDescription(description);

                const rows = [];
                for (let i = 0; i < buttons.length; i += 5) {
                    rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
                }

                const payMsg = await payChannel.send({
                    content: CONFIG.ALLOWED_ROLES.map(r => `<@&${r}>`).join(' ') + ` | ${executorMentions}`,
                    embeds: [payEmbed],
                    components: rows
                });

                for (let i = 0; i < paymentData.length; i++) {
                    const p = paymentData[i];
                    const customId = buttons[i].data.custom_id;
                    db.prepare(`INSERT INTO pending_payments (contractMsgId, paymentMsgId, creatorId, title, totalAmount, createdAt, deadline) VALUES (?, ?, ?, ?, ?, ?, ?)`)
                        .run(
                            msgId, 
                            customId,
                            creatorId, 
                            `${oldEmbed.title} - ${p.name}`, 
                            p.amount, 
                            Date.now(), 
                            Date.now() + 72 * 60 * 60 * 1000
                        );
                }

                logAction('CONTRACT_CLOSE_BUTTON', i.user, `${oldEmbed.title} | ${paymentData.length} участников`);
                return i.reply({ content: `✅ Контракт закрыт, созданы кнопки для ${paymentData.length} участников.`, flags: [MessageFlags.Ephemeral] });
            }

            if (i.customId === 'pay_confirm') {
                const messages = await i.channel.messages.fetch({ limit: 10 });
                if (!messages.some(m => m.attachments.size > 0)) {
                    return i.reply({ content: '❌ Прикрепите скриншот!', flags: [MessageFlags.Ephemeral] });
                }
                const pendingMsg = await i.channel.send({ 
                    content: `⏳ Ожидание подтверждения...\nОплата от <@${i.user.id}>. Ответьте \`!подтвердить\`` 
                });
                global.pendingMessages.set(i.message.id, pendingMsg.id);
                logAction('PAY_CONFIRM', i.user, `Ожидание подтверждения ${i.message.id}`);
                return i.update({ 
                    content: `⏳ Ожидание подтверждения...\nОплата от <@${i.user.id}>. Ответьте \`!подтвердить\``, 
                    components: [] 
                });
            }

            if (i.customId === 'start_admin') {
                const hasRole = i.member.roles.cache.some(role => CONFIG.ALLOWED_ROLES.includes(role.id));
                if (!hasRole) return i.reply({ content: '❌ Нет прав.', flags: [MessageFlags.Ephemeral] });
                if (i.channelId !== process.env.ADMIN_PICK) return i.reply({ content: '❌ Только в админ-канале.', flags: [MessageFlags.Ephemeral] });
                logAction('ADMIN_MODAL', i.user, 'Открыта админ-модалка');
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

            logModal(i, `name:${name} nicknames:${nicknamesRaw} bills:${billsRaw} time:${timeRaw}`);

            if (!/^[а-яА-ЯёЁ\s]+$/.test(name)) return i.editReply('❌ Название на кириллице.');
            if (!/^[a-zA-Z_\s;]+$/.test(nicknamesRaw)) return i.editReply('❌ Ники: латиница, _, ;');
            if (!/^[0-9;]+$/.test(billsRaw)) return i.editReply('❌ Векселя: цифры и ;');
            if (!/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(timeRaw)) return i.editReply('❌ Время: ЧЧ:ММ');

            const nicknames = nicknamesRaw.split(';');
            const bills = billsRaw.split(';');
            if (nicknames.length !== bills.length) return i.editReply('❌ Количество ников не соответствует векселям.');

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
            
            logAction('CONTRACT_CREATE', i.user, `${name} | ${nicknames.length} участников | до ${new Date(endTime).toLocaleString()}`);
            console.log(`[LOG] Участники:`);
            nicknames.forEach((nick, idx) => console.log(`   -> ${nick.trim()}: ${bills[idx] || 0} векселей`));

            return i.editReply('✅ Контракт создан!');
        }

        if (i.isModalSubmit() && i.customId === 'admin_m') {
            await i.deferReply({ flags: [MessageFlags.Ephemeral] });
            const userId = i.fields.getTextInputValue('userId').trim();
            const name = i.fields.getTextInputValue('n').trim();
            const nicknamesRaw = i.fields.getTextInputValue('nicknames').trim();
            const billsRaw = i.fields.getTextInputValue('bills').trim();
            const timeRaw = i.fields.getTextInputValue('time').trim();

            logModal(i, `userId:${userId} name:${name} nicknames:${nicknamesRaw} bills:${billsRaw} time:${timeRaw}`);

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
            
            logAction('ADMIN_CONTRACT_CREATE', i.user, `${name} | от <@${userId}> | ${nicknames.length} участников`);
            return i.editReply(`✅ Контракт создан от <@${userId}>!`);
        }

    } catch (err) {
        console.error('Ошибка взаимодействия:', err);
        logAction('ERROR', { tag: 'SYSTEM' }, err.message);
    }
});

// ========== ЗАВЕРШЕНИЕ ==========
const shutdown = () => {
    logAction('SYSTEM', client.user, 'Бот выключается');
    try { db.close(); } catch (err) { console.error(err); }
    client.destroy();
    process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

client.login(process.env.TOKEN);