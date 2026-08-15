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
    getMembersInfo, createContract, closeContract, getPlayerStats, getGeneralStats,
    getPlayerContracts, analyzeProfitability,
    addToTreasury, subtractFromTreasury, getTreasury, getTreasuryLogs,
    logAction, logCommand, logButton, logModal, logMessage,
    saveStatsMessage, getStatsMessage, savePlayerStatsMessage, getPlayerStatsMessage,
    deletePlayerStatsMessage, saveStatsLastRequest, getStatsLastRequest
} = require('./functions.js');

const rolesModule = require('./modules/roles.js');
const autoRoleModule = require('./modules/autoRole.js');
const ticketsModule = require('./modules/tickets.js');

const CONFIG = {
    PICK: process.env.PICK,
    PROCESS: process.env.PROCESS,
    ADMIN_PICK: process.env.ADMIN_PICK,
    STATS_CHANNEL: process.env.STATS_CHANNEL,
    RECRUITER_ROLE: process.env.RECRUITER_ROLE,
    DEP_LEAD_ROLE: process.env.DEP_LEAD_ROLE,
    LEAD_ROLE: process.env.LEAD_ROLE,
    ALLOWED_ROLES: process.env.ALLOWED_ROLES ? process.env.ALLOWED_ROLES.split(',') : []
};

const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessageReactions
    ] 
});

process.on('unhandledRejection', error => console.error('Unhandled rejection:', error));
process.on('uncaughtException', err => console.error('Uncaught exception:', err));

client.once('clientReady', async () => {
    logAction('SYSTEM', client.user, 'Бот запускается');
    
    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    logAction('SYSTEM', client.user, 'Команды зарегистрированы');

    const treasury = getTreasury();
    console.log(`\n🚀 Бот ${client.user.tag} запущен!`);
    console.log(`💰 Казна: ${(treasury?.balance || 0).toLocaleString()} $\n`);

    if (process.env.ADMIN_PICK) {
        try {
            const adminChannel = await client.channels.fetch(process.env.ADMIN_PICK);
            if (!adminChannel) return;
            const messages = await adminChannel.messages.fetch({ limit: 10 });
            const existingMsg = messages.find(m => m.author.id === client.user.id && m.embeds.length > 0 && m.embeds[0].title === 'Админ-панель');
            if (!existingMsg) {
                await adminChannel.send({
                    embeds: [new EmbedBuilder().setTitle('Админ-панель').setDescription('Создать контракт от имени другого игрока.').setColor(0xFFA500)],
                    components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('start_admin').setLabel('Создать контракт для игрока').setStyle(ButtonStyle.Success))]
                });
            }
        } catch (err) { console.error('[ERROR] Админ-панель:', err); }
    }
});

client.on('guildMemberAdd', async (member) => {
    try {
        const roleId = autoRoleModule.getAutoRole(member.guild.id);
        if (!roleId) return;
        const role = member.guild.roles.cache.get(roleId);
        if (!role) return;
        await member.roles.add(role);
        logAction('AUTO_ROLE', member.user, `Выдана роль ${role.name}`);
    } catch (err) {
        console.error('Ошибка автороли:', err);
    }
});

client.on('messageReactionAdd', async (reaction, user) => {
    if (user.bot) return;
    try {
        const roleData = rolesModule.getRoleByReaction(reaction.message.id, reaction.emoji.name || reaction.emoji.id);
        if (!roleData) return;
        const member = await reaction.message.guild.members.fetch(user.id);
        if (!member) return;
        const role = reaction.message.guild.roles.cache.get(roleData.roleId);
        if (!role) return;
        await member.roles.add(role);
        logAction('ROLE_ADD', user, `Выдана роль ${role.name}`);
    } catch (err) {
        console.error('Ошибка выдачи роли:', err);
    }
});

client.on('messageReactionRemove', async (reaction, user) => {
    if (user.bot) return;
    try {
        const roleData = rolesModule.getRoleByReaction(reaction.message.id, reaction.emoji.name || reaction.emoji.id);
        if (!roleData) return;
        const member = await reaction.message.guild.members.fetch(user.id);
        if (!member) return;
        const role = reaction.message.guild.roles.cache.get(roleData.roleId);
        if (!role) return;
        await member.roles.remove(role);
        logAction('ROLE_REMOVE', user, `Снята роль ${role.name}`);
    } catch (err) {
        console.error('Ошибка снятия роли:', err);
    }
});

client.on('interactionCreate', async i => {
    try {
        if (i.isAutocomplete()) {
            const focusedOption = i.options.getFocused(true);
            const members = require('./members.js');
            
            if (focusedOption.name === 'ник') {
                const allNames = members.map(m => m.gameName).filter(name => name && name.trim());
                const filtered = allNames
                    .filter(name => name.toLowerCase().includes(focusedOption.value.toLowerCase()))
                    .slice(0, 25)
                    .map(name => ({ name: name, value: name }));
                await i.respond(filtered);
                return;
            }
            await i.respond([]);
            return;
        }

        if (i.isMessageContextMenuCommand()) {
            logAction('CONTEXT', i.user, `${i.commandName}`);
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
                return i.editReply('✅ Контракт закрыт.');
            }
            return;
        }

        if (i.isChatInputCommand()) {
            logCommand(i);

            if (i.commandName !== 'ожидают') {
                const hasRole = i.member.roles.cache.some(role => CONFIG.ALLOWED_ROLES.includes(role.id));
                if (!hasRole) {
                    logAction('WARN', i.user, `Нет прав на /${i.commandName}`);
                    return i.reply({ content: '❌ Нет прав.', flags: [MessageFlags.Ephemeral] });
                }
            }

            switch (i.commandName) {
                case 'вызвать': {
                    if (i.channelId !== CONFIG.PICK) return i.reply({ content: '❌ Только в канале пика!', flags: [MessageFlags.Ephemeral] });
                    
                    const embed = new EmbedBuilder()
                        .setTitle('📋 ПРАВИЛА РАБОТЫ С КОНТРАКТАМИ NUERRA')
                        .setColor(0x0099FF)
                        .setDescription(
                            'Уважаемые <@&1534213329294327926><@&1534213329294327925><@&1534213329294327924>, ознакомьтесь с правилами работы.\n\n' +
                            '**1. 📝 Создание контракта**\n' +
                            'После того как вы взяли контракт в игре, нажмите кнопку **[Создать контракт]** под этим сообщением.\n' +
                            'В открывшейся панели заполните все необходимые данные:\n' +
                            '• **Название** — что за контракт\n' +
                            '• **Ники** — кто участвует (через `;`)\n' +
                            '• **Векселя** — сколько у кого (через `;`)\n' +
                            '• **Время** — сколько длится (ЧЧ:ММ)\n' +
                            '• **Процент пика** — шанс на успех (1-100%)\n\n' +
                            '**2. 📊 Аналитика контрактов**\n' +
                            'Бот автоматически считает:\n' +
                            '• **Успешные / провальные** контракты\n' +
                            '• **% успеха** каждого игрока\n' +
                            '• **Прибыль** за каждый контракт (векселя × 1000 × % пика)\n' +
                            '• **Общую статистику** по всем игрокам\n' +
                            '• **Топ-5** по прибыли и пополнениям казны\n\n' +
                            '**3. 🎯 Закрытие контракта**\n' +
                            'После выполнения контракта нажмите одну из кнопок:\n' +
                            '• **[✅ УСПЕХ]** — контракт выполнен, участники получают деньги\n' +
                            '• **[❌ ПРОВАЛ]** — контракт провален, участники получают 0\n\n' +
                            '**4. 💰 Казна**\n' +
                            'Пополняйте казну организации через команду `/пополнить_казну`.\n' +
                            'Все пополнения записываются в статистику игроков.\n\n' +
                            '**5. 📊 Статистика**\n' +
                            '• `/статистика` — общая статистика бота\n' +
                            '• `/игрок ник: Artem` — статистика конкретного игрока\n' +
                            '• `/контракты_игрока ник: Artem` — активные контракты игрока\n' +
                            '• `/выгодность процент: 10 векселя: 350` — анализ выгодности пика\n\n' +
                            'По всем вопросам обращаться к: <@702529657718833162>'
                        )
                        .setTimestamp()
                        .setFooter({ text: `Вызвал: ${i.user.tag}`, iconURL: i.user.displayAvatarURL() });
                    
                    const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId('start').setLabel('📝 Создать контракт').setStyle(ButtonStyle.Primary)
                    );
                    
                    const pingContent = `<@&1534213329294327926> <@&1534213329294327925> <@&1534213329294327924>`;

                    const saved = db.prepare('SELECT messageId FROM pick_message WHERE id = 1').get();
                    let msg = null;
                    if (saved && saved.messageId) {
                        try {
                            const channel = await client.channels.fetch(CONFIG.PICK);
                            msg = await channel.messages.fetch(saved.messageId);
                        } catch (err) { msg = null; }
                    }
                    
                    if (msg) {
                        await msg.edit({ content: pingContent, embeds: [embed], components: [row] });
                        await i.reply({ content: '✅ Правила обновлены!', flags: [MessageFlags.Ephemeral] });
                    } else {
                        const channel = await client.channels.fetch(CONFIG.PICK);
                        const newMsg = await channel.send({ content: pingContent, embeds: [embed], components: [row] });
                        db.prepare('UPDATE pick_message SET messageId = ?, channelId = ?, updatedAt = ? WHERE id = 1')
                            .run(newMsg.id, CONFIG.PICK, Date.now());
                        await i.reply({ content: '✅ Правила созданы!', flags: [MessageFlags.Ephemeral] });
                    }
                    break;
                }

                case 'статистика': {
                    await i.reply({ content: '✅ Статистика обновляется...', flags: [MessageFlags.Ephemeral] });
                    await updateStatsMessage(client, CONFIG.STATS_CHANNEL, i.user);
                    break;
                }

                case 'игрок': {
                    const nick = i.options.getString('ник');
                    const stats = getPlayerStats(nick);
                    if (!stats) return i.reply({ content: `❌ Игрок **${nick}** не найден.`, flags: [MessageFlags.Ephemeral] });
                    
                    const embed = new EmbedBuilder()
                        .setTitle(`📊 СТАТИСТИКА ИГРОКА: ${nick}`)
                        .setColor(0x0099FF)
                        .addFields(
                            { name: '📋 Контракты', value: `${stats.totalContracts || 0}`, inline: true },
                            { name: '✅ Успешных', value: `${stats.successContracts || 0} (${stats.successRate || 0}%)`, inline: true },
                            { name: '❌ Провальных', value: `${stats.failContracts || 0}`, inline: true },
                            { name: '🎯 Средний % пика', value: `${stats.avgPercent || 0}%`, inline: true },
                            { name: '💰 Общая прибыль', value: `${(stats.totalPayout || 0).toLocaleString()} $`, inline: true },
                            { name: '💵 Средняя за контракт', value: `${(stats.avgPayout || 0).toLocaleString()} $`, inline: true },
                            { name: '🏆 Лучший результат', value: `${(stats.bestPayout || 0).toLocaleString()} $`, inline: true },
                            { name: '💰 Пополнений в казну', value: `${stats.treasuryDeposits || 0} раз`, inline: true },
                            { name: '💰 Всего внёс в казну', value: `${(stats.treasuryTotal || 0).toLocaleString()} $`, inline: true }
                        )
                        .setTimestamp()
                        .setFooter({ text: `Запросил: ${i.user.tag}` });
                    
                    await i.reply({ content: '✅ Статистика отправлена в канал!', flags: [MessageFlags.Ephemeral] });
                    
                    if (CONFIG.STATS_CHANNEL) {
                        const statsChannel = await client.channels.fetch(CONFIG.STATS_CHANNEL);
                        if (statsChannel) {
                            const saved = getPlayerStatsMessage(nick);
                            if (saved && saved.messageId) {
                                try {
                                    const oldMsg = await statsChannel.messages.fetch(saved.messageId);
                                    if (oldMsg) await oldMsg.delete();
                                } catch (err) {}
                            }
                            const newMsg = await statsChannel.send({ content: `📊 Статистика игрока **${nick}**:`, embeds: [embed] });
                            savePlayerStatsMessage(nick, CONFIG.STATS_CHANNEL, newMsg.id);
                            
                            setTimeout(async () => {
                                try {
                                    const allMessages = await statsChannel.messages.fetch({ limit: 10 });
                                    const msgIds = allMessages.map(m => m.id);
                                    const currentIndex = msgIds.indexOf(newMsg.id);
                                    if (currentIndex !== -1 && currentIndex !== 0) {
                                        await newMsg.delete();
                                        deletePlayerStatsMessage(nick);
                                    }
                                } catch (err) {}
                            }, 5 * 60 * 1000);
                        }
                    }
                    break;
                }

                case 'контракты_игрока': {
                    const nick = i.options.getString('ник');
                    const contracts = getPlayerContracts(nick);
                    if (contracts.length === 0) return i.reply({ content: `📭 У **${nick}** нет активных контрактов.`, flags: [MessageFlags.Ephemeral] });
                    
                    let text = `📋 **АКТИВНЫЕ КОНТРАКТЫ ${nick}** (${contracts.length}):\n\n`;
                    for (const c of contracts) {
                        text += `• **${c.title}** — ${c.percent}% (${c.payout.toLocaleString()} $)\n`;
                    }
                    await i.reply({ content: text, flags: [MessageFlags.Ephemeral] });
                    break;
                }

                case 'выгодность': {
                    const percent = i.options.getInteger('процент');
                    const bills = i.options.getInteger('векселя');
                    const count = i.options.getInteger('количество') || 10;
                    
                    const result = analyzeProfitability(percent, bills, count);
                    const embed = new EmbedBuilder()
                        .setTitle('📊 АНАЛИЗ ВЫГОДНОСТИ ПИКА')
                        .setColor(result.isProfitable ? 0x00FF00 : 0xFF0000)
                        .addFields(
                            { name: `🎯 ${percent}% с ${bills} векселей`, value: 
                                `• За 1 контракт: ${result.oneContract.toLocaleString()} $\n` +
                                `• За ${count} контрактов: ${result.multiContracts.toLocaleString()} $`, 
                                inline: false 
                            },
                            { name: `🎯 100% с 50 векселей (${count} раз)`, value: 
                                `${result.basePayout.toLocaleString()} $`, 
                                inline: false 
                            },
                            { name: '📌 Итог', value: result.isProfitable 
                                ? `✅ ВЫГОДНЕЕ пикать в ${percent}% с ${bills} векселей\nРазница: +${result.difference.toLocaleString()} $`
                                : `❌ НЕ ВЫГОДНЕЕ пикать в ${percent}% с ${bills} векселей\nРазница: -${Math.abs(result.difference).toLocaleString()} $`,
                                inline: false 
                            }
                        )
                        .setTimestamp();
                    await i.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
                    break;
                }

                case 'казна': {
                    const treasury = getTreasury();
                    await i.reply({ content: `💰 Баланс казны: **${(treasury?.balance || 0).toLocaleString()} $**`, flags: [MessageFlags.Ephemeral] });
                    break;
                }

                case 'пополнить_казну': {
                    const amount = i.options.getInteger('сумма');
                    const note = i.options.getString('примечание') || 'Пополнение';
                    const newBalance = addToTreasury(amount, i.user.id, note);
                    if (newBalance === null) return i.reply({ content: '❌ Сумма должна быть > 0.', flags: [MessageFlags.Ephemeral] });
                    
                    const embed = new EmbedBuilder()
                        .setTitle('💰 ПОПОЛНЕНИЕ КАЗНЫ')
                        .setDescription(`✅ Пополнено на **${amount.toLocaleString()} $**`)
                        .addFields(
                            { name: '📌 Примечание', value: note, inline: false },
                            { name: '💰 Новый баланс', value: `${newBalance.toLocaleString()} $`, inline: false }
                        )
                        .setColor(0x00FF00)
                        .setTimestamp()
                        .setFooter({ text: `Пополнил: ${i.user.tag}` });
                    
                    await i.reply({ embeds: [embed] });
                    await updateStatsMessage(client, CONFIG.STATS_CHANNEL);
                    break;
                }

                case 'снять_из_казны': {
                    const hasRole = i.member.roles.cache.some(role => CONFIG.ALLOWED_ROLES.includes(role.id));
                    if (!hasRole) return i.reply({ content: '❌ Только для админов.', flags: [MessageFlags.Ephemeral] });
                    
                    const amount = i.options.getInteger('сумма');
                    const note = i.options.getString('примечание') || 'Списание';
                    const newBalance = subtractFromTreasury(amount, i.user.id, note);
                    if (newBalance === null) return i.reply({ content: '❌ Недостаточно средств в казне.', flags: [MessageFlags.Ephemeral] });
                    
                    const embed = new EmbedBuilder()
                        .setTitle('💰 СПИСАНИЕ ИЗ КАЗНЫ')
                        .setDescription(`✅ Списано **${amount.toLocaleString()} $**`)
                        .addFields(
                            { name: '📌 Примечание', value: note, inline: false },
                            { name: '💰 Новый баланс', value: `${newBalance.toLocaleString()} $`, inline: false }
                        )
                        .setColor(0xFF0000)
                        .setTimestamp()
                        .setFooter({ text: `Списал: ${i.user.tag}` });
                    
                    await i.reply({ embeds: [embed] });
                    await updateStatsMessage(client, CONFIG.STATS_CHANNEL);
                    break;
                }

                case 'история_казны': {
                    const logs = getTreasuryLogs(20);
                    if (logs.length === 0) return i.reply({ content: '📭 История пуста.', flags: [MessageFlags.Ephemeral] });
                    
                    let text = '📋 **ИСТОРИЯ КАЗНЫ (20 последних)**\n\n';
                    for (const log of logs) {
                        const icon = log.type === 'income' ? '➕' : '➖';
                        const sign = log.type === 'income' ? '+' : '-';
                        const date = new Date(log.createdAt).toLocaleString('ru-RU');
                        text += `${icon} ${date} — ${sign}${log.amount.toLocaleString()} $`;
                        if (log.note) text += ` (${log.note})`;
                        text += '\n';
                    }
                    await i.reply({ content: text, flags: [MessageFlags.Ephemeral] });
                    break;
                }

                case 'роли': {
                    const hasRole = i.member.roles.cache.some(role => CONFIG.ALLOWED_ROLES.includes(role.id));
                    if (!hasRole) return i.reply({ content: '❌ Нет прав.', flags: [MessageFlags.Ephemeral] });
                    
                    const title = i.options.getString('название');
                    const description = i.options.getString('описание') || 'Нажмите на реакцию, чтобы получить роль.';
                    
                    const embed = new EmbedBuilder()
                        .setTitle(` ${title}`)
                        .setDescription(description)
                        .setColor(0x0099FF)
                    
                    const msg = await i.channel.send({ embeds: [embed] });
                    await i.reply({ content: '✅ Сообщение создано! Добавьте роли через `/добавить_роль`', flags: [MessageFlags.Ephemeral] });
                    break;
                }

                case 'добавить_роль': {
                    const hasRole = i.member.roles.cache.some(role => CONFIG.ALLOWED_ROLES.includes(role.id));
                    if (!hasRole) return i.reply({ content: '❌ Нет прав.', flags: [MessageFlags.Ephemeral] });
                    
                    const messageId = i.options.getString('id_сообщения');
                    const role = i.options.getRole('роль');
                    const emoji = i.options.getString('эмодзи');
                    const category = i.options.getString('категория');
                    const label = i.options.getString('подпись');
                    
                    try {
                        const msg = await i.channel.messages.fetch(messageId);
                        if (!msg) return i.reply({ content: '❌ Сообщение не найдено.', flags: [MessageFlags.Ephemeral] });
                        
                        await msg.react(emoji);
                        rolesModule.saveRoleMessage(messageId, i.channel.id, role.id, emoji, category, label);
                        await i.reply({ content: `✅ Добавлена роль ${role} (${category}) — ${label}`, flags: [MessageFlags.Ephemeral] });
                    } catch (err) {
                        await i.reply({ content: `❌ Ошибка: ${err.message}`, flags: [MessageFlags.Ephemeral] });
                    }
                    break;
                }

                case 'удалить_роль': {
                    const hasRole = i.member.roles.cache.some(role => CONFIG.ALLOWED_ROLES.includes(role.id));
                    if (!hasRole) return i.reply({ content: '❌ Нет прав.', flags: [MessageFlags.Ephemeral] });
                    
                    const messageId = i.options.getString('id_сообщения');
                    const role = i.options.getRole('роль');
                    
                    try {
                        const msg = await i.channel.messages.fetch(messageId);
                        if (!msg) return i.reply({ content: '❌ Сообщение не найдено.', flags: [MessageFlags.Ephemeral] });
                        
                        rolesModule.deleteRoleMessage(messageId, role.id);
                        const roleData = db.prepare('SELECT emoji FROM role_messages WHERE messageId = ? AND roleId = ?').get(messageId, role.id);
                        if (roleData) {
                            const reactions = msg.reactions.cache.get(roleData.emoji);
                            if (reactions) await reactions.remove();
                        }
                        await i.reply({ content: `✅ Удалена роль ${role}`, flags: [MessageFlags.Ephemeral] });
                    } catch (err) {
                        await i.reply({ content: `❌ Ошибка: ${err.message}`, flags: [MessageFlags.Ephemeral] });
                    }
                    break;
                }

                case 'автороль': {
                    const hasRole = i.member.roles.cache.some(role => CONFIG.ALLOWED_ROLES.includes(role.id));
                    if (!hasRole) return i.reply({ content: '❌ Нет прав.', flags: [MessageFlags.Ephemeral] });
                    
                    const role = i.options.getRole('роль');
                    autoRoleModule.setAutoRole(role.id, i.guild.id);
                    await i.reply({ content: `✅ Автороль установлена: ${role}`, flags: [MessageFlags.Ephemeral] });
                    break;
                }

                case 'убрать_автороль': {
                    const hasRole = i.member.roles.cache.some(role => CONFIG.ALLOWED_ROLES.includes(role.id));
                    if (!hasRole) return i.reply({ content: '❌ Нет прав.', flags: [MessageFlags.Ephemeral] });
                    
                    autoRoleModule.removeAutoRole(i.guild.id);
                    await i.reply({ content: '✅ Автороль убрана', flags: [MessageFlags.Ephemeral] });
                    break;
                }

                case 'рекрут': {
                    const hasRole = i.member.roles.cache.some(role => CONFIG.ALLOWED_ROLES.includes(role.id));
                    if (!hasRole) return i.reply({ content: '❌ Нет прав.', flags: [MessageFlags.Ephemeral] });
                    
                    const embed = new EmbedBuilder()
                        .setTitle('📋 ВСТУПЛЕНИЕ В СЕМЬЮ NUERRA')
                        .setDescription(
                            'Нажми на кнопку **"Начать вступление"**, чтобы открыть анкету.\n\n' +
                            '📌 **Что нужно сделать:**\n' +
                            '1. Нажми кнопку\n' +
                            '2. Заполни анкету\n' +
                            '3. Отправь\n\n' +
                            'После проверки ты получишь ответ.'
                        )
                        .setColor(0x0099FF)
                        .setTimestamp()
                        .setFooter({ text: `Рекрутинг Nuerra` });
                    
                    const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId('start_recruit')
                            .setLabel('📝 Начать вступление')
                            .setStyle(ButtonStyle.Success)
                    );
                    
                    await i.channel.send({ embeds: [embed], components: [row] });
                    await i.reply({ content: '✅ Панель рекрутинга создана!', flags: [MessageFlags.Ephemeral] });
                    break;
                }

                default: {
                    await i.reply({ content: '⚠️ Команда в разработке.', flags: [MessageFlags.Ephemeral] });
                }
            }
            return;
        }

        if (i.isButton()) {
            logButton(i);

            if (i.customId === 'start') {
                const modal = new ModalBuilder()
                    .setCustomId('m')
                    .setTitle('Создание контракта')
                    .addComponents(
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('n').setLabel('Название').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('Ограбление')),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('nicknames').setLabel('Ники (через ;)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('Artem;Yuto')),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('bills').setLabel('Векселя (через ;)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('25;20')),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('time').setLabel('Время (ЧЧ:ММ)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('ЧЧ:ММ')),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('percent').setLabel('Процент пика (1-100)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('10'))
                    );
                return i.showModal(modal);
            }

            if (i.customId === 'start_recruit') {
                const existing = ticketsModule.getTicketByUser(i.user.id);
                if (existing) {
                    return i.reply({ content: `❌ У вас уже есть открытый тикет! <#${existing.channelId}>`, flags: [MessageFlags.Ephemeral] });
                }

                const modal = new ModalBuilder()
                    .setCustomId('recruit_form')
                    .setTitle('📋 Вступление в Nuerra')
                    .addComponents(
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('nickname').setLabel('1. Твой никнейм в игре').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('Artem Nuerra')),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('role').setLabel('2. В семью или друг семьи?').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('Семья / Друг семьи')),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('online').setLabel('3. Сколько времени играешь в день?').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('3-4 часа')),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('direction').setLabel('4. Какое направление ближе?').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('Криминал / Государство / Оба')),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('why').setLabel('5. Почему хочешь вступить в Nuerra?').setStyle(TextInputStyle.Paragraph).setRequired(true).setPlaceholder('Напиши причину...'))
                    );
                return i.showModal(modal);
            }

            if (i.customId.startsWith('success_') || i.customId.startsWith('fail_')) {
                const parts = i.customId.split('_');
                const contractId = parseInt(parts[1]);
                const status = parts[0] === 'success' ? 'success' : 'fail';
                
                const contract = db.prepare('SELECT * FROM contracts WHERE id = ?').get(contractId);
                if (!contract) return i.reply({ content: '❌ Контракт не найден.', flags: [MessageFlags.Ephemeral] });
                if (contract.status !== 'active') return i.reply({ content: '❌ Контракт уже закрыт.', flags: [MessageFlags.Ephemeral] });
                
                const isAdmin = i.member.roles.cache.some(role => CONFIG.ALLOWED_ROLES.includes(role.id));
                if (i.user.id !== contract.creatorId && !isAdmin) {
                    return i.reply({ content: '❌ Только создатель или админ.', flags: [MessageFlags.Ephemeral] });
                }
                
                const result = closeContract(contractId, status, i.user.id);
                if (!result) return i.reply({ content: '❌ Ошибка закрытия.', flags: [MessageFlags.Ephemeral] });
                
                // ===== ОБНОВЛЯЕМ СООБЩЕНИЕ =====
                try {
                    const channel = await client.channels.fetch(CONFIG.PROCESS);
                    const msg = await channel.messages.fetch(contract.msgId);
                    if (msg && msg.embeds.length > 0) {
                        // Берём текущий эмбед
                        const oldEmbed = msg.embeds[0];
                        const oldDescription = oldEmbed.description || '';
                        
                        // Создаём новый эмбед
                        const newEmbed = new EmbedBuilder()
                            .setTitle(oldEmbed.title)
                            .setColor(status === 'success' ? 0x00FF00 : 0xFF0000)
                            .setDescription(`${oldDescription}\n\n**Статус:** ${status === 'success' ? '✅ УСПЕХ' : '❌ ПРОВАЛ'}`)
                            .setTimestamp()
                            .setFooter(oldEmbed.footer ? { text: oldEmbed.footer.text } : null);
                        
                        // Убираем кнопки
                        await msg.edit({ 
                            embeds: [newEmbed], 
                            components: [] 
                        });
                    }
                } catch (err) {
                    console.error('Ошибка обновления сообщения:', err);
                }
                
                await updateStatsMessage(client, CONFIG.STATS_CHANNEL);
                await i.reply({ 
                    content: `✅ Контракт закрыт! Статус: ${status === 'success' ? 'УСПЕХ' : 'ПРОВАЛ'}`,
                    flags: [MessageFlags.Ephemeral] 
                });
                return;
            }

            if (i.customId === 'start_admin') {
                const hasRole = i.member.roles.cache.some(role => CONFIG.ALLOWED_ROLES.includes(role.id));
                if (!hasRole) return i.reply({ content: '❌ Нет прав.', flags: [MessageFlags.Ephemeral] });
                if (i.channelId !== process.env.ADMIN_PICK) return i.reply({ content: '❌ Только в админ-канале.', flags: [MessageFlags.Ephemeral] });
                
                const modal = new ModalBuilder()
                    .setCustomId('admin_m')
                    .setTitle('Создание контракта (админ)')
                    .addComponents(
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('userId').setLabel('ID пользователя').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('123456789012345678')),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('n').setLabel('Название').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('Ограбление')),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('nicknames').setLabel('Ники (через ;)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('Artem;Yuto')),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('bills').setLabel('Векселя (через ;)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('25;20')),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('time').setLabel('Время (ЧЧ:ММ)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('ЧЧ:ММ')),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('percent').setLabel('Процент пика (1-100)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('10'))
                    );
                return i.showModal(modal);
            }

            if (i.customId && i.customId.startsWith('close_ticket_')) {
            const ticket = ticketsModule.getTicketByChannel(i.channel.id);
            
            if (!ticket) {
                return i.reply({ content: '❌ Это не канал тикета.', flags: [MessageFlags.Ephemeral] });
            }
            
            const isAdmin = i.member.roles.cache.some(role => CONFIG.ALLOWED_ROLES.includes(role.id));
            if (i.user.id !== ticket.userId && !isAdmin) {
                return i.reply({ content: '❌ Только кандидат или админ могут закрыть тикет.', flags: [MessageFlags.Ephemeral] });
            }
            
            ticketsModule.closeTicket(i.channel.id);
            
            await i.channel.send({
                content: `🔒 Тикет закрыт <@${i.user.id}>`
            });
            
            setTimeout(async () => {
                try { await i.channel.delete(); } catch (err) {}
            }, 5000);
            
            await i.reply({ 
                content: '✅ Тикет закрыт! Канал будет удалён через 5 секунд.',
                flags: [MessageFlags.Ephemeral] 
            });
        }
        }

        if (i.isModalSubmit()) {
            logModal(i);

            if (i.customId === 'm') {
                await i.deferReply({ flags: [MessageFlags.Ephemeral] });
                const name = i.fields.getTextInputValue('n').trim();
                const nicknamesRaw = i.fields.getTextInputValue('nicknames').trim();
                const billsRaw = i.fields.getTextInputValue('bills').trim();
                const timeRaw = i.fields.getTextInputValue('time').trim();
                const percent = parseInt(i.fields.getTextInputValue('percent').trim()) || 10;

                const nicknames = nicknamesRaw.split(';');
                const bills = billsRaw.split(';');
                if (nicknames.length !== bills.length) return i.editReply('❌ Количество ников != векселей.');

                const [h, m] = timeRaw.split(':').map(Number);
                const endTime = Date.now() + (h * 60 + m) * 60 * 1000;

                const participants = [];
                let totalBills = 0;
                for (let idx = 0; idx < nicknames.length; idx++) {
                    const bill = parseInt(bills[idx]) || 0;
                    participants.push({ name: nicknames[idx].trim(), bills: bill });
                    totalBills += bill;
                }

                const contractId = createContract(name, i.user.id, i.channelId, null, percent, participants);
                if (!contractId) return i.editReply('❌ Ошибка создания.');

                const embed = new EmbedBuilder()
                    .setTitle(name)
                    .setColor(0x0099FF)
                    .setDescription(`**Создатель:** <@${i.user.id}>\n**Процент пика:** ${percent}%\n**Всего векселей:** ${totalBills}`)
                    .addFields(
                        participants.map(p => ({
                            name: p.name,
                            value: `Векселей: ${p.bills} | Ожидаемая выплата: ${(p.bills * 1000).toLocaleString()} $`,
                            inline: false
                        }))
                    )
                    .addFields(
                        { name: 'Конец', value: `<t:${Math.floor(endTime / 1000)}:R>`, inline: false },
                        { name: 'ИНСТРУКЦИЯ', value: 'После выполнения контракта нажмите кнопку', inline: false }
                    );

                const membersInfo = getMembersInfo(nicknames);
                const executorMentions = membersInfo.mentions.join(' ');

                const processChannel = await client.channels.fetch(CONFIG.PROCESS);
                let content = `Контракт взял: <@${i.user.id}>`;
                if (executorMentions) content += ` | Исполнители: ${executorMentions}`;

                const msg = await processChannel.send({
                    content: content,
                    embeds: [embed],
                    components: [
                        new ActionRowBuilder().addComponents(
                            new ButtonBuilder().setCustomId(`success_${contractId}`).setLabel('✅ УСПЕХ').setStyle(ButtonStyle.Success),
                            new ButtonBuilder().setCustomId(`fail_${contractId}`).setLabel('❌ ПРОВАЛ').setStyle(ButtonStyle.Danger)
                        )
                    ]
                });

                db.prepare('UPDATE contracts SET msgId = ? WHERE id = ?').run(msg.id, contractId);
                logAction('CONTRACT_CREATE', i.user, `${name} | ${participants.length} участников | ${percent}%`);
                return i.editReply(`✅ Контракт создан! ID: ${contractId}`);
            }

            if (i.customId === 'recruit_form') {
                const nickname = i.fields.getTextInputValue('nickname');
                const role = i.fields.getTextInputValue('role');
                const online = i.fields.getTextInputValue('online');
                const direction = i.fields.getTextInputValue('direction');
                const why = i.fields.getTextInputValue('why');
                
                const existing = ticketsModule.getTicketByUser(i.user.id);
                if (existing) {
                    return i.reply({ content: `❌ У вас уже есть открытый тикет! <#${existing.channelId}>`, flags: [MessageFlags.Ephemeral] });
                }
                
                let category = i.guild.channels.cache.find(c => c.type === 4 && c.name === 'ВСТУПЛЕНИЕ');
                if (!category) {
                    category = await i.guild.channels.create({ name: 'ВСТУПЛЕНИЕ', type: 4 });
                }
                
                const channelName = `вступление-${i.user.username.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
                const channel = await i.guild.channels.create({
                    name: channelName,
                    type: 0,
                    parent: category.id,
                    permissionOverwrites: [
                        { id: i.guild.id, deny: ['ViewChannel'] },
                        { id: i.user.id, allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory'] },
                        { id: CONFIG.RECRUITER_ROLE, allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory'] },
                        { id: CONFIG.DEP_LEAD_ROLE, allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'ManageMessages'] },
                        { id: CONFIG.LEAD_ROLE, allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'ManageMessages', 'ManageChannels'] },
                    ],
                });
                
                const ticketId = `recruit-${Date.now().toString(36)}`;
                ticketsModule.saveTicket(ticketId, channel.id, i.user.id, 'Вступление в семью', 'open');
                
                // ===== СООБЩЕНИЕ В КАНАЛЕ ТИКЕТА С КНОПКОЙ =====
                await channel.send({
                    content: `👋 Добро пожаловать, <@${i.user.id}>! Ожидайте, <@&${CONFIG.RECRUITER_ROLE}> <@&${CONFIG.DEP_LEAD_ROLE}> скоро ответят.`,
                    embeds: [
                        new EmbedBuilder()
                            .setTitle('📋 ТИКЕТ НА ВСТУПЛЕНИЕ')
                            .setDescription(
                                `**Кандидат:** <@${i.user.id}>\n` +
                                `**Никнейм:** ${nickname}\n` +
                                `**Вступление:** ${role}\n` +
                                `**Онлайн:** ${online}\n` +
                                `**Направление:** ${direction}\n\n` +
                                `Задайте вопросы кандидату в этом канале.`
                            )
                            .setColor(0x0099FF)
                            .setTimestamp()
                    ],
                    components: [
                        new ActionRowBuilder().addComponents(
                            new ButtonBuilder()
                                .setCustomId(`close_ticket_${ticketId}`)
                                .setLabel('🔒 Закрыть тикет')
                                .setStyle(ButtonStyle.Danger)
                        )
                    ]
                });
                
                await i.reply({ 
                    content: `✅ Анкета отправлена! Канал создан: ${channel}`,
                    flags: [MessageFlags.Ephemeral] 
                });
                return;
            }

            if (i.customId === 'admin_m') {
                await i.deferReply({ flags: [MessageFlags.Ephemeral] });
                const userId = i.fields.getTextInputValue('userId').trim();
                const name = i.fields.getTextInputValue('n').trim();
                const nicknamesRaw = i.fields.getTextInputValue('nicknames').trim();
                const billsRaw = i.fields.getTextInputValue('bills').trim();
                const timeRaw = i.fields.getTextInputValue('time').trim();
                const percent = parseInt(i.fields.getTextInputValue('percent').trim()) || 10;

                const nicknames = nicknamesRaw.split(';');
                const bills = billsRaw.split(';');
                if (nicknames.length !== bills.length) return i.editReply('❌ Количество ников != векселей.');

                const [h, m] = timeRaw.split(':').map(Number);
                const endTime = Date.now() + (h * 60 + m) * 60 * 1000;

                const participants = [];
                let totalBills = 0;
                for (let idx = 0; idx < nicknames.length; idx++) {
                    const bill = parseInt(bills[idx]) || 0;
                    participants.push({ name: nicknames[idx].trim(), bills: bill });
                    totalBills += bill;
                }

                const contractId = createContract(name, userId, i.channelId, null, percent, participants);
                if (!contractId) return i.editReply('❌ Ошибка создания.');

                const embed = new EmbedBuilder()
                    .setTitle(name)
                    .setColor(0x0099FF)
                    .setDescription(`**Создатель:** <@${userId}>\n**Процент пика:** ${percent}%\n**Всего векселей:** ${totalBills}`)
                    .addFields(
                        participants.map(p => ({
                            name: p.name,
                            value: `Векселей: ${p.bills} | Ожидаемая выплата: ${(p.bills * 1000 * (percent / 100)).toLocaleString()} $`,
                            inline: false
                        }))
                    )
                    .addFields(
                        { name: 'Конец', value: `<t:${Math.floor(endTime / 1000)}:R>`, inline: false },
                        { name: 'ИНСТРУКЦИЯ', value: 'После выполнения контракта нажмите кнопку', inline: false }
                    );

                const membersInfo = getMembersInfo(nicknames);
                const executorMentions = membersInfo.mentions.join(' ');

                const processChannel = await client.channels.fetch(CONFIG.PROCESS);
                let content = `Контракт взял: <@${userId}>`;
                if (executorMentions) content += ` | Исполнители: ${executorMentions}`;

                const msg = await processChannel.send({
                    content: content,
                    embeds: [embed],
                    components: [
                        new ActionRowBuilder().addComponents(
                            new ButtonBuilder().setCustomId(`success_${contractId}`).setLabel('✅ УСПЕХ').setStyle(ButtonStyle.Success),
                            new ButtonBuilder().setCustomId(`fail_${contractId}`).setLabel('❌ ПРОВАЛ').setStyle(ButtonStyle.Danger)
                        )
                    ]
                });

                db.prepare('UPDATE contracts SET msgId = ? WHERE id = ?').run(msg.id, contractId);
                logAction('ADMIN_CONTRACT_CREATE', i.user, `${name} | от <@${userId}> | ${participants.length} участников | ${percent}%`);
                return i.editReply(`✅ Контракт создан от <@${userId}>! ID: ${contractId}`);
            }
        }

    } catch (err) {
        console.error('Ошибка взаимодействия:', err);
        logAction('ERROR', { tag: 'SYSTEM' }, err.message);
    }
});

async function updateStatsMessage(client, statsChannelId, requestedBy = null) {
    if (!statsChannelId) return;
    
    try {
        const stats = getGeneralStats();
        const treasury = getTreasury();
        
        if (requestedBy) {
            saveStatsLastRequest(requestedBy.id, requestedBy.tag);
        }
        
        const lastRequest = getStatsLastRequest();
        
        const embed = new EmbedBuilder()
            .setTitle('📊 ОБЩАЯ СТАТИСТИКА')
            .setColor(0x0099FF)
            .setTimestamp()
            .addFields(
                { name: '📋 Всего контрактов', value: `${stats.totalContracts || 0}`, inline: true },
                { name: '✅ Успешных', value: `${stats.successContracts || 0} (${stats.totalContracts > 0 ? Math.round((stats.successContracts/stats.totalContracts)*100) : 0}%)`, inline: true },
                { name: '❌ Провальных', value: `${stats.failContracts || 0}`, inline: true },
                { name: '⏳ Активных', value: `${stats.activeContracts || 0}`, inline: true },
                { name: '💰 Общая прибыль', value: `${(stats.totalPayout || 0).toLocaleString()} $`, inline: true },
                { name: '💰 В казне', value: `${(treasury?.balance || 0).toLocaleString()} $`, inline: true }
            );
        
        if (stats.topByPayout && stats.topByPayout.length > 0) {
            const text = stats.topByPayout.slice(0, 5).map((p, i) => 
                `${i+1}. ${p.playerName} — ${p.totalPayout.toLocaleString()} $ (${p.successRate || 0}%)`
            ).join('\n');
            embed.addFields({ name: '🏆 ТОП-5 ПО ПРИБЫЛИ', value: text, inline: false });
        }
        
        if (stats.topByTreasury && stats.topByTreasury.length > 0) {
            const text = stats.topByTreasury.slice(0, 5).map((p, i) => 
                `${i+1}. ${p.playerName} — ${p.treasuryTotal.toLocaleString()} $ (${p.treasuryDeposits || 0} раз)`
            ).join('\n');
            embed.addFields({ name: '💰 ТОП-5 ПО ПОПОЛНЕНИЯМ КАЗНЫ', value: text, inline: false });
        }
        
        let footerText = `Обновлено: ${new Date().toLocaleString('ru-RU')}`;
        if (lastRequest && lastRequest.lastRequestAt) {
            const date = new Date(lastRequest.lastRequestAt).toLocaleString('ru-RU');
            const userName = lastRequest.lastRequestUserName || 'Неизвестно';
            footerText += ` | Последний запрос: ${userName} (${date})`;
        }
        embed.setFooter({ text: footerText });
        
        const statsChannel = await client.channels.fetch(statsChannelId);
        if (!statsChannel) return;
        
        const saved = getStatsMessage();
        let statsMsg = null;
        
        if (saved && saved.messageId) {
            try {
                statsMsg = await statsChannel.messages.fetch(saved.messageId);
            } catch (err) {
                statsMsg = null;
            }
        }
        
        if (statsMsg) {
            await statsMsg.edit({ embeds: [embed] });
        } else {
            const newMsg = await statsChannel.send({ embeds: [embed] });
            saveStatsMessage(statsChannelId, newMsg.id);
        }
    } catch (err) {
        console.warn('Не удалось обновить статистику:', err);
    }
}

const shutdown = () => {
    logAction('SYSTEM', client.user, 'Бот выключается');
    try { db.close(); } catch (err) { console.error(err); }
    client.destroy();
    process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

client.login(process.env.TOKEN);