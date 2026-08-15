const db = require('./database.js');

try {
    db.prepare("DELETE FROM tickets").run();
    console.log('✅ Все тикеты удалены!');
} catch (err) {
    console.error('Ошибка:', err);
}