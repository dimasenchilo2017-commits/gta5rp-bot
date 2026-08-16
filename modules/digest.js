const db = require('../database');
const { EmbedBuilder } = require('discord.js');

function getWeekStats() {
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

    const totalContracts = db.prepare("SELECT COUNT(*) as count FROM contracts WHERE closedAt > ?").get(weekAgo).count || 0;
    const successContracts = db.prepare("SELECT COUNT(*) as count FROM contracts WHERE status = 'success' AND closedAt > ?").get(weekAgo).count || 0;
    const failContracts = db.prepare("SELECT COUNT(*) as count FROM contracts WHERE status = 'fail' AND closedAt > ?").get(weekAgo).count || 0;
    const totalPayout = db.prepare("SELECT SUM(totalPayout) as total FROM contracts WHERE status = 'success' AND closedAt > ?").get(weekAgo).total || 0;

    return { totalContracts, successContracts, failContracts, totalPayout };
}

function getWeekDates() {
    const now = new Date();
    const start = new Date(now);
    start.setDate(now.getDate() - 7);
    const end = now;
    return {
        start: start.toLocaleDateString('ru-RU'),
        end: end.toLocaleDateString('ru-RU')
    };
}

function getWeekDigestEmbed() {
    const stats = getWeekStats();
    const dates = getWeekDates();

    return new EmbedBuilder()
        .setTitle(`📊 НЕДЕЛЬНЫЙ ДАЙДЖЕСТ`)
        .setDescription(`**${dates.start} — ${dates.end}**`)
        .setColor(0x0099FF)
        .setTimestamp()
        .addFields(
            { name: '📋 Контрактов', value: `${stats.totalContracts}`, inline: true },
            { name: '✅ Успешных', value: `${stats.successContracts} (${stats.totalContracts > 0 ? Math.round((stats.successContracts/stats.totalContracts)*100) : 0}%)`, inline: true },
            { name: '❌ Провальных', value: `${stats.failContracts}`, inline: true },
            { name: '💰 Общая прибыль', value: `${stats.totalPayout.toLocaleString()} $`, inline: true }
        );
}

module.exports = { getWeekStats, getWeekDates, getWeekDigestEmbed };