const WebSocket = require('ws');
const { Pool } = require('pg');
const crypto = require('crypto');
const http = require('http');
const axios = require('axios');
const { GoogleAuth } = require('google-auth-library');

// ========== ПЕРЕМЕННЫЕ ОКРУЖЕНИЯ ==========
const PORT = process.env.PORT || 8080;
const DATABASE_URL = process.env.DATABASE_URL;
const FCM_PROJECT_ID = process.env.FCM_PROJECT_ID;
const FCM_CLIENT_EMAIL = process.env.FCM_CLIENT_EMAIL;
const FCM_PRIVATE_KEY = process.env.FCM_PRIVATE_KEY?.replace(/\\n/g, '\n');

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

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
    query_timeout: 15000,
});

// ========== ИНИЦИАЛИЗАЦИЯ БАЗЫ ДАННЫХ ==========
async function initDatabase() {
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
    await pool.query(`
        CREATE TABLE IF NOT EXISTS contacts (
            user_phone VARCHAR(20) NOT NULL,
            contact_phone VARCHAR(20) NOT NULL,
            created_at TIMESTAMP DEFAULT NOW(),
            PRIMARY KEY (user_phone, contact_phone)
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS groups (
            id TEXT PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            avatar VARCHAR(10) DEFAULT '👥',
            created_by VARCHAR(20) NOT NULL REFERENCES users(phone),
            created_at TIMESTAMP DEFAULT NOW()
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS group_members (
            group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
            user_phone VARCHAR(20) NOT NULL REFERENCES users(phone) ON DELETE CASCADE,
            role VARCHAR(20) DEFAULT 'member',
            joined_at TIMESTAMP DEFAULT NOW(),
            PRIMARY KEY (group_id, user_phone)
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            from_phone VARCHAR(20) NOT NULL,
            to_phone VARCHAR(20),
            content TEXT NOT NULL,
            timestamp TIMESTAMP DEFAULT NOW()
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS sessions (
            token VARCHAR(64) PRIMARY KEY,
            phone VARCHAR(20) NOT NULL REFERENCES users(phone) ON DELETE CASCADE,
            created_at TIMESTAMP DEFAULT NOW()
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS pinned_messages (
            chat_id TEXT NOT NULL,
            message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
            pinned_by VARCHAR(20) NOT NULL REFERENCES users(phone),
            pinned_at TIMESTAMP DEFAULT NOW(),
            PRIMARY KEY (chat_id)
        )
    `);

    const addColumnIfNotExists = async (table, column, definition) => {
        try { await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${definition}`); } catch (e) {}
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
    await addColumnIfNotExists('messages', 'replied_to', 'TEXT');
    await addColumnIfNotExists('messages', 'edited', 'BOOLEAN DEFAULT false');
    await addColumnIfNotExists('users', 'fcm_token', 'TEXT');

    try { await pool.query(`ALTER TABLE messages ALTER COLUMN to_phone DROP NOT NULL`); } catch (e) {}
    try {
        await pool.query(`ALTER TABLE messages DROP CONSTRAINT IF EXISTS target_check`);
        await pool.query(`ALTER TABLE messages ADD CONSTRAINT target_check CHECK ((to_phone IS NOT NULL AND group_id IS NULL) OR (to_phone IS NULL AND group_id IS NOT NULL))`);
    } catch (e) {}

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_from_phone ON messages(from_phone)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_to_phone ON messages(to_phone)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_group_id ON messages(group_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_group_members_user_phone ON group_members(user_phone)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_contacts_user_phone ON contacts(user_phone)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_pinned_messages_chat_id ON pinned_messages(chat_id)`);

    console.log('✅ База данных инициализирована');
}
initDatabase().catch(console.error);

const clients = new Map();

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

function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}
function getCanonicalPrivateChatId(phoneA, phoneB) {
    if (!phoneA || !phoneB) return null;
    return [phoneA, phoneB].sort().join('_');
}

async function sendFCMNotification(phone, title, body, data = {}) {
    if (!phone || !googleAuth) return;
    try {
        const userRes = await pool.query('SELECT fcm_token FROM users WHERE phone = $1', [phone]);
        const fcmToken = userRes.rows[0]?.fcm_token;
        if (!fcmToken) return;
        const authClient = await googleAuth.getClient();
        const accessToken = await authClient.getAccessToken();
        const fcmUrl = `https://fcm.googleapis.com/v1/projects/${FCM_PROJECT_ID}/messages:send`;
        const payload = {
            message: {
                token: fcmToken,
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

wss.on('connection', (ws) => {
    const clientId = Math.random().toString(36).substr(2, 9);
    let userPhone = null;

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', async (data) => {
        try {
            const msg = JSON.parse(data);
            console.log(`📨 [${clientId}] ${msg.type}`);

            // ========== РЕГИСТРАЦИЯ / ВХОД / ПРОФИЛЬ / ПОИСК ==========
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
                console.log(`✅ [${clientId}] Зарегистрирован ${phone}`);
            }
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
                console.log(`✅ [${clientId}] Вход ${phone}`);
            }
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
                console.log(`✅ [${clientId}] Автовход ${phone}`);
            }
            else if (msg.type === 'find_user') {
                const result = await pool.query('SELECT phone, name, avatar, status, last_seen FROM users WHERE phone = $1', [msg.phone]);
                if (result.rows.length > 0) {
                    ws.send(JSON.stringify({ type: 'user_found', user: result.rows[0] }));
                } else {
                    ws.send(JSON.stringify({ type: 'user_not_found' }));
                }
            }
            else if (msg.type === 'create_chat') {
                const from = userPhone;
                const to = msg.to;
                if (!from || !to) {
                    ws.send(JSON.stringify({ type: 'error', error: 'Не указан отправитель или получатель' }));
                    return;
                }
                if (from !== to) {
                    const recipientExists = await pool.query('SELECT phone FROM users WHERE phone = $1', [to]);
                    if (recipientExists.rows.length === 0) {
                        ws.send(JSON.stringify({ type: 'error', error: 'Пользователь не найден' }));
                        return;
                    }
                    await pool.query('INSERT INTO contacts (user_phone, contact_phone) VALUES ($1, $2) ON CONFLICT DO NOTHING', [from, to]);
                    await pool.query('INSERT INTO contacts (user_phone, contact_phone) VALUES ($1, $2) ON CONFLICT DO NOTHING', [to, from]);
                }
                const recipient = clients.get(to);
                if (recipient) recipient.send(JSON.stringify({ type: 'create_chat', from, fromName: from, to }));
                ws.send(JSON.stringify({ type: 'chat_created', success: true }));
            }
            else if (msg.type === 'create_group') {
                const { name, avatar, members } = msg;
                if (!name || !members || !Array.isArray(members) || members.length === 0) {
                    ws.send(JSON.stringify({ type: 'error', error: 'Название и участники обязательны' }));
                    return;
                }
                const groupId = generateId();
                await pool.query('INSERT INTO groups (id, name, avatar, created_by) VALUES ($1, $2, $3, $4)',
                    [groupId, name, avatar || '👥', userPhone]);
                const allMembers = [...new Set([userPhone, ...members])];
                for (const member of allMembers) {
                    await pool.query('INSERT INTO group_members (group_id, user_phone, role) VALUES ($1, $2, $3)',
                        [groupId, member, member === userPhone ? 'admin' : 'member']);
                }
                const group = { id: groupId, name, avatar: avatar || '👥', type: 'group' };
                for (const member of allMembers) {
                    const client = clients.get(member);
                    if (client) client.send(JSON.stringify({ type: 'group_created', group }));
                }
                ws.send(JSON.stringify({ type: 'group_created', group }));
            }
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
                const groups = groupsRes.rows;
                ws.send(JSON.stringify({ type: 'contacts_list', contacts, groups }));
            }
            else if (msg.type === 'get_group_members') {
                const { groupId } = msg;
                if (!groupId) return;
                const memberCheck = await pool.query('SELECT 1 FROM group_members WHERE group_id = $1 AND user_phone = $2', [groupId, userPhone]);
                if (memberCheck.rows.length === 0) {
                    ws.send(JSON.stringify({ type: 'error', error: 'Вы не состоите в этой группе' }));
                    return;
                }
                const membersRes = await pool.query(`
                    SELECT gm.user_phone, u.name, u.avatar, u.status, gm.role
                    FROM group_members gm
                    JOIN users u ON gm.user_phone = u.phone
                    WHERE gm.group_id = $1
                    ORDER BY gm.joined_at
                `, [groupId]);
                const members = membersRes.rows;
                ws.send(JSON.stringify({ type: 'group_members_list', groupId, members, memberCount: members.length }));
            }
            // ========== УДАЛЕНИЕ СООБЩЕНИЯ ==========
            else if (msg.type === 'delete_message') {
                const { messageId, from, to, groupId } = msg;
                if (!messageId || !from) {
                    ws.send(JSON.stringify({ type: 'error', error: 'Не указан ID сообщения или отправитель' }));
                    return;
                }
                const msgCheck = await pool.query('SELECT from_phone FROM messages WHERE id = $1', [messageId]);
                if (msgCheck.rows.length === 0 || msgCheck.rows[0].from_phone !== from) {
                    ws.send(JSON.stringify({ type: 'error', error: 'Недостаточно прав для удаления сообщения' }));
                    return;
                }
                await pool.query('DELETE FROM messages WHERE id = $1', [messageId]);
                // Оповещаем участников
                if (to) {
                    const recipientWs = clients.get(to);
                    if (recipientWs) recipientWs.send(JSON.stringify({ type: 'message_deleted', messageId, to }));
                    ws.send(JSON.stringify({ type: 'message_deleted', messageId }));
                } else if (groupId) {
                    const membersRes = await pool.query('SELECT user_phone FROM group_members WHERE group_id = $1', [groupId]);
                    for (const member of membersRes.rows) {
                        const memberWs = clients.get(member.user_phone);
                        if (memberWs) memberWs.send(JSON.stringify({ type: 'message_deleted', messageId, groupId }));
                    }
                }
                console.log(`🗑️ Сообщение ${messageId} удалено`);
            }
            // ========== ОТПРАВКА СООБЩЕНИЯ ==========
            else if (msg.type === 'chat_message') {
                const { id, from, fromName, to, groupId, content, timestamp, isFile, isVoice, fileName, fileSize, fileType, repliedTo } = msg;
                if (!from || (!to && !groupId)) {
                    ws.send(JSON.stringify({ type: 'error', error: 'Отправитель и получатель/группа обязательны' }));
                    return;
                }
                if (from !== userPhone) {
                    ws.send(JSON.stringify({ type: 'error', error: 'Нельзя отправить сообщение от чужого имени' }));
                    return;
                }

                if (to) {
                    const recipientExists = await pool.query('SELECT phone FROM users WHERE phone = $1', [to]);
                    if (recipientExists.rows.length === 0) {
                        ws.send(JSON.stringify({ type: 'error', error: 'Получатель не найден' }));
                        return;
                    }
                } else if (groupId) {
                    const memberCheck = await pool.query('SELECT 1 FROM group_members WHERE group_id = $1 AND user_phone = $2', [groupId, from]);
                    if (memberCheck.rows.length === 0) {
                        ws.send(JSON.stringify({ type: 'error', error: 'Вы не состоите в этой группе' }));
                        return;
                    }
                }

                await pool.query(
                    `INSERT INTO messages (id, from_phone, to_phone, group_id, content, encrypted, is_file, is_voice, file_name, file_size, file_type, timestamp, replied_to)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
                    [id, from, to || null, groupId || null, content, false, isFile || false, isVoice || false, fileName, fileSize, fileType, timestamp || new Date().toISOString(), repliedTo || null]
                );

                if (to) {
                    const recipientWs = clients.get(to);
                    if (recipientWs) {
                        recipientWs.send(JSON.stringify({
                            type: 'chat_message',
                            id, from, fromName, to, content, encrypted: false, timestamp,
                            isFile: isFile || false, isVoice: isVoice || false,
                            fileName, fileSize, fileType, repliedTo
                        }));
                        await pool.query('UPDATE messages SET delivered = true WHERE id = $1', [id]);
                    } else {
                        await sendFCMNotification(to, fromName || from,
                            isVoice ? '🎤 Голосовое' : (isFile ? `📎 ${fileName}` : content), {});
                    }
                    ws.send(JSON.stringify({ type: 'message_delivered', messageId: id, to }));
                } else if (groupId) {
                    const membersRes = await pool.query('SELECT user_phone FROM group_members WHERE group_id = $1', [groupId]);
                    let deliveredCount = 0;
                    for (const member of membersRes.rows) {
                        if (member.user_phone === from) continue;
                        const memberWs = clients.get(member.user_phone);
                        if (memberWs) {
                            memberWs.send(JSON.stringify({
                                type: 'chat_message',
                                id, from, fromName, groupId, content, encrypted: false, timestamp,
                                isFile: isFile || false, isVoice: isVoice || false,
                                fileName, fileSize, fileType, repliedTo
                            }));
                            deliveredCount++;
                        } else {
                            await sendFCMNotification(member.user_phone, fromName || from,
                                isVoice ? '🎤 Голосовое' : (isFile ? `📎 ${fileName}` : content), {});
                        }
                    }
                    if (deliveredCount > 0) await pool.query('UPDATE messages SET delivered = true WHERE id = $1', [id]);
                    ws.send(JSON.stringify({ type: 'message_delivered', messageId: id, groupId }));
                }
                console.log(`✅ Сообщение ${id} от ${from}`);
            }
            // ========== ИСТОРИЯ СООБЩЕНИЙ ==========
            else if (msg.type === 'get_personal_messages') {
                if (!userPhone) return;
                try {
                    const limit = msg.limit || 50;
                    const offset = msg.offset || 0;
                    const result = await pool.query(
                        `SELECT id, from_phone, to_phone, NULL as group_id,
                                content, encrypted, is_file, is_voice,
                                file_name, file_size, file_type,
                                delivered, read, timestamp, replied_to, edited
                         FROM messages
                         WHERE (from_phone = $1 OR to_phone = $1)
                           AND group_id IS NULL
                         ORDER BY timestamp DESC
                         LIMIT $2 OFFSET $3`,
                        [userPhone, limit, offset]
                    );
                    ws.send(JSON.stringify({ type: 'personal_messages_history', messages: result.rows.reverse() }));
                } catch (err) {
                    ws.send(JSON.stringify({ type: 'error', error: 'Ошибка получения сообщений' }));
                }
            }
            else if (msg.type === 'get_group_messages') {
                if (!userPhone) return;
                try {
                    const limit = msg.limit || 50;
                    const offset = msg.offset || 0;
                    const result = await pool.query(
                        `SELECT m.id, m.from_phone, NULL as to_phone, m.group_id,
                                m.content, m.encrypted, m.is_file, m.is_voice,
                                m.file_name, m.file_size, m.file_type,
                                m.delivered, m.read, m.timestamp, m.replied_to, m.edited
                         FROM messages m
                         INNER JOIN group_members gm ON m.group_id = gm.group_id
                         WHERE gm.user_phone = $1
                         ORDER BY m.timestamp DESC
                         LIMIT $2 OFFSET $3`,
                        [userPhone, limit, offset]
                    );
                    ws.send(JSON.stringify({ type: 'group_messages_history', messages: result.rows.reverse() }));
                } catch (err) {
                    ws.send(JSON.stringify({ type: 'error', error: 'Ошибка получения сообщений' }));
                }
            }
            // ========== ЗАКРЕПЛЕНИЯ ==========
            else if (msg.type === 'pin_message') {
                const { messageId, chatId } = msg;
                const clientChatId = chatId;
                if (!messageId || !clientChatId || !userPhone) {
                    ws.send(JSON.stringify({ type: 'error', error: 'Не указаны messageId или chatId' }));
                    return;
                }

                const msgCheck = await pool.query(
                    `SELECT id, from_phone, to_phone, group_id, content, is_file, is_voice,
                            file_name, file_size, file_type, timestamp
                     FROM messages WHERE id = $1`,
                    [messageId]
                );
                if (msgCheck.rows.length === 0) {
                    ws.send(JSON.stringify({ type: 'error', error: 'Сообщение не найдено' }));
                    return;
                }
                const message = msgCheck.rows[0];

                let canonicalChatId;
                let hasAccess = false;

                if (message.group_id) {
                    if (message.group_id !== clientChatId) {
                        ws.send(JSON.stringify({ type: 'error', error: 'chatId не соответствует group_id' }));
                        return;
                    }
                    canonicalChatId = message.group_id;
                    const memberCheck = await pool.query('SELECT 1 FROM group_members WHERE group_id = $1 AND user_phone = $2', [canonicalChatId, userPhone]);
                    hasAccess = memberCheck.rows.length > 0;
                } else {
                    const p1 = message.from_phone, p2 = message.to_phone;
                    if (!p1 || !p2) {
                        ws.send(JSON.stringify({ type: 'error', error: 'Не удалось определить участников' }));
                        return;
                    }
                    canonicalChatId = getCanonicalPrivateChatId(p1, p2);
                    hasAccess = (p1 === userPhone || p2 === userPhone);
                }

                if (!hasAccess) {
                    ws.send(JSON.stringify({ type: 'error', error: 'Нет доступа' }));
                    return;
                }

                await pool.query(
                    `INSERT INTO pinned_messages (chat_id, message_id, pinned_by, pinned_at)
                     VALUES ($1, $2, $3, NOW())
                     ON CONFLICT (chat_id) DO UPDATE SET
                         message_id = EXCLUDED.message_id,
                         pinned_by = EXCLUDED.pinned_by,
                         pinned_at = NOW()`,
                    [canonicalChatId, messageId, userPhone]
                );

                const pinNotification = {
                    type: 'pin_message',
                    chatId: clientChatId,
                    message: {
                        id: message.id,
                        from_phone: message.from_phone,
                        content: message.content,
                        is_file: message.is_file,
                        is_voice: message.is_voice,
                        file_name: message.file_name,
                        file_size: message.file_size,
                        file_type: message.file_type,
                        timestamp: message.timestamp
                    },
                    pinned_by: userPhone
                };

                if (!message.group_id) {
                    const other = message.from_phone === userPhone ? message.to_phone : message.from_phone;
                    const otherWs = clients.get(other);
                    if (otherWs) otherWs.send(JSON.stringify(pinNotification));
                    ws.send(JSON.stringify(pinNotification));
                } else {
                    const membersRes = await pool.query('SELECT user_phone FROM group_members WHERE group_id = $1', [canonicalChatId]);
                    for (const member of membersRes.rows) {
                        const memberWs = clients.get(member.user_phone);
                        if (memberWs) memberWs.send(JSON.stringify(pinNotification));
                    }
                }
                console.log(`📌 Закреплено в ${canonicalChatId}`);
            }
            else if (msg.type === 'unpin_message') {
                const { chatId } = msg;
                const clientChatId = chatId;
                if (!clientChatId || !userPhone) return;

                let canonicalChatId;
                let hasAccess = false;
                const groupCheck = await pool.query('SELECT id FROM groups WHERE id = $1', [clientChatId]);
                if (groupCheck.rows.length > 0) {
                    canonicalChatId = clientChatId;
                    const memberCheck = await pool.query('SELECT 1 FROM group_members WHERE group_id = $1 AND user_phone = $2', [canonicalChatId, userPhone]);
                    hasAccess = memberCheck.rows.length > 0;
                } else {
                    const other = clientChatId;
                    canonicalChatId = getCanonicalPrivateChatId(userPhone, other);
                    const userExists = await pool.query('SELECT phone FROM users WHERE phone = $1', [other]);
                    hasAccess = userExists.rows.length > 0;
                }
                if (!hasAccess) return;

                await pool.query('DELETE FROM pinned_messages WHERE chat_id = $1', [canonicalChatId]);

                const unpinNotification = { type: 'unpin_message', chatId: clientChatId, by: userPhone };
                if (groupCheck.rows.length === 0) {
                    const other = clientChatId;
                    const otherWs = clients.get(other);
                    if (otherWs) otherWs.send(JSON.stringify(unpinNotification));
                    ws.send(JSON.stringify(unpinNotification));
                } else {
                    const membersRes = await pool.query('SELECT user_phone FROM group_members WHERE group_id = $1', [canonicalChatId]);
                    for (const member of membersRes.rows) {
                        const memberWs = clients.get(member.user_phone);
                        if (memberWs) memberWs.send(JSON.stringify(unpinNotification));
                    }
                }
            }
            else if (msg.type === 'get_pinned_message') {
                if (!userPhone) return;
                const clientChatId = msg.chatId;
                if (!clientChatId) return;

                let canonicalChatId;
                let hasAccess = false;
                const groupCheck = await pool.query('SELECT id FROM groups WHERE id = $1', [clientChatId]);
                if (groupCheck.rows.length > 0) {
                    canonicalChatId = clientChatId;
                    const memberCheck = await pool.query('SELECT 1 FROM group_members WHERE group_id = $1 AND user_phone = $2', [canonicalChatId, userPhone]);
                    hasAccess = memberCheck.rows.length > 0;
                } else {
                    const other = clientChatId;
                    canonicalChatId = getCanonicalPrivateChatId(userPhone, other);
                    const userExists = await pool.query('SELECT phone FROM users WHERE phone = $1', [other]);
                    hasAccess = userExists.rows.length > 0;
                }
                if (!hasAccess) return;

                try {
                    const pinnedRes = await pool.query(
                        `SELECT m.id, m.from_phone, m.to_phone, m.group_id, m.content,
                                m.is_file, m.is_voice, m.file_name, m.file_size, m.file_type,
                                m.timestamp, pm.pinned_by, pm.pinned_at
                         FROM pinned_messages pm
                         JOIN messages m ON pm.message_id = m.id
                         WHERE pm.chat_id = $1`,
                        [canonicalChatId]
                    );
                    if (pinnedRes.rows.length > 0) {
                        ws.send(JSON.stringify({ type: 'pinned_message', message: pinnedRes.rows[0], chatId: clientChatId }));
                    } else {
                        ws.send(JSON.stringify({ type: 'pinned_message', message: null, chatId: clientChatId }));
                    }
                } catch (err) {
                    ws.send(JSON.stringify({ type: 'error', error: 'Ошибка получения закреплённого сообщения' }));
                }
            }
            // ========== РЕДАКТИРОВАНИЕ ==========
            else if (msg.type === 'edit_message') {
                const { messageId, newContent, from, to, groupId } = msg;
                if (!messageId || !newContent || !from) return;
                if (from !== userPhone) return;

                const msgCheck = await pool.query('SELECT from_phone FROM messages WHERE id = $1', [messageId]);
                if (msgCheck.rows.length === 0 || msgCheck.rows[0].from_phone !== from) {
                    ws.send(JSON.stringify({ type: 'error', error: 'Недостаточно прав' }));
                    return;
                }
                await pool.query(`UPDATE messages SET content = $1, edited = true WHERE id = $2`, [newContent, messageId]);

                const editedMessage = { type: 'message_edited', messageId, newContent, chatId: groupId || to, from };
                if (to) {
                    const recipientWs = clients.get(to);
                    if (recipientWs) recipientWs.send(JSON.stringify(editedMessage));
                    ws.send(JSON.stringify(editedMessage));
                } else if (groupId) {
                    const membersRes = await pool.query('SELECT user_phone FROM group_members WHERE group_id = $1', [groupId]);
                    for (const member of membersRes.rows) {
                        const memberWs = clients.get(member.user_phone);
                        if (memberWs) memberWs.send(JSON.stringify(editedMessage));
                    }
                }
                console.log(`✏️ Сообщение ${messageId} отредактировано`);
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
                    const sendersRes = await pool.query(
                        'SELECT DISTINCT from_phone FROM messages WHERE id = ANY($1::text[]) AND group_id = $2',
                        [messageIds, groupId]
                    );
                    for (const row of sendersRes.rows) {
                        const senderWs = clients.get(row.from_phone);
                        if (senderWs) senderWs.send(JSON.stringify({ type: 'message_read', messageIds, from }));
                    }
                }
            }
            // ========== УПРАВЛЕНИЕ ГРУППОЙ ==========
            else if (msg.type === 'leave_group') {
                const { groupId } = msg;
                if (!groupId || !userPhone) return;
                await pool.query('DELETE FROM group_members WHERE group_id = $1 AND user_phone = $2', [groupId, userPhone]);
                const remaining = await pool.query('SELECT user_phone FROM group_members WHERE group_id = $1', [groupId]);
                if (remaining.rows.length === 0) {
                    await pool.query('DELETE FROM groups WHERE id = $1', [groupId]);
                    ws.send(JSON.stringify({ type: 'group_deleted', groupId }));
                } else {
                    const groupInfo = await pool.query('SELECT created_by FROM groups WHERE id = $1', [groupId]);
                    if (groupInfo.rows[0].created_by === userPhone) {
                        const newAdmin = remaining.rows[0].user_phone;
                        await pool.query('UPDATE groups SET created_by = $1 WHERE id = $2', [newAdmin, groupId]);
                        await pool.query('UPDATE group_members SET role = $1 WHERE group_id = $2 AND user_phone = $3', ['admin', groupId, newAdmin]);
                    }
                    const notification = { type: 'group_member_removed', groupId, removedMember: userPhone };
                    for (const row of remaining.rows) {
                        const client = clients.get(row.user_phone);
                        if (client) client.send(JSON.stringify(notification));
                    }
                    ws.send(JSON.stringify({ type: 'group_left', groupId }));
                }
                console.log(`🚪 ${userPhone} покинул группу ${groupId}`);
            }
            else if (msg.type === 'add_group_members') {
                const { groupId, members } = msg;
                if (!groupId || !members || !Array.isArray(members)) return;
                const roleCheck = await pool.query('SELECT role FROM group_members WHERE group_id = $1 AND user_phone = $2', [groupId, userPhone]);
                if (roleCheck.rows.length === 0 || roleCheck.rows[0].role !== 'admin') {
                    ws.send(JSON.stringify({ type: 'error', error: 'Недостаточно прав' }));
                    return;
                }
                const added = [];
                for (const phone of members) {
                    try {
                        await pool.query('INSERT INTO group_members (group_id, user_phone, role) VALUES ($1, $2, $3)', [groupId, phone, 'member']);
                        added.push(phone);
                    } catch (e) {}
                }
                if (added.length > 0) {
                    const notification = { type: 'group_members_added', groupId, addedMembers: added };
                    const allMembers = await pool.query('SELECT user_phone FROM group_members WHERE group_id = $1', [groupId]);
                    for (const row of allMembers.rows) {
                        const client = clients.get(row.user_phone);
                        if (client) client.send(JSON.stringify(notification));
                    }
                }
                ws.send(JSON.stringify({ type: 'group_members_added', groupId, addedMembers: added }));
            }
            else if (msg.type === 'remove_group_member') {
                const { groupId, member } = msg;
                if (!groupId || !member) return;
                const roleCheck = await pool.query('SELECT role FROM group_members WHERE group_id = $1 AND user_phone = $2', [groupId, userPhone]);
                if (roleCheck.rows.length === 0 || roleCheck.rows[0].role !== 'admin') {
                    ws.send(JSON.stringify({ type: 'error', error: 'Недостаточно прав' }));
                    return;
                }
                await pool.query('DELETE FROM group_members WHERE group_id = $1 AND user_phone = $2', [groupId, member]);
                const remaining = await pool.query('SELECT user_phone FROM group_members WHERE group_id = $1', [groupId]);
                if (remaining.rows.length === 0) {
                    await pool.query('DELETE FROM groups WHERE id = $1', [groupId]);
                    ws.send(JSON.stringify({ type: 'group_deleted', groupId }));
                } else {
                    const notification = { type: 'group_member_removed', groupId, removedMember: member };
                    for (const row of remaining.rows) {
                        const client = clients.get(row.user_phone);
                        if (client) client.send(JSON.stringify(notification));
                    }
                    const removedClient = clients.get(member);
                    if (removedClient) removedClient.send(JSON.stringify({ type: 'group_left', groupId }));
                    ws.send(JSON.stringify({ type: 'group_member_removed', groupId, removedMember: member }));
                }
            }
            else if (msg.type === 'delete_group') {
                const { groupId } = msg;
                if (!groupId || !userPhone) return;
                const groupCheck = await pool.query('SELECT created_by FROM groups WHERE id = $1', [groupId]);
                if (groupCheck.rows.length === 0) return;
                if (groupCheck.rows[0].created_by !== userPhone) {
                    ws.send(JSON.stringify({ type: 'error', error: 'Только создатель может удалить группу' }));
                    return;
                }
                const membersRes = await pool.query('SELECT user_phone FROM group_members WHERE group_id = $1', [groupId]);
                await pool.query('DELETE FROM groups WHERE id = $1', [groupId]);
                for (const member of membersRes.rows) {
                    const memberWs = clients.get(member.user_phone);
                    if (memberWs) memberWs.send(JSON.stringify({ type: 'group_deleted', groupId }));
                }
                ws.send(JSON.stringify({ type: 'group_deleted', groupId }));
            }
            // ========== УДАЛЕНИЕ ЧАТА ==========
            else if (msg.type === 'delete_chat') {
                const { chatId, with: withPhone } = msg;
                if (!chatId || !userPhone) return;
                await pool.query('DELETE FROM messages WHERE (from_phone = $1 AND to_phone = $2) OR (from_phone = $2 AND to_phone = $1)', [userPhone, withPhone]);
                await pool.query('DELETE FROM contacts WHERE (user_phone = $1 AND contact_phone = $2) OR (user_phone = $2 AND contact_phone = $1)', [userPhone, withPhone]);
                const canonical = getCanonicalPrivateChatId(userPhone, withPhone);
                await pool.query('DELETE FROM pinned_messages WHERE chat_id = $1', [canonical]);
                const otherWs = clients.get(withPhone);
                if (otherWs) otherWs.send(JSON.stringify({ type: 'chat_deleted', chatId: canonical }));
                ws.send(JSON.stringify({ type: 'chat_deleted', chatId: canonical }));
            }
            // ========== WEBRTC / ПРОФИЛЬ / ПАРОЛЬ / ВЫХОД (кратко) ==========
            else if (['offer', 'answer', 'ice-candidate', 'call_ended'].includes(msg.type)) {
                const recipient = clients.get(msg.to);
                if (recipient) recipient.send(JSON.stringify(msg));
                else if (msg.type === 'offer') {
                    await sendFCMNotification(msg.to, 'Входящий звонок', `Звонок от ${msg.fromName || msg.from}`, { type: 'call', from: msg.from });
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
                if (user.settings) { fields.push(`settings = $${idx++}`); values.push(JSON.stringify(user.settings)); }
                if (fields.length) {
                    values.push(user.phone);
                    await pool.query(`UPDATE users SET ${fields.join(', ')} WHERE phone = $${idx}`, values);
                }
            }
            else if (msg.type === 'get_profile') {
                const phone = msg.phone || userPhone;
                const result = await pool.query('SELECT phone, name, avatar, status, email, settings, last_seen FROM users WHERE phone = $1', [phone]);
                if (result.rows.length > 0) ws.send(JSON.stringify({ type: 'profile_data', user: result.rows[0] }));
            }
            else if (msg.type === 'change_password') {
                if (!userPhone || msg.phone !== userPhone) return;
                await pool.query('UPDATE users SET password = $1 WHERE phone = $2', [msg.newPassword, msg.phone]);
                ws.send(JSON.stringify({ type: 'password_changed' }));
            }
            else if (msg.type === 'logout') {
                if (msg.token) await pool.query('DELETE FROM sessions WHERE token = $1', [msg.token]);
                ws.send(JSON.stringify({ type: 'logout_success' }));
            }
            else {
                console.log(`⚠️ Неизвестный тип: ${msg.type}`);
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

setInterval(() => {
    wss.clients.forEach(ws => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);