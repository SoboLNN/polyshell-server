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
const FCM_PROJECT_ID = couz-a31a1; // ID проекта Firebase
const FCM_CLIENT_EMAIL = firebase-adminsdk-fbsvc@couz-a31a1.iam.gserviceaccount.com; // email сервисного аккаунта
const FCM_PRIVATE_KEY = -----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDAuqogczoWnvLR\n6snwvA12r3Oyr0q3dhMpkerkdiizOqeMt/OciRnstaSXjvivfhOGf6kjiq5C5eH+\niIOSZhzV3TQ6ADJqxCB8H4ptZXa5x3H4jF3nETwpe5FJC/QennhiEmvUBpbplc1l\n3yz4MbIfweLhF+qt6/LYcZfI+mo6aJzV1YDsHjtC5yq44DeLjoL5RDPid3724Z5/\njVeygl+01xBgWesXlR3olrWkEdO+5Dz1CxMZlnAxsn1E194+WHEZJA8HFJs5V78a\ny29WIz6V2bJjgreTeb9UHJ3etVss3DWgXzFZPNixn/blBjRxAeaS6uhbXyToVF8d\nYsE2LwjpAgMBAAECggEAPYPXBWCB6/Jz4pikOBht27IIpcHZgVFIsH4IkT89omdY\nT0vvj8ka4zje/hj+O1VsegOJQvTixiuFxK5iAHpjPcfLAbBKZ1WOYM/YaS53hLiq\nIgD7f+M6ZqswJjaQhq1iEzt5+0TXKltMIfXn7pg+GHDUL7BokXa8HmWzYsy610U5\ntMIiZxeJp+emZot157fDX1Vxwr66Fe7TIvpWi9YkqEbg+Pv7WAL3dn988g7dtcAi\nkGFjFvSMLe4pAsMNDHKHN+JaXOeTfyqed0Sy6pIuvxVHsfIXjUMSD8KNnaagXs57\nUAA+SfhjQe7MaIEFHP+FQOCXp7yIQZjx2KIevZ7cuQKBgQD9SsYJJBvuSLgymsOc\nNXkXyB6SDeN+h+BpKy3jGy8ycjY/huhqJjgvQDaq5sbB9KDADu5gmFRlRZOuNbc9\nZRui2d8A9BniNtyk+ZY0/SaZILt5yns1FAJwHW+381Gfb4zC4LluRyHxzkHRT1nG\nQy2oaDJEfNUBrvzSA2Muf3HoPwKBgQDCyiNtMUI/qzsOj2pQcrmq142LzJfCyywT\n/rYh9MrWJKZuHN1RmvUC6AbnvlkY7gBSCL86WG+BlCXF6wYZG59/xTXmpss7us/q\n8LrqnKzvQ2Gk9v9Q9x/KJiVtnWeG5s/mS+EEIHCnEuzKtjv9aloNjTd4kPif7iju\nIbV3QRwE1wKBgDoYxIOkPKPTGizBQsy5lyTVSe3GMb/7+oUk2kmVGqY/fCHmF7kB\nOzHbUK6ycDRcn+Jtik+toO35n3395CG45zXbM0NMugMhAkr01Hci+Y916ops3wW1\nqTl+BvnyXW5sb6TjVqTsu+RyorYXtUe8cOSHwb/jwhe4w1SIYl9v6/iRAoGAUQmJ\nfYbtudFB64fMwhVImwO8NnnydS7TcqoYGb5emIJ83viRNr8RyZjALq9pH878QSS0\ncdCS60S4BkQFsHJmg+CG0SN5D6tjjqmCCdMOuye8OsYraAK3rgD6t0Sx6lSiD3xn\n67CXTVq5OohgIsiZGGQ0vKsLVHXff1p0xV1IC9cCgYEAgLCq2n1Re0/gPXKL1rdw\nZHxo0MuNSfcSdCVUxaQmJwrehAau1DCLB8sFgAlHJG9x4omPpw6vl+CUzjxZTUgi\nx7/kVbTYXitSHxSb9bwWzMxaqd8lAg6AtcNAGC6aMuPplfDfes5I7uqkyjmWmvuO\nkPp7+z4cmu/ld0QaVpUTXbc=\n-----END PRIVATE KEY-----\n; // приватный ключ

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
    ssl: { rejectUnauthorized: false } // для Render.com
});

// ========== ИНИЦИАЛИЗАЦИЯ БАЗЫ ==========
async function initDatabase() {
    // Пользователи
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            phone VARCHAR(20) PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            password VARCHAR(255) NOT NULL,
            avatar VARCHAR(10) DEFAULT '👤',
            status VARCHAR(20) DEFAULT 'оффлайн',
            email VARCHAR(255),
            settings JSONB DEFAULT '{"profileVisibility":"all","lastSeenVisibility":"all","soundEnabled":true,"vibrationEnabled":true,"messagePreview":true,"theme":"system"}',
            created_at TIMESTAMP DEFAULT NOW(),
            last_seen TIMESTAMP DEFAULT NOW()
        )
    `);
    // Контакты
    await pool.query(`
        CREATE TABLE IF NOT EXISTS contacts (
            user_phone VARCHAR(20) NOT NULL,
            contact_phone VARCHAR(20) NOT NULL,
            created_at TIMESTAMP DEFAULT NOW(),
            PRIMARY KEY (user_phone, contact_phone)
        )
    `);
    // Группы
    await pool.query(`
        CREATE TABLE IF NOT EXISTS groups (
            id TEXT PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            avatar VARCHAR(10) DEFAULT '👥',
            created_by VARCHAR(20) NOT NULL REFERENCES users(phone),
            created_at TIMESTAMP DEFAULT NOW()
        )
    `);
    // Участники групп
    await pool.query(`
        CREATE TABLE IF NOT EXISTS group_members (
            group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
            user_phone VARCHAR(20) NOT NULL REFERENCES users(phone) ON DELETE CASCADE,
            role VARCHAR(20) DEFAULT 'member',
            joined_at TIMESTAMP DEFAULT NOW(),
            PRIMARY KEY (group_id, user_phone)
        )
    `);
    // Сообщения
    await pool.query(`
        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            from_phone VARCHAR(20) NOT NULL,
            to_phone VARCHAR(20),
            content TEXT NOT NULL,
            timestamp TIMESTAMP DEFAULT NOW()
        )
    `);
    // Сессии
    await pool.query(`
        CREATE TABLE IF NOT EXISTS sessions (
            token VARCHAR(64) PRIMARY KEY,
            phone VARCHAR(20) NOT NULL REFERENCES users(phone) ON DELETE CASCADE,
            created_at TIMESTAMP DEFAULT NOW()
        )
    `);

    // Миграции
    const addColumnIfNotExists = async (table, column, definition) => {
        try {
            await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${definition}`);
        } catch (e) {}
    };
    await addColumnIfNotExists('messages', 'group_id', 'TEXT REFERENCES groups(id) ON DELETE CASCADE');
    await addColumnIfNotExists('messages', 'encrypted', 'BOOLEAN DEFAULT false');
    await addColumnIfNotExists('messages', 'is_file', 'BOOLEAN DEFAULT false');
    await addColumnIfNotExists('messages', 'is_voice', 'BOOLEAN DEFAULT false');
    await addColumnIfNotExists('messages', 'file_name', 'TEXT');
    await addColumnIfNotExists('messages', 'file_size', 'BIGINT');
    await addColumnIfNotExists('messages', 'file_type', 'TEXT');
    await addColumnIfNotExists('messages', 'delivered', 'BOOLEAN DEFAULT false');
    await addColumnIfNotExists('messages', 'read', 'BOOLEAN DEFAULT false');
    await addColumnIfNotExists('users', 'push_subscription', 'JSONB');
    await addColumnIfNotExists('users', 'fcm_token', 'TEXT');

    try {
        await pool.query(`ALTER TABLE messages ALTER COLUMN to_phone DROP NOT NULL`);
    } catch (e) {}
    try {
        await pool.query(`ALTER TABLE messages DROP CONSTRAINT IF EXISTS target_check`);
        await pool.query(`ALTER TABLE messages ADD CONSTRAINT target_check CHECK ((to_phone IS NOT NULL AND group_id IS NULL) OR (to_phone IS NULL AND group_id IS NOT NULL))`);
    } catch (e) {}

    console.log('✅ База данных инициализирована');
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
    const userRes = await pool.query('SELECT push_subscription, fcm_token FROM users WHERE phone = $1', [phone]);
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

            // ========== РЕГИСТРАЦИЯ ==========
            if (msg.type === 'register') {
                const { phone, name, password, avatar, email } = msg;
                const existing = await pool.query('SELECT phone FROM users WHERE phone = $1', [phone]);
                if (existing.rows.length > 0) {
                    ws.send(JSON.stringify({ type: 'register_error', error: 'Пользователь уже существует' }));
                    return;
                }
                await pool.query(
                    `INSERT INTO users (phone, name, password, avatar, email, settings)
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    [phone, name, password, avatar || '👤', email || '',
                     JSON.stringify({ profileVisibility: 'all', lastSeenVisibility: 'all', soundEnabled: true, vibrationEnabled: true, messagePreview: true, theme: 'system' })]
                );
                ws.send(JSON.stringify({
                    type: 'register_success',
                    user: { phone, name, avatar: avatar || '👤', status: 'онлайн', email: email || '' }
                }));
                userPhone = phone;
                clients.set(userPhone, ws);
                ws.phone = userPhone;
                await pool.query('UPDATE users SET status = $1, last_seen = NOW() WHERE phone = $2', ['онлайн', phone]);
                console.log(`✅ Зарегистрирован ${phone}`);
            }

            // ========== ВХОД ==========
            else if (msg.type === 'login') {
                const { phone, password } = msg;
                const user = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
                if (user.rows.length === 0) {
                    ws.send(JSON.stringify({ type: 'login_error', error: 'Аккаунт не найден' }));
                    return;
                }
                const userData = user.rows[0];
                if (userData.password !== password) {
                    ws.send(JSON.stringify({ type: 'login_error', error: 'Неверный пароль' }));
                    return;
                }
                const token = generateToken();
                await pool.query('INSERT INTO sessions (token, phone) VALUES ($1, $2)', [token, phone]);
                await pool.query('UPDATE users SET status = $1, last_seen = NOW() WHERE phone = $2', ['онлайн', phone]);
                userPhone = phone;
                clients.set(userPhone, ws);
                ws.phone = userPhone;
                ws.send(JSON.stringify({
                    type: 'login_success',
                    token,
                    user: {
                        phone: userData.phone, name: userData.name, avatar: userData.avatar,
                        status: 'онлайн', email: userData.email, settings: userData.settings
                    }
                }));
                console.log(`✅ Вход ${phone}`);
            }

            // ========== ВХОД ПО ТОКЕНУ ==========
            else if (msg.type === 'login_with_token') {
                const { token } = msg;
                const session = await pool.query('SELECT phone FROM sessions WHERE token = $1', [token]);
                if (session.rows.length === 0) {
                    ws.send(JSON.stringify({ type: 'login_error', error: 'Недействительный токен' }));
                    return;
                }
                const phone = session.rows[0].phone;
                const user = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
                if (user.rows.length === 0) {
                    ws.send(JSON.stringify({ type: 'login_error', error: 'Пользователь не найден' }));
                    return;
                }
                const userData = user.rows[0];
                await pool.query('UPDATE users SET status = $1, last_seen = NOW() WHERE phone = $2', ['онлайн', phone]);
                userPhone = phone;
                clients.set(userPhone, ws);
                ws.phone = userPhone;
                ws.send(JSON.stringify({
                    type: 'login_success',
                    token,
                    user: {
                        phone: userData.phone, name: userData.name, avatar: userData.avatar,
                        status: 'онлайн', email: userData.email, settings: userData.settings
                    }
                }));
                console.log(`✅ Автовход ${phone}`);
            }

            // ========== PUSH ПОДПИСКА ==========
            else if (msg.type === 'push_subscribe') {
                if (!userPhone) return;
                const { subscription, token, platform } = msg;
                if (platform === 'web' && subscription) {
                    await pool.query('UPDATE users SET push_subscription = $1 WHERE phone = $2', [subscription, userPhone]);
                    console.log(`🌐 Web Push подписка для ${userPhone}`);
                } else if (platform === 'android' && token) {
                    await pool.query('UPDATE users SET fcm_token = $1 WHERE phone = $2', [token, userPhone]);
                    console.log(`📱 FCM токен сохранён для ${userPhone}`);
                }
            }

            // ========== ПОИСК ПОЛЬЗОВАТЕЛЯ ==========
            else if (msg.type === 'find_user') {
                const result = await pool.query('SELECT phone, name, avatar, status, last_seen FROM users WHERE phone = $1', [msg.phone]);
                if (result.rows.length > 0) {
                    ws.send(JSON.stringify({ type: 'user_found', user: result.rows[0] }));
                } else {
                    ws.send(JSON.stringify({ type: 'user_not_found' }));
                }
            }

            // ========== СОЗДАНИЕ ЧАТА ==========
            else if (msg.type === 'create_chat') {
                const from = userPhone;
                const to = msg.to;
                if (!from || !to) return;
                if (from !== to) {
                    await pool.query('INSERT INTO contacts (user_phone, contact_phone) VALUES ($1, $2) ON CONFLICT DO NOTHING', [from, to]);
                    await pool.query('INSERT INTO contacts (user_phone, contact_phone) VALUES ($1, $2) ON CONFLICT DO NOTHING', [to, from]);
                }
                ws.send(JSON.stringify({ type: 'chat_created', success: true }));
            }

            // ========== СОЗДАНИЕ ГРУППЫ ==========
            else if (msg.type === 'create_group') {
                const { name, avatar, members } = msg;
                if (!name || !members?.length) return;
                const groupId = generateId();
                await pool.query('INSERT INTO groups (id, name, avatar, created_by) VALUES ($1, $2, $3, $4)',
                    [groupId, name, avatar || '👥', userPhone]);
                const allMembers = [...new Set([userPhone, ...members])];
                for (const m of allMembers) {
                    await pool.query('INSERT INTO group_members (group_id, user_phone, role) VALUES ($1, $2, $3)',
                        [groupId, m, m === userPhone ? 'admin' : 'member']);
                }
                const group = { id: groupId, name, avatar: avatar || '👥' };
                for (const m of allMembers) {
                    const client = clients.get(m);
                    if (client) client.send(JSON.stringify({ type: 'group_created', group }));
                }
                ws.send(JSON.stringify({ type: 'group_created', group }));
            }

            // ========== ПОЛУЧЕНИЕ КОНТАКТОВ ==========
            else if (msg.type === 'get_contacts') {
                if (!userPhone) return;
                const contactsRes = await pool.query('SELECT contact_phone FROM contacts WHERE user_phone = $1', [userPhone]);
                const contacts = contactsRes.rows.map(r => r.contact_phone);
                const groupsRes = await pool.query(`
                    SELECT g.id, g.name, g.avatar
                    FROM groups g
                    JOIN group_members gm ON g.id = gm.group_id
                    WHERE gm.user_phone = $1
                `, [userPhone]);
                ws.send(JSON.stringify({ type: 'contacts_list', contacts, groups: groupsRes.rows }));
            }

            // ========== ИСТОРИЯ СООБЩЕНИЙ ==========
            else if (msg.type === 'get_messages') {
                if (!userPhone) return;
                const personal = await pool.query(
                    `SELECT id, from_phone, to_phone, NULL as group_id, content, encrypted, is_file, is_voice, file_name, file_size, file_type, delivered, read, timestamp
                     FROM messages WHERE from_phone = $1 OR to_phone = $1`, [userPhone]);
                const group = await pool.query(
                    `SELECT m.id, m.from_phone, NULL as to_phone, m.group_id, m.content, m.encrypted, m.is_file, m.is_voice, m.file_name, m.file_size, m.file_type, m.delivered, m.read, m.timestamp
                     FROM messages m JOIN group_members gm ON m.group_id = gm.group_id WHERE gm.user_phone = $1`, [userPhone]);
                ws.send(JSON.stringify({ type: 'messages_history', messages: [...personal.rows, ...group.rows] }));
            }

            // ========== ОТПРАВКА СООБЩЕНИЯ ==========
            else if (msg.type === 'chat_message') {
                const { id, from, fromName, to, groupId, content, timestamp, isFile, isVoice, fileName, fileSize, fileType } = msg;
                if (!from || (!to && !groupId)) return;
                if (from !== userPhone) return;

                if (to) {
                    const exists = await pool.query('SELECT phone FROM users WHERE phone = $1', [to]);
                    if (exists.rows.length === 0) return;
                } else if (groupId) {
                    const member = await pool.query('SELECT 1 FROM group_members WHERE group_id = $1 AND user_phone = $2', [groupId, from]);
                    if (member.rows.length === 0) return;
                }

                await pool.query(
                    `INSERT INTO messages (id, from_phone, to_phone, group_id, content, encrypted, is_file, is_voice, file_name, file_size, file_type, timestamp)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
                    [id, from, to || null, groupId || null, content, false, isFile || false, isVoice || false, fileName, fileSize, fileType, timestamp || new Date().toISOString()]
                );

                // Рассылка WebSocket
                if (to) {
                    const recipientWs = clients.get(to);
                    if (recipientWs) {
                        recipientWs.send(JSON.stringify(msg));
                        await pool.query('UPDATE messages SET delivered = true WHERE id = $1', [id]);
                    } else {
                        // Отправляем push, если получатель офлайн
                        await sendPushNotification(to, fromName || from,
                            isVoice ? '🎤 Голосовое' : (isFile ? `📎 ${fileName}` : content), {});
                    }
                    ws.send(JSON.stringify({ type: 'message_delivered', messageId: id, to }));
                } else if (groupId) {
                    const members = await pool.query('SELECT user_phone FROM group_members WHERE group_id = $1', [groupId]);
                    let delivered = false;
                    for (const m of members.rows) {
                        if (m.user_phone === from) continue;
                        const memberWs = clients.get(m.user_phone);
                        if (memberWs) {
                            memberWs.send(JSON.stringify(msg));
                            delivered = true;
                        } else {
                            await sendPushNotification(m.user_phone, fromName || from,
                                isVoice ? '🎤 Голосовое' : (isFile ? `📎 ${fileName}` : content), {});
                        }
                    }
                    if (delivered) await pool.query('UPDATE messages SET delivered = true WHERE id = $1', [id]);
                    ws.send(JSON.stringify({ type: 'message_delivered', messageId: id, groupId }));
                }
                console.log(`✅ Сообщение ${id}`);
            }

            // ========== ПРОЧТЕНИЕ ==========
            else if (msg.type === 'read_receipt') {
                const { messageIds, from, to, groupId } = msg;
                if (!from || (!to && !groupId) || !messageIds) return;
                if (from !== userPhone) return;
                await pool.query('UPDATE messages SET read = true WHERE id = ANY($1::text[])', [messageIds]);
                if (to) {
                    const sender = clients.get(to);
                    if (sender) sender.send(JSON.stringify({ type: 'message_read', messageIds, from }));
                } else if (groupId) {
                    const senders = await pool.query('SELECT DISTINCT from_phone FROM messages WHERE id = ANY($1::text[]) AND group_id = $2', [messageIds, groupId]);
                    for (const s of senders.rows) {
                        const senderWs = clients.get(s.from_phone);
                        if (senderWs) senderWs.send(JSON.stringify({ type: 'message_read', messageIds, from }));
                    }
                }
            }

            // ========== ПРОФИЛЬ ==========
            else if (msg.type === 'get_profile') {
                const phone = msg.phone || userPhone;
                const result = await pool.query('SELECT phone, name, avatar, status, email, settings, last_seen FROM users WHERE phone = $1', [phone]);
                if (result.rows.length > 0) {
                    ws.send(JSON.stringify({ type: 'profile_data', user: result.rows[0] }));
                }
            }

            else if (msg.type === 'update_profile') {
                const { user } = msg;
                if (!user || user.phone !== userPhone) return;
                const fields = [], values = [];
                let idx = 1;
                if (user.name) { fields.push(`name = $${idx++}`); values.push(user.name); }
                if (user.avatar) { fields.push(`avatar = $${idx++}`); values.push(user.avatar); }
                if (user.status) { fields.push(`status = $${idx++}`); values.push(user.status); }
                if (user.email) { fields.push(`email = $${idx++}`); values.push(user.email); }
                if (user.settings) { fields.push(`settings = $${idx++}`); values.push(user.settings); }
                if (fields.length) {
                    values.push(userPhone);
                    await pool.query(`UPDATE users SET ${fields.join(', ')} WHERE phone = $${idx}`, values);
                }
            }

            // ========== WEBRTC СИГНАЛИНГ ==========
            else if (['offer', 'answer', 'ice-candidate', 'call_ended'].includes(msg.type)) {
                const recipient = clients.get(msg.to);
                if (recipient) recipient.send(JSON.stringify(msg));
            }

            // ========== СМЕНА ПАРОЛЯ ==========
            else if (msg.type === 'change_password') {
                if (msg.phone !== userPhone) return;
                await pool.query('UPDATE users SET password = $1 WHERE phone = $2', [msg.newPassword, userPhone]);
                ws.send(JSON.stringify({ type: 'password_changed' }));
            }

            // ========== ВЫХОД ==========
            else if (msg.type === 'logout') {
                if (msg.token) await pool.query('DELETE FROM sessions WHERE token = $1', [msg.token]);
                ws.send(JSON.stringify({ type: 'logout_success' }));
            }

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