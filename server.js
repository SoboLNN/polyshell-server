const WebSocket = require('ws');
const { Pool } = require('pg');
const crypto = require('crypto');
const http = require('http');

const PORT = process.env.PORT || 8080;
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

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
    // Контакты (для личных чатов)
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
    // Сообщения (поддерживают и личные, и групповые)
    await pool.query(`
        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            from_phone VARCHAR(20) NOT NULL,
            to_phone VARCHAR(20),
            group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,
            content TEXT NOT NULL,
            encrypted BOOLEAN DEFAULT false,
            is_file BOOLEAN DEFAULT false,
            is_voice BOOLEAN DEFAULT false,
            file_name TEXT,
            file_size BIGINT,
            file_type TEXT,
            timestamp TIMESTAMP DEFAULT NOW(),
            CONSTRAINT target_check CHECK (
                (to_phone IS NOT NULL AND group_id IS NULL) OR
                (to_phone IS NULL AND group_id IS NOT NULL)
            )
        )
    `);
    // Статусы доставки и прочтения для личных сообщений (можно расширить)
    await pool.query(`
        CREATE TABLE IF NOT EXISTS message_status (
            message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
            user_phone VARCHAR(20) NOT NULL,
            delivered BOOLEAN DEFAULT false,
            read BOOLEAN DEFAULT false,
            updated_at TIMESTAMP DEFAULT NOW(),
            PRIMARY KEY (message_id, user_phone)
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
    console.log('✅ База данных инициализирована (с группами)');
}
initDatabase().catch(console.error);

const clients = new Map(); // phone -> WebSocket
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
console.log(`🚀 Сервер запущен на порту ${PORT} (HTTP + WS)`);

function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

wss.on('connection', (ws) => {
    const clientId = Math.random().toString(36).substr(2, 9);
    let userPhone = null;

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', async (data) => {
        try {
            const msg = JSON.parse(data);
            console.log(`\n📨 [${clientId}] ${msg.type}`);

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
                console.log(`✅ [${clientId}] Зарегистрирован ${phone}`);
            }

            // ========== ВХОД ПО ПАРОЛЮ ==========
            if (msg.type === 'login') {
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
                console.log(`✅ [${clientId}] Вход ${phone}, выдан токен ${token}`);
            }

            // ========== ВХОД ПО ТОКЕНУ ==========
            if (msg.type === 'login_with_token') {
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
                console.log(`✅ [${clientId}] Автовход по токену ${token} для ${phone}`);
            }

            // ========== ИНФОРМАЦИЯ О ПОЛЬЗОВАТЕЛЕ ==========
            if (msg.type === 'user_info') {
                const phone = msg.phone;
                if (phone) {
                    const user = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
                    if (user.rows.length > 0) {
                        userPhone = phone;
                        clients.set(userPhone, ws);
                        ws.phone = userPhone;
                        await pool.query('UPDATE users SET status = $1, last_seen = NOW() WHERE phone = $2', ['онлайн', phone]);
                        ws.send(JSON.stringify({ type: 'user_info_ack', success: true }));
                    }
                }
            }

            // ========== ПОИСК ПОЛЬЗОВАТЕЛЯ ==========
            if (msg.type === 'find_user') {
                const result = await pool.query('SELECT phone, name, avatar, status, last_seen FROM users WHERE phone = $1', [msg.phone]);
                if (result.rows.length > 0) {
                    ws.send(JSON.stringify({ type: 'user_found', user: result.rows[0] }));
                } else {
                    ws.send(JSON.stringify({ type: 'user_not_found' }));
                }
            }

            // ========== СОЗДАНИЕ ЛИЧНОГО ЧАТА (КОНТАКТ) ==========
            if (msg.type === 'create_chat') {
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
                    console.log(`📝 [${clientId}] Контакт сохранён: ${from} ↔ ${to}`);
                }
                const recipient = clients.get(to);
                if (recipient) {
                    recipient.send(JSON.stringify({ type: 'create_chat', from, fromName: from, to }));
                }
                ws.send(JSON.stringify({ type: 'chat_created', success: true }));
            }

            // ========== СОЗДАНИЕ ГРУППЫ ==========
            if (msg.type === 'create_group') {
                const { name, avatar, members } = msg; // members: массив телефонов
                if (!name || !members || !Array.isArray(members) || members.length === 0) {
                    ws.send(JSON.stringify({ type: 'error', error: 'Название и участники обязательны' }));
                    return;
                }
                const groupId = generateId();
                await pool.query('INSERT INTO groups (id, name, avatar, created_by) VALUES ($1, $2, $3, $4)',
                    [groupId, name, avatar || '👥', userPhone]);
                // Добавляем создателя и участников
                const allMembers = [...new Set([userPhone, ...members])];
                for (const member of allMembers) {
                    await pool.query('INSERT INTO group_members (group_id, user_phone, role) VALUES ($1, $2, $3)',
                        [groupId, member, member === userPhone ? 'admin' : 'member']);
                }
                // Оповещаем онлайн-участников
                const group = { id: groupId, name, avatar: avatar || '👥', type: 'group' };
                for (const member of allMembers) {
                    const client = clients.get(member);
                    if (client) {
                        client.send(JSON.stringify({ type: 'group_created', group }));
                    }
                }
                ws.send(JSON.stringify({ type: 'group_created', group }));
            }

            // ========== ПОЛУЧЕНИЕ СПИСКА ЧАТОВ (КОНТАКТЫ + ГРУППЫ) ==========
            if (msg.type === 'get_contacts') {
                if (!userPhone) {
                    ws.send(JSON.stringify({ type: 'error', error: 'Не авторизован' }));
                    return;
                }
                // Личные контакты
                const contactsRes = await pool.query('SELECT contact_phone FROM contacts WHERE user_phone = $1', [userPhone]);
                const contacts = contactsRes.rows.map(r => r.contact_phone);
                // Группы, в которых состоит пользователь
                const groupsRes = await pool.query(`
                    SELECT g.id, g.name, g.avatar
                    FROM groups g
                    JOIN group_members gm ON g.id = gm.group_id
                    WHERE gm.user_phone = $1
                `, [userPhone]);
                const groups = groupsRes.rows.map(g => ({ ...g, type: 'group' }));
                ws.send(JSON.stringify({ type: 'contacts_list', contacts, groups }));
            }

            // ========== ПОЛУЧЕНИЕ ИСТОРИИ СООБЩЕНИЙ (ЛИЧНЫЕ + ГРУППОВЫЕ) ==========
            if (msg.type === 'get_messages') {
                if (!userPhone) {
                    ws.send(JSON.stringify({ type: 'error', error: 'Не авторизован' }));
                    return;
                }
                // Личные сообщения
                const personalRes = await pool.query(
                    `SELECT id, from_phone, to_phone, NULL as group_id, content, encrypted, is_file, is_voice, file_name, file_size, file_type, timestamp
                     FROM messages
                     WHERE from_phone = $1 OR to_phone = $1`,
                    [userPhone]
                );
                // Групповые сообщения (пользователь состоит в группе)
                const groupRes = await pool.query(
                    `SELECT m.id, m.from_phone, NULL as to_phone, m.group_id, m.content, m.encrypted, m.is_file, m.is_voice, m.file_name, m.file_size, m.file_type, m.timestamp
                     FROM messages m
                     JOIN group_members gm ON m.group_id = gm.group_id
                     WHERE gm.user_phone = $1`,
                    [userPhone]
                );
                const allMessages = [...personalRes.rows, ...groupRes.rows];
                // Получаем статусы доставки/прочтения для личных сообщений
                // (для групповых пока упрощённо: не храним индивидуальные статусы)
                ws.send(JSON.stringify({ type: 'messages_history', messages: allMessages }));
            }

            // ========== ОТПРАВКА СООБЩЕНИЯ ==========
            if (msg.type === 'chat_message') {
                const { id, from, fromName, to, groupId, content, timestamp, isFile, isVoice, fileName, fileSize, fileType } = msg;
                if (!from || (!to && !groupId)) {
                    ws.send(JSON.stringify({ type: 'error', error: 'Отправитель и получатель/группа обязательны' }));
                    return;
                }
                if (from !== userPhone) {
                    ws.send(JSON.stringify({ type: 'error', error: 'Нельзя отправить сообщение от чужого имени' }));
                    return;
                }
                // Проверяем, что получатель существует или группа существует и пользователь в ней
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
                    `INSERT INTO messages (id, from_phone, to_phone, group_id, content, encrypted, is_file, is_voice, file_name, file_size, file_type, timestamp)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
                    [id, from, to || null, groupId || null, content, false, isFile || false, isVoice || false, fileName, fileSize, fileType, timestamp || new Date().toISOString()]
                );

                // Рассылка
                if (to) {
                    const recipientWs = clients.get(to);
                    if (recipientWs) {
                        recipientWs.send(JSON.stringify({
                            type: 'chat_message',
                            id, from, fromName, to, content, encrypted: false, timestamp,
                            isFile: isFile || false, isVoice: isVoice || false,
                            fileName, fileSize, fileType
                        }));
                    }
                    // Подтверждение отправителю
                    ws.send(JSON.stringify({ type: 'message_delivered', messageId: id, to }));
                } else if (groupId) {
                    // Получаем всех участников группы
                    const membersRes = await pool.query('SELECT user_phone FROM group_members WHERE group_id = $1', [groupId]);
                    for (const member of membersRes.rows) {
                        if (member.user_phone === from) continue;
                        const memberWs = clients.get(member.user_phone);
                        if (memberWs) {
                            memberWs.send(JSON.stringify({
                                type: 'chat_message',
                                id, from, fromName, groupId, content, encrypted: false, timestamp,
                                isFile: isFile || false, isVoice: isVoice || false,
                                fileName, fileSize, fileType
                            }));
                        }
                    }
                    // Для групповых сообщений пока не шлём delivered индивидуально (можно позже)
                }
                console.log(`✅ Сообщение ${id} от ${from}`);
            }

            // ========== ПОДТВЕРЖДЕНИЕ ПРОЧТЕНИЯ (ТОЛЬКО ДЛЯ ЛИЧНЫХ) ==========
            if (msg.type === 'read_receipt') {
                const { messageIds, from, to } = msg;
                if (!from || !to || !messageIds) return;
                if (from !== userPhone) {
                    ws.send(JSON.stringify({ type: 'error', error: 'Недостаточно прав' }));
                    return;
                }
                const sender = clients.get(to);
                if (sender) {
                    sender.send(JSON.stringify({ type: 'message_read', messageIds, from }));
                }
            }

            // ========== ОБНОВЛЕНИЕ ПРОФИЛЯ ==========
            if (msg.type === 'update_profile') {
                const { user } = msg;
                if (!user || !user.phone) return;
                if (user.phone !== userPhone) {
                    ws.send(JSON.stringify({ type: 'error', error: 'Нельзя редактировать чужой профиль' }));
                    return;
                }
                const fields = [];
                const values = [];
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

            // ========== ПОЛУЧЕНИЕ ПРОФИЛЯ ==========
            if (msg.type === 'get_profile') {
                const phone = msg.phone || userPhone;
                if (!phone) return;
                const result = await pool.query('SELECT phone, name, avatar, status, email, settings, last_seen FROM users WHERE phone = $1', [phone]);
                if (result.rows.length > 0) {
                    ws.send(JSON.stringify({ type: 'profile_data', user: result.rows[0] }));
                } else {
                    ws.send(JSON.stringify({ type: 'profile_error', error: 'Пользователь не найден' }));
                }
            }

            // ========== ПОЛУЧЕНИЕ ИНФОРМАЦИИ О ГРУППЕ ==========
            if (msg.type === 'get_group_info') {
                const { groupId } = msg;
                const groupRes = await pool.query('SELECT id, name, avatar FROM groups WHERE id = $1', [groupId]);
                if (groupRes.rows.length === 0) {
                    ws.send(JSON.stringify({ type: 'error', error: 'Группа не найдена' }));
                    return;
                }
                const membersRes = await pool.query(`
                    SELECT u.phone, u.name, u.avatar, gm.role
                    FROM group_members gm
                    JOIN users u ON gm.user_phone = u.phone
                    WHERE gm.group_id = $1
                `, [groupId]);
                ws.send(JSON.stringify({
                    type: 'group_info',
                    group: groupRes.rows[0],
                    members: membersRes.rows
                }));
            }

            // ========== ИНДИКАТОР НАБОРА ==========
            if (msg.type === 'typing') {
                const recipient = clients.get(msg.to);
                if (recipient) recipient.send(JSON.stringify({ type: 'typing', from: msg.from }));
                // для групп можно рассылать всем участникам, пока опустим
            }

            // ========== WEBRTC СИГНАЛИНГ ==========
            if (['offer', 'answer', 'ice-candidate', 'call_ended'].includes(msg.type)) {
                const recipient = clients.get(msg.to);
                if (recipient) recipient.send(JSON.stringify(msg));
            }

            // ========== СМЕНА ПАРОЛЯ ==========
            if (msg.type === 'change_password') {
                if (!userPhone || msg.phone !== userPhone) {
                    ws.send(JSON.stringify({ type: 'error', error: 'Недостаточно прав' }));
                    return;
                }
                await pool.query('UPDATE users SET password = $1 WHERE phone = $2', [msg.newPassword, msg.phone]);
                ws.send(JSON.stringify({ type: 'password_changed' }));
            }

            // ========== ВЫХОД ==========
            if (msg.type === 'logout') {
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

setInterval(() => {
    wss.clients.forEach(ws => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);