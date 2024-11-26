require('dotenv').config()
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const cheerio = require('cheerio');
const { Client } = require('pg');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN; // Замените на токен вашего бота
const NEWS_URL = process.env.NEWS_URL;
const DB_CONFIG = {
    user: process.env.DB_USER, // Замените на ваше имя пользователя PostgreSQL
    host: process.env.DB_HOST, // Или IP-адрес вашего сервера
    database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD, // Замените на ваш пароль
    port: process.env.DB_PORT,
};


// Создаем подключение к базе данных
const client = new Client(DB_CONFIG);
client.connect();

// Создаем бота
const bot = new TelegramBot(TOKEN, { polling: true });

// Функция для получения списка новостей
async function fetchNews() {
    try {
        const response = await axios.get(NEWS_URL);
        const $ = cheerio.load(response.data);

        const newsBlocks = $('.fp_news_title.titles_a').slice(0, 20);
        const newsList = [];

        newsBlocks.each((_, block) => {
            const title = $(block).find('a').text().trim();
            let link = $(block).find('a').attr('href');
            if (!link.startsWith('http')) {
                link = `${NEWS_URL}${link}`;
            }
            newsList.push({ title, link });
        });

        return newsList;
    } catch (error) {
        console.error(`Ошибка при парсинге новостей: ${error.message}`);
        return [];
    }
}

// Функция для получения контента новости
async function fetchNewsDetails(link) {
    try {
        const response = await axios.get(link);
        const $ = cheerio.load(response.data);

        const contentBlock = $('.content_left');
        if (!contentBlock.length) return 'Не удалось извлечь текст новости.';

        const textBlocks = [];
        const unwantedLines = ['Главная /', 'Новости /', 'Новости района /'];

        // Ищем текстовые блоки, исключая ненужный JavaScript
        contentBlock.find('div').each((_, element) => {
            const text = $(element).text().trim();
            if (
                text &&
                !unwantedLines.some((line) => text.includes(line)) &&
                !text.includes('(function(w,doc)') // Игнорируем код JavaScript
            ) {
                textBlocks.push(text);
            }
        });

        if (textBlocks.length > 1) textBlocks.pop(); // Удаляем последнюю строку
        return textBlocks.join('\n');
    } catch (error) {
        console.error(`Ошибка при парсинге контента новости: ${error.message}`);
        return 'Ошибка загрузки подробностей.';
    }
}

// Функция для сохранения ID чата в базе данных
async function saveChatId(chatId) {
    try {
        const res = await client.query(
            'INSERT INTO chats (chat_id) VALUES ($1) ON CONFLICT (chat_id) DO NOTHING',
            [chatId]
        );
        console.log(`Chat ID ${chatId} сохранен в базе данных.`);
    } catch (error) {
        console.error(`Ошибка при сохранении chat_id: ${error.message}`);
    }
}

// Функция для получения всех зарегистрированных чатов
async function getAllChats() {
    try {
        const res = await client.query('SELECT chat_id FROM chats');
        return res.rows.map(row => row.chat_id);
    } catch (error) {
        console.error(`Ошибка при получении чатов: ${error.message}`);
        return [];
    }
}

// Функция для получения уже отправленных новостей
async function getSentNews(chatId) {
    try {
        const res = await client.query('SELECT news_link FROM sent_news WHERE chat_id = $1', [chatId]);
        return res.rows.map(row => row.news_link);
    } catch (error) {
        console.error(`Ошибка при получении отправленных новостей: ${error.message}`);
        return [];
    }
}

// Функция для сохранения отправленной новости
async function saveSentNews(chatId, link) {
    try {
        await client.query('INSERT INTO sent_news (chat_id, news_link) VALUES ($1, $2)', [chatId, link]);
        console.log(`Новость с ссылкой ${link} отправлена чату ${chatId}`);
    } catch (error) {
        console.error(`Ошибка при сохранении отправленной новости: ${error.message}`);
    }
}

// Функция отправки новостей всем зарегистрированным чатам
async function sendNewsToAll() {
    const newsList = await fetchNews();

    const allChats = await getAllChats();

    for (const chatId of allChats) {
        const sentNews = await getSentNews(chatId);

        for (const { title, link } of newsList) {
            if (!sentNews.includes(link)) {
                const newsContent = await fetchNewsDetails(link);
                const message = `<b>${title}</b>\n\n${newsContent}\n\n<a href="${link}">Читать подробнее</a>`;
                await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });

                // Сохраняем отправленную новость в базе данных
                await saveSentNews(chatId, link);
            }
        }
    }
}

// Обработчик команды /start
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    await bot.sendMessage(chatId, 'Бот новостей запущен! Я буду отправлять вам новости.');
    await saveChatId(chatId); // Сохраняем chat_id в базе данных
});

// Обработчик команды /news
bot.onText(/\/news/, async (msg) => {
    const chatId = msg.chat.id;
    const newsList = await fetchNews();
    const sentNews = await getSentNews(chatId);

    for (const { title, link } of newsList) {
        if (!sentNews.includes(link)) {
            const newsContent = await fetchNewsDetails(link);
            const message = `<b>${title}</b>\n\n${newsContent}\n\n<a href="${link}">Читать подробнее</a>`;
            await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });

            // Сохраняем отправленную новость в базе данных
            await saveSentNews(chatId, link);
        }
    }
});

// Запускаем интервал отправки новостей каждые 10 минут
setInterval(sendNewsToAll, 1* 60 * 1000);

console.log('Бот запущен!');
