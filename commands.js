const { SlashCommandBuilder, ApplicationCommandType } = require('discord.js');

module.exports = [
    // ===== ОСНОВНЫЕ =====
    new SlashCommandBuilder()
        .setName('вызвать')
        .setDescription('Создать контракт (через модалку)'),

    // ===== СТАТИСТИКА =====
    new SlashCommandBuilder()
        .setName('статистика')
        .setDescription('Общая статистика бота'),

    new SlashCommandBuilder()
        .setName('игрок')
        .setDescription('Статистика игрока')
        .addStringOption(o => o.setName('ник').setDescription('Ник игрока').setRequired(true).setAutocomplete(true)),

    new SlashCommandBuilder()
        .setName('контракты_игрока')
        .setDescription('Активные контракты игрока')
        .addStringOption(o => o.setName('ник').setDescription('Ник игрока').setRequired(true).setAutocomplete(true)),

    // ===== АНАЛИТИКА =====
    new SlashCommandBuilder()
        .setName('выгодность')
        .setDescription('Анализ выгодности пика')
        .addIntegerOption(o => o.setName('процент').setDescription('% пика').setRequired(true).setMinValue(1).setMaxValue(100))
        .addIntegerOption(o => o.setName('векселя').setDescription('Количество векселей').setRequired(true))
        .addIntegerOption(o => o.setName('количество').setDescription('Количество контрактов (по умолчанию 10)').setRequired(false)),

    // ===== КАЗНА =====
    new SlashCommandBuilder()
        .setName('казна')
        .setDescription('Показать баланс казны'),

    new SlashCommandBuilder()
        .setName('пополнить_казну')
        .setDescription('Пополнить казну')
        .addIntegerOption(o => o.setName('сумма').setDescription('Сумма пополнения').setRequired(true).setMinValue(1))
        .addStringOption(o => o.setName('примечание').setDescription('За что пополнение').setRequired(false)),

    new SlashCommandBuilder()
        .setName('снять_из_казны')
        .setDescription('Снять деньги из казны (админ)')
        .addIntegerOption(o => o.setName('сумма').setDescription('Сумма списания').setRequired(true).setMinValue(1))
        .addStringOption(o => o.setName('примечание').setDescription('На что потратили').setRequired(false)),

    new SlashCommandBuilder()
        .setName('история_казны')
        .setDescription('Показать историю операций с казной'),

    // ===== РОЛИ =====
    new SlashCommandBuilder()
        .setName('роли')
        .setDescription('Создать сообщение для выдачи ролей по реакциям')
        .addStringOption(o => o.setName('название').setDescription('Название группы ролей').setRequired(true))
        .addStringOption(o => o.setName('описание').setDescription('Описание').setRequired(false)),

    new SlashCommandBuilder()
        .setName('добавить_роль')
        .setDescription('Добавить роль в сообщение с ролями (админ)')
        .addStringOption(o => o.setName('id_сообщения').setDescription('ID сообщения').setRequired(true))
        .addRoleOption(o => o.setName('роль').setDescription('Роль для выдачи').setRequired(true))
        .addStringOption(o => o.setName('эмодзи').setDescription('Эмодзи для реакции').setRequired(true))
        .addStringOption(o => o.setName('категория').setDescription('Категория (Пол, Сторона и т.д.)').setRequired(true))
        .addStringOption(o => o.setName('подпись').setDescription('Текст рядом с эмодзи').setRequired(true)),

    new SlashCommandBuilder()
        .setName('удалить_роль')
        .setDescription('Удалить роль из сообщения с ролями (админ)')
        .addStringOption(o => o.setName('id_сообщения').setDescription('ID сообщения').setRequired(true))
        .addRoleOption(o => o.setName('роль').setDescription('Роль для удаления').setRequired(true)),

    // ===== АВТОРОЛИ =====
    new SlashCommandBuilder()
        .setName('автороль')
        .setDescription('Настроить автоматическую выдачу роли при входе (админ)')
        .addRoleOption(o => o.setName('роль').setDescription('Роль для автоматической выдачи').setRequired(true)),

    new SlashCommandBuilder()
        .setName('убрать_автороль')
        .setDescription('Убрать автоматическую выдачу роли (админ)'),

    // ===== ТИКЕТЫ (РЕКРУТИНГ) =====
    new SlashCommandBuilder()
        .setName('рекрут')
        .setDescription('Создать панель для набора в семью (админ)'),

    // ===== КОНТЕКСТНОЕ МЕНЮ =====
    { name: 'Закрыть контракт', type: ApplicationCommandType.Message },
    { name: 'Импортировать контракт', type: ApplicationCommandType.Message },
];