const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const cheerio = require('cheerio');
const { Client } = require('pg');

const TOKEN = '7384329734:AAFpAGNtarZ7zIZSwpJy0jOIw3onDo0nehw'; // Замените на токен вашего бота
const NEWS_URL = 'https://beshenkovichi.vitebsk-region.gov.by/ru/news_raion/';
const DB_CONFIG = {
    user: 'postgres', // Замените на ваше имя пользователя PostgreSQL
    host: 'localhost', // Или IP-адрес вашего сервера
    database: 'news_bot',
    password: '202030', // Замените на ваш пароль
    port: 5432,
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

// Функция для получения контента новости и изображения
async function fetchNewsDetailsWithImage(link) {
    try {
        const response = await axios.get(link);
        const $ = cheerio.load(response.data);

        const contentBlock = $('.content_left');
        if (!contentBlock.length) return { text: 'Не удалось извлечь текст новости.', imageUrl: null };

        const textBlocks = [];
        const unwantedLines = ['Главная /', 'Новости /', 'Новости района /'];

        // Извлекаем текстовые блоки
        contentBlock.find('div').each((_, element) => {
            const text = $(element).text().trim();
            if (
                text &&
                !unwantedLines.some((line) => text.includes(line)) &&
                !text.includes('(function(w,doc)')
            ) {
                textBlocks.push(text);
            }
        });

        if (textBlocks.length > 1) textBlocks.pop(); // Удаляем последнюю строку

        // Извлечение URL изображения
        const imageUrl = contentBlock.find('img').attr('src');
        return {
            text: textBlocks.join('\n'),
            imageUrl: imageUrl ? `${NEWS_URL}${imageUrl}` : null, // Преобразуем относительный URL в абсолютный
        };
    } catch (error) {
        console.error(`Ошибка при парсинге контента новости: ${error.message}`);
        return { text: 'Ошибка загрузки подробностей.', imageUrl: null };
    }
}

// Функция для сохранения ID чата в базе данных
async function saveChatId(chatId) {
    try {
        await client.query(
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

// Функция отправки новости с изображением
async function sendNewsToChat(chatId, title, newsDetails, link) {
    const { text, imageUrl } = newsDetails;

    if (imageUrl) {
        await bot.sendPhoto(chatId, imageUrl, {
            caption: `<b>${title}</b>\n\n${text}\n\n<a href="${link}">Читать подробнее</a>`,
            parse_mode: 'HTML',
        });
    } else {
        await bot.sendMessage(chatId, `<b>${title}</b>\n\n${text}\n\n<a href="${link}">Читать подробнее</a>`, {
            parse_mode: 'HTML',
        });
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
                const newsDetails = await fetchNewsDetailsWithImage(link);
                await sendNewsToChat(chatId, title, newsDetails, link);

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
    await saveChatId(chatId);
});

// Обработчик команды /news
bot.onText(/\/news/, async (msg) => {
    const chatId = msg.chat.id;
    const newsList = await fetchNews();
    const sentNews = await getSentNews(chatId);

    for (const { title, link } of newsList) {
        if (!sentNews.includes(link)) {
            const newsDetails = await fetchNewsDetailsWithImage(link);
            await sendNewsToChat(chatId, title, newsDetails, link);

            // Сохраняем отправленную новость в базе данных
            await saveSentNews(chatId, link);
        }
    }
});

// Запускаем интервал отправки новостей каждые 10 минут
setInterval(sendNewsToAll, 10 * 60 * 1000);

console.log('Бот запущен!');
