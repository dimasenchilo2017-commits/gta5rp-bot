const db = require('../database');

function setAutoRole(roleId, serverId) {
    db.prepare(`
        INSERT OR REPLACE INTO auto_roles (serverId, roleId)
        VALUES (?, ?)
    `).run(serverId, roleId);
}

function getAutoRole(serverId) {
    const result = db.prepare('SELECT roleId FROM auto_roles WHERE serverId = ?').get(serverId);
    return result ? result.roleId : null;
}

function removeAutoRole(serverId) {
    db.prepare('DELETE FROM auto_roles WHERE serverId = ?').run(serverId);
}

module.exports = { setAutoRole, getAutoRole, removeAutoRole };