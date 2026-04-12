const WebSocket = require('ws');
const { Pool } = require('pg');
const crypto = require('crypto');
const http = require('http');
const webpush = require('web-push');
const axios = require('axios');
const { GoogleAuth } = require('google-auth-library');

// ========== ПЕРЕМЕННЫЕ ОКРУЖЕНИЯ ==========
const PORT = process.env.PORT || 8080;
const DATABASE_URL = process.env.DATABASE_URL;
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
const FCM_PROJECT_ID = process.env.FCM_PROJECT_ID;
const FCM_CLIENT_EMAIL = process.env.FCM_CLIENT_EMAIL;
const FCM_PRIVATE_KEY = process.env.FCM_PRIVATE_KEY?.replace(/\\n/g, '\n');

// Настройка web-push
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

// Инициализация GoogleAuth для FCM v1
let googleAuth = null;
if (FCM_CLIENT_EMAIL && FCM_PRIVATE_KEY) {
    googleAuth = new GoogleAuth({
        credentials: {
            client_email: FCM_CLIENT_EMAIL,
            private_key: FCM_PRIVATE_KEY,
        },
        scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
    });
}

// ========== ПОДКЛЮЧЕНИЕ К БАЗЕ ДАННЫХ ==========
const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    // Таймауты для предотвращения зависаний
    connectionTimeoutMillis: 10000,
    query_timeout: 15000,
});

// ========== ИНИЦИАЛИЗАЦИЯ БАЗЫ С ИНДЕКСАМИ ==========
async function initDatabase() {
    // ... (создание таблиц users, contacts, groups, group_members, messages, sessions)
    // Код создания таблиц оставлен без изменений для краткости, но он должен быть как в предыдущих версиях

    // === ИНДЕКСЫ ДЛЯ УСКОРЕНИЯ ЗАПРОСОВ ===
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_from_phone ON messages(from_phone)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_to_phone ON messages(to_phone)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_group_id ON messages(group_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_group_members_user_phone ON group_members(user_phone)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_contacts_user_phone ON contacts(user_phone)`);

    // Миграции (добавление колонок, если их нет) ...
    // (тот же код, что и раньше)

    console.log('✅ База данных инициализирована с индексами');
}
initDatabase().catch(console.error);

// ========== ХРАНИЛИЩЕ ПОДКЛЮЧЕНИЙ ==========
const clients = new Map(); // phone -> WebSocket

// ========== HTTP + WEBSOCKET СЕРВЕР ==========
const wss = new WebSocket.Server({ noServer: true });
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('PolyShell Server OK');
});
server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});
server.listen(PORT, '0.0.0.0');
console.log(`🚀 Сервер запущен на порту ${PORT}`);

// ========== УТИЛИТЫ ==========
function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

// Отправка push-уведомления (Web Push или FCM v1)
async function sendPushNotification(phone, title, body, data = {}) {
    if (!phone) return;
    try {
        const userRes = await pool.query(
            'SELECT push_subscription, fcm_token FROM users WHERE phone = $1',
            [phone]
        );
        const row = userRes.rows[0];
        if (!row) return;

        // Web Push
        if (row.push_subscription) {
            try {
                await webpush.sendNotification(row.push_subscription, JSON.stringify({ title, body, ...data }));
                console.log(`🌐 Web Push отправлен на ${phone}`);
            } catch (err) {
                if (err.statusCode === 410) {
                    await pool.query('UPDATE users SET push_subscription = NULL WHERE phone = $1', [phone]);
                }
                console.error(`❌ Web Push ошибка для ${phone}:`, err.message);
            }
        }

        // FCM v1
        if (row.fcm_token && googleAuth) {
            try {
                const authClient = await googleAuth.getClient();
                const accessToken = await authClient.getAccessToken();
                const fcmUrl = `https://fcm.googleapis.com/v1/projects/${FCM_PROJECT_ID}/messages:send`;
                const payload = {
                    message: {
                        token: row.fcm_token,
                        notification: { title, body },
                        data: data
                    }
                };
                await axios.post(fcmUrl, payload, {
                    headers: {
                        'Authorization': `Bearer ${accessToken.token}`,
                        'Content-Type': 'application/json'
                    }
                });
                console.log(`📱 FCM отправлен на ${phone}`);
            } catch (err) {
                console.error(`❌ FCM ошибка для ${phone}:`, err.response?.data || err.message);
                if (err.response?.status === 404 || err.code === 'messaging/registration-token-not-registered') {
                    await pool.query('UPDATE users SET fcm_token = NULL WHERE phone = $1', [phone]);
                }
            }
        }
    } catch (error) {
        console.error(`❌ Общая ошибка отправки push для ${phone}:`, error);
    }
}

// ========== ОБРАБОТКА ПОДКЛЮЧЕНИЙ ==========
wss.on('connection', (ws) => {
    const clientId = Math.random().toString(36).substr(2, 9);
    let userPhone = null;

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', async (data) => {
        try {
            const msg = JSON.parse(data);
            console.log(`📨 [${clientId}] ${msg.type}`);

            // ========== РЕГИСТРАЦИЯ / ВХОД ==========
            // ... (весь существующий код регистрации, входа, поиска, создания чатов, групп)

            // ========== ОПТИМИЗИРОВАННЫЙ ЗАПРОС ИСТОРИИ ==========
            else if (msg.type === 'get_messages') {
                if (!userPhone) {
                    ws.send(JSON.stringify({ type: 'error', error: 'Не авторизован' }));
                    return;
                }
                try {
                    // Используем UNION ALL вместо двух отдельных запросов для ускорения
                    const result = await pool.query(`
                        (
                            SELECT m.id, m.from_phone, m.to_phone, NULL as group_id,
                                   m.content, m.encrypted, m.is_file, m.is_voice,
                                   m.file_name, m.file_size, m.file_type,
                                   m.delivered, m.read, m.timestamp
                            FROM messages m
                            WHERE m.from_phone = $1 OR m.to_phone = $1
                        )
                        UNION ALL
                        (
                            SELECT m.id, m.from_phone, NULL as to_phone, m.group_id,
                                   m.content, m.encrypted, m.is_file, m.is_voice,
                                   m.file_name, m.file_size, m.file_type,
                                   m.delivered, m.read, m.timestamp
                            FROM messages m
                            INNER JOIN group_members gm ON m.group_id = gm.group_id
                            WHERE gm.user_phone = $1
                        )
                        ORDER BY timestamp ASC
                    `, [userPhone]);

                    ws.send(JSON.stringify({ type: 'messages_history', messages: result.rows }));
                } catch (err) {
                    console.error('Ошибка получения истории:', err);
                    ws.send(JSON.stringify({ type: 'error', error: 'Ошибка получения сообщений: ' + err.message }));
                }
            }

            // ========== ОТПРАВКА СООБЩЕНИЯ ==========
            // ... (существующий код)

            // ========== WEBRTC СИГНАЛИНГ С УЛУЧШЕННОЙ ОБРАБОТКОЙ ==========
            else if (['offer', 'answer', 'ice-candidate', 'call_ended'].includes(msg.type)) {
                const recipient = clients.get(msg.to);
                if (!recipient) {
                    console.log(`⚠️ Получатель ${msg.to} не в сети для ${msg.type}`);
                    // Если это offer, можно отправить push-уведомление о входящем звонке
                    if (msg.type === 'offer') {
                        await sendPushNotification(
                            msg.to,
                            'Входящий звонок',
                            `Звонок от ${msg.fromName || msg.from}`,
                            { type: 'call', from: msg.from }
                        );
                    }
                    return;
                }
                // Пересылаем сигнальное сообщение
                recipient.send(JSON.stringify(msg));
                console.log(`🔄 [${clientId}] Переслано ${msg.type} -> ${msg.to}`);
            }

            // ... (остальные обработчики: профиль, группы, выход)

        } catch (err) {
            console.error(`❌ [${clientId}] Ошибка:`, err);
            ws.send(JSON.stringify({ type: 'error', error: err.message }));
        }
    });

    ws.on('close', async () => {
        if (userPhone) {
            clients.delete(userPhone);
            await pool.query('UPDATE users SET status = $1, last_seen = NOW() WHERE phone = $2', ['оффлайн', userPhone]).catch(console.error);
        }
        console.log(`🔴 [${clientId}] Отключился`);
    });

    ws.on('error', (err) => console.error(`⚠️ [${clientId}] Ошибка сокета:`, err.message));
});

// ========== PING ==========
setInterval(() => {
    wss.clients.forEach(ws => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);