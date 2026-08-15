const db = require('../database');
const { EmbedBuilder } = require('discord.js');

// ===== СОХРАНЕНИЕ СООБЩЕНИЙ =====

function saveStatsMessage(channelId, messageId) {
    db.prepare(`
        UPDATE stats_message SET channelId = ?, messageId = ?, updatedAt = ? WHERE id = 1
    `).run(channelId, messageId, Date.now());
}

function getStatsMessage() {
    return db.prepare('SELECT channelId, messageId FROM stats_message WHERE id = 1').get();
}

function savePlayerStatsMessage(playerName, channelId, messageId) {
    db.prepare(`
        INSERT OR REPLACE INTO player_stats_messages (playerName, channelId, messageId, createdAt)
        VALUES (?, ?, ?, ?)
    `).run(playerName, channelId, messageId, Date.now());
}

function getPlayerStatsMessage(playerName) {
    return db.prepare('SELECT channelId, messageId FROM player_stats_messages WHERE playerName = ?').get(playerName);
}

function deletePlayerStatsMessage(playerName) {
    db.prepare('DELETE FROM player_stats_messages WHERE playerName = ?').run(playerName);
}

function saveStatsLastRequest(userId, userName) {
    db.prepare(`
        UPDATE stats_message SET lastRequestUserId = ?, lastRequestUserName = ?, lastRequestAt = ? WHERE id = 1
    `).run(userId, userName, Date.now());
}

function getStatsLastRequest() {
    return db.prepare('SELECT lastRequestUserId, lastRequestUserName, lastRequestAt FROM stats_message WHERE id = 1').get();
}

// ===== ОБЩАЯ СТАТИСТИКА =====

function getGeneralStats() {
    const totalContracts = db.prepare('SELECT COUNT(*) as count FROM contracts WHERE status != "active"').get().count || 0;
    const successContracts = db.prepare("SELECT COUNT(*) as count FROM contracts WHERE status = 'success'").get().count || 0;
    const failContracts = db.prepare("SELECT COUNT(*) as count FROM contracts WHERE status = 'fail'").get().count || 0;
    const activeContracts = db.prepare("SELECT COUNT(*) as count FROM contracts WHERE status = 'active'").get().count || 0;
    const totalPayout = db.prepare('SELECT SUM(totalPayout) as total FROM contracts WHERE status = "success"').get().total || 0;
    
    const topByPayout = db.prepare(`
        SELECT playerName, totalContracts, successContracts, failContracts, totalPayout,
               ROUND((successContracts * 100.0 / totalContracts), 1) as successRate
        FROM player_stats WHERE totalContracts > 0
        ORDER BY totalPayout DESC LIMIT 10
    `).all();

    const topBySuccess = db.prepare(`
        SELECT playerName, totalContracts, successContracts, failContracts, totalPayout,
               ROUND((successContracts * 100.0 / totalContracts), 1) as successRate
        FROM player_stats WHERE totalContracts >= 5
        ORDER BY successRate DESC LIMIT 10
    `).all();

    const topByTreasury = db.prepare(`
        SELECT playerName, treasuryDeposits, treasuryTotal
        FROM player_stats WHERE treasuryTotal > 0
        ORDER BY treasuryTotal DESC LIMIT 10
    `).all();

    return { totalContracts, successContracts, failContracts, activeContracts, totalPayout, topByPayout, topBySuccess, topByTreasury };
}

// ===== ИНДИВИДУАЛЬНАЯ СТАТИСТИКА =====

function getPlayerStats(playerName) {
    const stats = db.prepare('SELECT * FROM player_stats WHERE playerName = ?').get(playerName);
    if (!stats) return null;
    
    const successRate = stats.totalContracts > 0 
        ? Math.round((stats.successContracts / stats.totalContracts) * 100) 
        : 0;
    
    return {
        ...stats,
        successRate,
        avgPayout: stats.totalContracts > 0 ? Math.round(stats.totalPayout / stats.totalContracts) : 0
    };
}

function getPlayerContracts(playerName) {
    return db.prepare(`
        SELECT c.id, c.title, c.status, c.percent, c.totalBills, cp.payout
        FROM contract_participants cp
        JOIN contracts c ON cp.contractId = c.id
        WHERE cp.playerName = ? AND c.status = 'active'
        ORDER BY c.createdAt DESC
    `).all(playerName);
}

function getTreasury() {
    return db.prepare('SELECT balance FROM treasury WHERE id = 1').get();
}

// ===== ОБНОВЛЕНИЕ СТАТИСТИКИ В КАНАЛЕ =====

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

// ===== ОЧИСТКА КАНАЛА =====

async function cleanStatsChannel(client, statsChannelId) {
    if (!statsChannelId) return;
    
    try {
        const statsChannel = await client.channels.fetch(statsChannelId);
        if (!statsChannel) return;
        
        const messages = await statsChannel.messages.fetch({ limit: 50 });
        const statsMsgId = getStatsMessage()?.messageId;
        
        const sortedMessages = messages
            .filter(m => m.id !== statsMsgId)
            .sort((a, b) => a.createdAt - b.createdAt);
        
        const toDelete = sortedMessages.slice(0, sortedMessages.length - 4);
        
        for (const msg of toDelete) {
            try {
                await msg.delete();
                const entry = db.prepare('SELECT playerName FROM player_stats_messages WHERE messageId = ?').get(msg.id);
                if (entry) {
                    deletePlayerStatsMessage(entry.playerName);
                }
            } catch (err) {
                console.warn('Не удалось удалить сообщение:', err);
            }
        }
    } catch (err) {
        console.warn('Ошибка очистки канала статистики:', err);
    }
}

module.exports = {
    saveStatsMessage,
    getStatsMessage,
    savePlayerStatsMessage,
    getPlayerStatsMessage,
    deletePlayerStatsMessage,
    saveStatsLastRequest,
    getStatsLastRequest,
    getGeneralStats,
    getPlayerStats,
    getPlayerContracts,
    getTreasury,
    updateStatsMessage,
    cleanStatsChannel
};