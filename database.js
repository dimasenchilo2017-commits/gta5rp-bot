const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

// Путь к папке тома (Volume), которая сохраняется после рестарта
const dbDir = '/app/contracts-db';
const dbPath = path.join(dbDir, 'contracts.db');
console.log(`[DEBUG] Файл базы данных находится по пути: ${dbPath}`);
console.log(`[DEBUG] Папка существует: ${fs.existsSync(dbDir)}`);

// Гарантируем наличие папки
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

// Открываем базу данных
const db = new Database(dbPath);
db.pragma('synchronous = NORMAL');

// Включаем WAL-режим для надежности и скорости
db.pragma('journal_mode = WAL');

// Инициализация схем таблиц
db.exec(`
    CREATE TABLE IF NOT EXISTS active_contracts (
        msgId TEXT PRIMARY KEY, 
        creatorId TEXT, 
        endTime INTEGER,
        channelId TEXT
    );
    
    CREATE TABLE IF NOT EXISTS contract_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        msgId TEXT, 
        title TEXT,
        status TEXT, 
        closedAt INTEGER,
        creatorId TEXT
    );
    
    CREATE TABLE IF NOT EXISTS treasury (
        id INTEGER PRIMARY KEY CHECK (id = 1), 
        balance INTEGER DEFAULT 0
    );
    
    CREATE TABLE IF NOT EXISTS debtors (
        name TEXT PRIMARY KEY, 
        amount INTEGER
    );
    
    CREATE TABLE IF NOT EXISTS pending_payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contractMsgId TEXT NOT NULL,
        paymentMsgId TEXT NOT NULL,
        creatorId TEXT NOT NULL,
        title TEXT,
        totalAmount INTEGER NOT NULL,
        createdAt INTEGER NOT NULL,
        deadline INTEGER NOT NULL,
        paid INTEGER DEFAULT 0
    );
    
    CREATE TABLE IF NOT EXISTS overdue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        debtorName TEXT NOT NULL,
        amount INTEGER NOT NULL,
        deadline INTEGER NOT NULL,
        createdAt INTEGER NOT NULL,
        resolved INTEGER DEFAULT 0
    );
    
    CREATE TABLE IF NOT EXISTS critical_overdue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        debtorName TEXT NOT NULL,
        amount INTEGER NOT NULL,
        deadline INTEGER NOT NULL,
        createdAt INTEGER NOT NULL,
        resolved INTEGER DEFAULT 0
    );
    
    CREATE TABLE IF NOT EXISTS paid_markers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        debtorName TEXT NOT NULL,
        contractTitle TEXT NOT NULL,
        amount INTEGER NOT NULL,
        markedBy TEXT NOT NULL,
        createdAt INTEGER NOT NULL
    );
    
    CREATE TABLE IF NOT EXISTS wallets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        playerName TEXT NOT NULL UNIQUE,
        balance INTEGER NOT NULL DEFAULT 0,
        updatedAt INTEGER NOT NULL
    );
`);

// Инициализируем казну
db.prepare('INSERT OR IGNORE INTO treasury (id, balance) VALUES (1, 0)').run();

module.exports = db;