const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const dbDir = '/app/contracts-db';
const dbPath = path.join(dbDir, 'contracts.db');

if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath);
db.pragma('synchronous = NORMAL');
db.pragma('journal_mode = WAL');

db.exec(`
    CREATE TABLE IF NOT EXISTS contracts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        msgId TEXT,
        title TEXT,
        creatorId TEXT,
        channelId TEXT,
        createdAt INTEGER,
        endTime INTEGER,
        status TEXT DEFAULT 'active',
        percent INTEGER,
        totalBills INTEGER DEFAULT 0,
        totalPayout INTEGER DEFAULT 0,
        closedAt INTEGER
    );

    CREATE TABLE IF NOT EXISTS contract_participants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contractId INTEGER,
        playerName TEXT,
        bills INTEGER DEFAULT 0,
        payout INTEGER DEFAULT 0,
        FOREIGN KEY (contractId) REFERENCES contracts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS player_stats (
        playerName TEXT PRIMARY KEY,
        totalContracts INTEGER DEFAULT 0,
        successContracts INTEGER DEFAULT 0,
        failContracts INTEGER DEFAULT 0,
        totalBills INTEGER DEFAULT 0,
        totalPayout INTEGER DEFAULT 0,
        bestPayout INTEGER DEFAULT 0,
        worstPayout INTEGER DEFAULT 0,
        avgPercent INTEGER DEFAULT 0,
        treasuryDeposits INTEGER DEFAULT 0,
        treasuryTotal INTEGER DEFAULT 0,
        lastUpdated INTEGER
    );

    CREATE TABLE IF NOT EXISTS contract_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contractId INTEGER,
        action TEXT,
        oldStatus TEXT,
        newStatus TEXT,
        changedBy TEXT,
        changedAt INTEGER
    );

    CREATE TABLE IF NOT EXISTS treasury (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        balance INTEGER DEFAULT 0
    );
    INSERT OR IGNORE INTO treasury (id, balance) VALUES (1, 0);

    CREATE TABLE IF NOT EXISTS treasury_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId TEXT NOT NULL,
        amount INTEGER NOT NULL,
        type TEXT CHECK(type IN ('income', 'expense')),
        note TEXT,
        createdAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pick_message (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        messageId TEXT,
        channelId TEXT,
        updatedAt INTEGER
    );
    INSERT OR IGNORE INTO pick_message (id, messageId, channelId, updatedAt) VALUES (1, NULL, NULL, 0);

    CREATE TABLE IF NOT EXISTS stats_message (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        channelId TEXT,
        messageId TEXT,
        updatedAt INTEGER,
        lastRequestUserId TEXT,
        lastRequestUserName TEXT,
        lastRequestAt INTEGER
    );
    INSERT OR IGNORE INTO stats_message (id, channelId, messageId, updatedAt, lastRequestUserId, lastRequestUserName, lastRequestAt) VALUES (1, NULL, NULL, 0, NULL, NULL, 0);

    CREATE TABLE IF NOT EXISTS player_stats_messages (
        playerName TEXT PRIMARY KEY,
        channelId TEXT NOT NULL,
        messageId TEXT NOT NULL,
        createdAt INTEGER
    );

    CREATE TABLE IF NOT EXISTS role_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        messageId TEXT NOT NULL,
        channelId TEXT NOT NULL,
        roleId TEXT NOT NULL,
        emoji TEXT NOT NULL,
        category TEXT NOT NULL,
        label TEXT NOT NULL,
        createdAt INTEGER
    );

    CREATE TABLE IF NOT EXISTS auto_roles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        serverId TEXT NOT NULL,
        roleId TEXT NOT NULL,
        UNIQUE(serverId)
    );

    CREATE TABLE IF NOT EXISTS tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticketId TEXT NOT NULL UNIQUE,
        channelId TEXT NOT NULL,
        userId TEXT NOT NULL,
        topic TEXT NOT NULL,
        status TEXT DEFAULT 'open',
        createdAt INTEGER,
        closedAt INTEGER
    );
`);

module.exports = db;