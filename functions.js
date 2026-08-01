const db = require('./database');
const membersData = require('./members.js');

// Map: игровой ник -> discordId
const membersMap = new Map();
membersData.forEach(m => { if (m.discordId) membersMap.set(m.gameName, m.discordId); });

// Получение упоминаний по никам
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

// Списание долга
function deductDebt(debtorName, amount) {
    if (amount <= 0 || !debtorName) return;
    db.prepare('UPDATE debtors SET amount = amount - ? WHERE name = ?').run(amount, debtorName);
    db.prepare('DELETE FROM debtors WHERE amount <= 0').run();
}

// Списание просрочки
function deductOverdue(debtorName, amount) {
    if (amount <= 0 || !debtorName) return;
    const records = db.prepare('SELECT id, amount FROM overdue WHERE debtorName = ? AND resolved = 0 ORDER BY deadline ASC').all(debtorName);
    let remaining = amount;
    for (const rec of records) {
        if (remaining <= 0) break;
        const deduct = Math.min(rec.amount, remaining);
        const newAmount = rec.amount - deduct;
        if (newAmount <= 0) db.prepare('UPDATE overdue SET resolved = 1 WHERE id = ?').run(rec.id);
        else db.prepare('UPDATE overdue SET amount = ? WHERE id = ?').run(newAmount, rec.id);
        remaining -= deduct;
    }
    if (remaining > 0) deductDebt(debtorName, remaining);
}

// Списание критической просрочки
function deductCritical(debtorName, amount) {
    if (amount <= 0 || !debtorName) return;
    const records = db.prepare('SELECT id, amount FROM critical_overdue WHERE debtorName = ? AND resolved = 0 ORDER BY deadline ASC').all(debtorName);
    let remaining = amount;
    for (const rec of records) {
        if (remaining <= 0) break;
        const deduct = Math.min(rec.amount, remaining);
        const newAmount = rec.amount - deduct;
        if (newAmount <= 0) db.prepare('UPDATE critical_overdue SET resolved = 1 WHERE id = ?').run(rec.id);
        else db.prepare('UPDATE critical_overdue SET amount = ? WHERE id = ?').run(newAmount, rec.id);
        remaining -= deduct;
    }
    if (remaining > 0) deductDebt(debtorName, remaining);
}

// Внесение оплаты вручную
function addManualPayment(title, amount, participants, creatorId) {
    const paymentId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    const deadline = Date.now() + 72 * 60 * 60 * 1000;
    db.prepare(`INSERT INTO pending_payments (contractMsgId, paymentMsgId, creatorId, title, totalAmount, createdAt, deadline, paid) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(`manual_${paymentId}`, `manual_${paymentId}`, creatorId, title, amount, Date.now(), deadline, 0);
    participants.split(';').forEach(name => {
        const trimmed = name.trim();
        if (trimmed) {
            const existing = db.prepare('SELECT amount FROM debtors WHERE name = ?').get(trimmed);
            if (existing) db.prepare('UPDATE debtors SET amount = amount + ? WHERE name = ?').run(amount, trimmed);
            else db.prepare('INSERT INTO debtors (name, amount) VALUES (?, ?)').run(trimmed, amount);
        }
    });
    return paymentId;
}

// Форматирование просрочек
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

// Таймер
const setupTimer = async (client, channel, creatorId, endTime) => {
    const remaining = endTime - Date.now();
    setTimeout(async () => {
        try { await channel.send(`⚠️ **ВРЕМЯ ВЫШЛО!** <@${creatorId}>, проверьте и закройте контракт после того как он завершится в игре!`); } 
        catch (err) { console.error('Ошибка таймера:', err); }
    }, Math.max(0, remaining));
};

// Получение деталей ожидающих оплат
async function getPendingDetails(client, pendingRecords, CONFIG) {
    if (pendingRecords.length === 0) return '';
    const payChannel = await client.channels.fetch(CONFIG.PAY);
    let result = '';
    for (const p of pendingRecords) {
        const isManual = p.contractMsgId && p.contractMsgId.startsWith('manual_');
        try {
            const msg = await payChannel.messages.fetch(p.paymentMsgId);
            if (msg.embeds && msg.embeds.length > 0 && msg.embeds[0].fields) {
                const fields = msg.embeds[0].fields;
                let allPaid = true, participantLines = [], hasAnyParticipants = false;
                for (const field of fields) {
                    const amountMatch = field.value.match(/([\d, ]+)\s*\$?/);
                    const amount = amountMatch ? amountMatch[1].trim() : '0';
                    const cleanAmount = parseInt(amount.replace(/\s/g, '')) || 0;
                    const paidMarker = db.prepare(`SELECT 1 FROM paid_markers WHERE debtorName = ? AND contractTitle = ? AND amount = ?`).get(field.name, p.title, cleanAmount);
                    const isPaid = !!paidMarker;
                    if (!isPaid) allPaid = false;
                    hasAnyParticipants = true;
                    if (isPaid) participantLines.push(`   • ~~**${field.name}**: ${amount} $~~ ✅`);
                    else participantLines.push(`   • **${field.name}**: ${amount} $`);
                }
                if (allPaid && hasAnyParticipants) continue;
                result += `💳 **${p.title}**${isManual ? ' (📝 ручная оплата)' : ''}\n${participantLines.join('\n')}\n`;
                const timeLeft = Math.round((p.deadline - Date.now()) / (1000 * 60 * 60));
                result += `   ${timeLeft > 0 ? `⏳ осталось ${timeLeft} ч.` : '⌛ **ПРОСРОЧЕН!**'}\n`;
            } else {
                result += `💳 **${p.title}**${isManual ? ' (📝 ручная оплата)' : ''}\n   (данные о платеже недоступны, общая сумма: ${p.totalAmount.toLocaleString()} $)\n`;
                const timeLeft = Math.round((p.deadline - Date.now()) / (1000 * 60 * 60));
                result += `   ${timeLeft > 0 ? `⏳ осталось ${timeLeft} ч.` : '⌛ **ПРОСРОЧЕН!**'}\n`;
            }
        } catch (e) {
            result += `💳 **${p.title}**${isManual ? ' (📝 ручная оплата)' : ''}\n   (сообщение с платежом не найдено, общая сумма: ${p.totalAmount.toLocaleString()} $)\n`;
            const timeLeft = Math.round((p.deadline - Date.now()) / (1000 * 60 * 60));
            result += `   ${timeLeft > 0 ? `⏳ осталось ${timeLeft} ч.` : '⌛ **ПРОСРОЧЕН!**'}\n`;
        }
        result += '\n';
    }
    return result;
}

// Кошелёк
function addToWallet(playerName, amount) {
    const existing = db.prepare('SELECT balance FROM wallets WHERE playerName = ?').get(playerName);
    if (existing) db.prepare('UPDATE wallets SET balance = balance + ?, updatedAt = ? WHERE playerName = ?').run(amount, Date.now(), playerName);
    else db.prepare('INSERT INTO wallets (playerName, balance, updatedAt) VALUES (?, ?, ?)').run(playerName, amount, Date.now());
    return db.prepare('SELECT balance FROM wallets WHERE playerName = ?').get(playerName);
}

function getWallet(playerName) {
    return db.prepare('SELECT balance, updatedAt FROM wallets WHERE playerName = ?').get(playerName);
}

function payFromWallet(playerName, contractTitle, amount, markedBy) {
    const wallet = db.prepare('SELECT balance FROM wallets WHERE playerName = ?').get(playerName);
    if (!wallet || wallet.balance < amount) throw new Error('Недостаточно средств');
    db.prepare('UPDATE wallets SET balance = balance - ?, updatedAt = ? WHERE playerName = ?').run(amount, Date.now(), playerName);
    db.prepare(`INSERT INTO paid_markers (debtorName, contractTitle, amount, markedBy, createdAt) VALUES (?, ?, ?, ?, ?)`).run(playerName, contractTitle, amount, markedBy, Date.now());
    deductDebt(playerName, amount);
    db.prepare('UPDATE treasury SET balance = balance + ? WHERE id = 1').run(amount);
    return db.prepare('SELECT balance FROM wallets WHERE playerName = ?').get(playerName);
}
// Логирование действий
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
    getMembersInfo, deductDebt, deductOverdue, deductCritical,
    addManualPayment, formatOverdue, setupTimer, getPendingDetails,
    addToWallet, getWallet, payFromWallet,
    logAction, logCommand, logButton, logModal, logMessage
};