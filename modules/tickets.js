const db = require('../database');

function saveTicket(ticketId, channelId, userId, topic, status = 'open') {
    db.prepare(`
        INSERT INTO tickets (ticketId, channelId, userId, topic, status, createdAt)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(ticketId, channelId, userId, topic, status, Date.now());
}

function closeTicket(channelId) {
    db.prepare('UPDATE tickets SET status = "closed", closedAt = ? WHERE channelId = ?')
        .run(Date.now(), channelId);
}

function getTicketByChannel(channelId) {
    return db.prepare('SELECT * FROM tickets WHERE channelId = ? AND status = "open"').get(channelId);
}

function getTicketByUser(userId) {
    return db.prepare('SELECT * FROM tickets WHERE userId = ? AND status = "open"').get(userId);
}

module.exports = { saveTicket, closeTicket, getTicketByChannel, getTicketByUser };