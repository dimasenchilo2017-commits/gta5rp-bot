const db = require('../database');

function saveRoleMessage(messageId, channelId, roleId, emoji, category, label) {
    db.prepare(`
        INSERT OR REPLACE INTO role_messages (messageId, channelId, roleId, emoji, category, label, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(messageId, channelId, roleId, emoji, category, label, Date.now());
}

function getRoleByReaction(messageId, emoji) {
    return db.prepare('SELECT roleId FROM role_messages WHERE messageId = ? AND emoji = ?').get(messageId, emoji);
}

function deleteRoleMessage(messageId, roleId) {
    db.prepare('DELETE FROM role_messages WHERE messageId = ? AND roleId = ?').run(messageId, roleId);
}

module.exports = { saveRoleMessage, getRoleByReaction, deleteRoleMessage };