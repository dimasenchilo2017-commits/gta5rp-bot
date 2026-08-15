const db = require('./database');
const membersData = require('./members.js');

const membersMap = new Map();
membersData.forEach(m => { if (m.discordId) membersMap.set(m.gameName, m.discordId); });

function getMembersInfo(nicknames) {
    const result = { mentions: [], displayNames: [] };
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

function createContract(title, creatorId, channelId, msgId, percent, participants) {
    let totalBills = 0;
    for (const p of participants) totalBills += p.bills;

    const result = db.prepare(`
        INSERT INTO contracts (msgId, title, creatorId, channelId, createdAt, endTime, status, percent, totalBills)
        VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(msgId, title, creatorId, channelId, Date.now(), Date.now() + 24*60*60*1000, percent, totalBills);

    const contractId = result.lastInsertRowid;

    for (const p of participants) {
        const payout = Math.round(p.bills * 1000 * (percent / 100));
        db.prepare(`INSERT INTO contract_participants (contractId, playerName, bills, payout) VALUES (?, ?, ?, ?)`)
            .run(contractId, p.name, p.bills, payout);
    }

    const totalPayout = participants.reduce((sum, p) => sum + Math.round(p.bills * 1000 * (percent / 100)), 0);
    db.prepare('UPDATE contracts SET totalPayout = ? WHERE id = ?').run(totalPayout, contractId);

    return contractId;
}

function closeContract(contractId, status, closedBy) {
    const contract = db.prepare('SELECT * FROM contracts WHERE id = ?').get(contractId);
    if (!contract || contract.status !== 'active') return null;

    db.prepare(`UPDATE contracts SET status = ?, closedAt = ? WHERE id = ?`).run(status, Date.now(), contractId);
    db.prepare(`INSERT INTO contract_history (contractId, action, oldStatus, newStatus, changedBy, changedAt) VALUES (?, 'close', ?, ?, ?, ?)`)
        .run(contractId, 'active', status, closedBy, Date.now());

    const participants = db.prepare(`SELECT playerName, payout, bills FROM contract_participants WHERE contractId = ?`).all(contractId);
    const isSuccess = status === 'success';
    const isFail = status === 'fail';

    for (const p of participants) {
        const stats = db.prepare('SELECT * FROM player_stats WHERE playerName = ?').get(p.playerName);
        
        if (stats) {
            const newTotal = stats.totalContracts + 1;
            const newSuccess = stats.successContracts + (isSuccess ? 1 : 0);
            const newFail = stats.failContracts + (isFail ? 1 : 0);
            const newTotalBills = stats.totalBills + p.bills;
            const newTotalPayout = stats.totalPayout + (isSuccess ? p.payout : 0);
            const newBest = Math.max(stats.bestPayout, isSuccess ? p.payout : 0);
            const newWorst = stats.worstPayout === 0 ? (isSuccess ? p.payout : 0) : Math.min(stats.worstPayout, isSuccess ? p.payout : 0);
            const currentAvg = stats.avgPercent * stats.totalContracts;
            const newAvg = Math.round((currentAvg + contract.percent) / newTotal);
            
            db.prepare(`UPDATE player_stats SET totalContracts=?, successContracts=?, failContracts=?, totalBills=?, totalPayout=?, bestPayout=?, worstPayout=?, avgPercent=?, lastUpdated=? WHERE playerName=?`)
                .run(newTotal, newSuccess, newFail, newTotalBills, newTotalPayout, newBest, newWorst, newAvg, Date.now(), p.playerName);
        } else {
            db.prepare(`INSERT INTO player_stats (playerName, totalContracts, successContracts, failContracts, totalBills, totalPayout, bestPayout, worstPayout, avgPercent, lastUpdated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(p.playerName, 1, isSuccess ? 1 : 0, isFail ? 1 : 0, p.bills, isSuccess ? p.payout : 0, isSuccess ? p.payout : 0, isSuccess ? p.payout : 0, contract.percent, Date.now());
        }
    }

    return contract;
}

function getPlayerStats(playerName) {
    const stats = db.prepare('SELECT * FROM player_stats WHERE playerName = ?').get(playerName);
    if (!stats) return null;
    const successRate = stats.totalContracts > 0 ? Math.round((stats.successContracts / stats.totalContracts) * 100) : 0;
    return { ...stats, successRate, avgPayout: stats.totalContracts > 0 ? Math.round(stats.totalPayout / stats.totalContracts) : 0 };
}

function getGeneralStats() {
    const totalContracts = db.prepare('SELECT COUNT(*) as count FROM contracts WHERE status != "active"').get().count || 0;
    const successContracts = db.prepare("SELECT COUNT(*) as count FROM contracts WHERE status = 'success'").get().count || 0;
    const failContracts = db.prepare("SELECT COUNT(*) as count FROM contracts WHERE status = 'fail'").get().count || 0;
    const activeContracts = db.prepare("SELECT COUNT(*) as count FROM contracts WHERE status = 'active'").get().count || 0;
    const totalPayout = db.prepare('SELECT SUM(totalPayout) as total FROM contracts WHERE status = "success"').get().total || 0;
    
    const topByPayout = db.prepare(`SELECT playerName, totalContracts, successContracts, failContracts, totalPayout, ROUND((successContracts * 100.0 / totalContracts), 1) as successRate FROM player_stats WHERE totalContracts > 0 ORDER BY totalPayout DESC LIMIT 10`).all();
    const topBySuccess = db.prepare(`SELECT playerName, totalContracts, successContracts, failContracts, totalPayout, ROUND((successContracts * 100.0 / totalContracts), 1) as successRate FROM player_stats WHERE totalContracts >= 5 ORDER BY successRate DESC LIMIT 10`).all();
    const topByTreasury = db.prepare(`SELECT playerName, treasuryDeposits, treasuryTotal FROM player_stats WHERE treasuryTotal > 0 ORDER BY treasuryTotal DESC LIMIT 10`).all();

    return { totalContracts, successContracts, failContracts, activeContracts, totalPayout, topByPayout, topBySuccess, topByTreasury };
}

function getPlayerContracts(playerName) {
    return db.prepare(`SELECT c.id, c.title, c.status, c.percent, c.totalBills, cp.payout FROM contract_participants cp JOIN contracts c ON cp.contractId = c.id WHERE cp.playerName = ? AND c.status = 'active' ORDER BY c.createdAt DESC`).all(playerName);
}

function analyzeProfitability(percent, bills, count = 10) {
    const oneContract = bills * 1000 * (percent / 100);
    const multiContracts = oneContract * count;
    const basePayout = 50 * 1000 * count;
    return { percent, bills, count, oneContract, multiContracts, basePayout, difference: multiContracts - basePayout, isProfitable: multiContracts > basePayout };
}

function getTreasury() {
    return db.prepare('SELECT balance FROM treasury WHERE id = 1').get();
}

function addToTreasury(amount, userId, note = '') {
    if (amount <= 0) return null;
    db.prepare('UPDATE treasury SET balance = balance + ? WHERE id = 1').run(amount);
    const newBalance = db.prepare('SELECT balance FROM treasury WHERE id = 1').get().balance;
    db.prepare(`INSERT INTO treasury_logs (userId, amount, type, note, createdAt) VALUES (?, ?, 'income', ?, ?)`).run(userId, amount, note, Date.now());
    
    const stats = db.prepare('SELECT * FROM player_stats WHERE playerName = ?').get(userId);
    if (stats) {
        db.prepare(`UPDATE player_stats SET treasuryDeposits = treasuryDeposits + 1, treasuryTotal = treasuryTotal + ?, lastUpdated = ? WHERE playerName = ?`).run(amount, Date.now(), userId);
    } else {
        db.prepare(`INSERT INTO player_stats (playerName, treasuryDeposits, treasuryTotal, lastUpdated) VALUES (?, 1, ?, ?)`).run(userId, amount, Date.now());
    }
    return newBalance;
}

function subtractFromTreasury(amount, userId, note = '') {
    if (amount <= 0) return null;
    const current = getTreasury();
    if (!current || current.balance < amount) return null;
    db.prepare('UPDATE treasury SET balance = balance - ? WHERE id = 1').run(amount);
    const newBalance = getTreasury().balance;
    db.prepare(`INSERT INTO treasury_logs (userId, amount, type, note, createdAt) VALUES (?, ?, 'expense', ?, ?)`).run(userId, amount, note, Date.now());
    return newBalance;
}

function getTreasuryLogs(limit = 20) {
    return db.prepare(`SELECT * FROM treasury_logs ORDER BY createdAt DESC LIMIT ?`).all(limit);
}

// Статистика в канале
function saveStatsMessage(channelId, messageId) {
    db.prepare(`UPDATE stats_message SET channelId = ?, messageId = ?, updatedAt = ? WHERE id = 1`).run(channelId, messageId, Date.now());
}

function getStatsMessage() {
    return db.prepare('SELECT channelId, messageId FROM stats_message WHERE id = 1').get();
}

function savePlayerStatsMessage(playerName, channelId, messageId) {
    db.prepare(`INSERT OR REPLACE INTO player_stats_messages (playerName, channelId, messageId, createdAt) VALUES (?, ?, ?, ?)`).run(playerName, channelId, messageId, Date.now());
}

function getPlayerStatsMessage(playerName) {
    return db.prepare('SELECT channelId, messageId FROM player_stats_messages WHERE playerName = ?').get(playerName);
}

function deletePlayerStatsMessage(playerName) {
    db.prepare('DELETE FROM player_stats_messages WHERE playerName = ?').run(playerName);
}

function saveStatsLastRequest(userId, userName) {
    db.prepare(`UPDATE stats_message SET lastRequestUserId = ?, lastRequestUserName = ?, lastRequestAt = ? WHERE id = 1`).run(userId, userName, Date.now());
}

function getStatsLastRequest() {
    return db.prepare('SELECT lastRequestUserId, lastRequestUserName, lastRequestAt FROM stats_message WHERE id = 1').get();
}

function logAction(type, user, data) {
    const timestamp = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
    const userName = user?.tag || user?.username || user?.id || 'SYSTEM';
    console.log(`[${timestamp}] 📌 ${type} | ${userName} | ${data}`);
}

function logCommand(i, details = '') {
    const timestamp = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
    console.log(`[${timestamp}] 📋 КОМАНДА | ${i.user.tag} (${i.user.id}) | /${i.commandName} ${details}`);
}

function logButton(i, details = '') {
    const timestamp = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
    console.log(`[${timestamp}] 🔘 КНОПКА | ${i.user.tag} (${i.user.id}) | ${i.customId} ${details}`);
}

function logModal(i, details = '') {
    const timestamp = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
    console.log(`[${timestamp}] 📝 МОДАЛКА | ${i.user.tag} (${i.user.id}) | ${i.customId} ${details}`);
}

function logMessage(msg, details = '') {
    const timestamp = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
    console.log(`[${timestamp}] 💬 СООБЩЕНИЕ | ${msg.author.tag} (${msg.author.id}) | ${msg.content} ${details}`);
}

module.exports = {
    getMembersInfo, createContract, closeContract, getPlayerStats, getGeneralStats,
    getPlayerContracts, analyzeProfitability,
    getTreasury, addToTreasury, subtractFromTreasury, getTreasuryLogs,
    saveStatsMessage, getStatsMessage, savePlayerStatsMessage, getPlayerStatsMessage,
    deletePlayerStatsMessage, saveStatsLastRequest, getStatsLastRequest,
    logAction, logCommand, logButton, logModal, logMessage
};