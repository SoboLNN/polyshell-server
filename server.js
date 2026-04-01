const WebSocket = require('ws');
const { Pool } = require('pg');

const PORT = process.env.PORT || 8080;
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function initDatabase() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            phone VARCHAR(20) PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            password VARCHAR(255) NOT NULL,
            avatar VARCHAR(10) DEFAULT '👤',
            status VARCHAR(20) DEFAULT 'онлайн',
            email VARCHAR(255),
            public_key TEXT,
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
        CREATE TABLE IF NOT EXISTS messages (
            id SERIAL PRIMARY KEY,
            from_phone VARCHAR(20) NOT NULL,
            to_phone VARCHAR(20) NOT NULL,
            content TEXT NOT NULL,
            encrypted BOOLEAN DEFAULT true,
            timestamp TIMESTAMP DEFAULT NOW()
        )
    `);
    console.log('✅ База данных инициализирована');
}
initDatabase().catch(console.error);

const clients = new Map();
const wss = new WebSocket.Server({ port: PORT, host: '0.0.0.0' });
console.log(`🚀 Сервер запущен на порту ${PORT}`);

wss.on('connection', (ws) => {
    const clientId = Math.random().toString(36).substr(2, 9);
    let userPhone = null;

    ws.on('message', async (data) => {
        try {
            const msg = JSON.parse(data);
            console.log(`\n📨 [${clientId}] ${msg.type}`);

            // ========== РЕГИСТРАЦИЯ ==========
            if (msg.type === 'register') {
                const { phone, name, password, avatar, email, publicKey } = msg;
                const existing = await pool.query('SELECT phone FROM users WHERE phone = $1', [phone]);
                if (existing.rows.length > 0) {
                    ws.send(JSON.stringify({ type: 'register_error', error: 'Пользователь уже существует' }));
                    return;
                }
                await pool.query(
                    `INSERT INTO users (phone, name, password, avatar, email, public_key, settings)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [phone, name, password, avatar || '👤', email || '', publicKey || '',
                     JSON.stringify({ profileVisibility: 'all', lastSeenVisibility: 'all', soundEnabled: true, vibrationEnabled: true, messagePreview: true, theme: 'system' })]
                );
                ws.send(JSON.stringify({
                    type: 'register_success',
                    user: {
                        phone, name, avatar: avatar || '👤', status: 'онлайн', email: email || '',
                        publicKey: publicKey || '',
                        settings: {
                            profileVisibility: 'all',
                            lastSeenVisibility: 'all',
                            soundEnabled: true,
                            vibrationEnabled: true,
                            messagePreview: true,
                            theme: 'system'
                        }
                    }
                }));
                console.log(`✅ [${clientId}] Зарегистрирован ${phone}`);
                userPhone = phone;
                clients.set(userPhone, ws);
                ws.phone = userPhone;
                ws.id = clientId;
            }

            // ========== ВХОД ==========
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
                await pool.query('UPDATE users SET status = $1, last_seen = NOW() WHERE phone = $2', ['онлайн', phone]);
                userPhone = phone;
                clients.set(userPhone, ws);
                ws.phone = userPhone;
                ws.id = clientId;
                ws.send(JSON.stringify({
                    type: 'login_success',
                    user: {
                        phone: userData.phone,
                        name: userData.name,
                        avatar: userData.avatar,
                        status: 'онлайн',
                        email: userData.email,
                        publicKey: userData.public_key,
                        settings: userData.settings
                    }
                }));
                console.log(`✅ [${clientId}] Вход ${phone}`);
            }

            // ========== ОБНОВЛЕНИЕ ИНФОРМАЦИИ О ПОЛЬЗОВАТЕЛЕ (восстановление после перезагрузки) ==========
            if (msg.type === 'user_info') {
                const phone = msg.phone;
                if (phone) {
                    const users = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
                    if (users.rows.length > 0) {
                        userPhone = phone;
                        clients.set(userPhone, ws);
                        ws.phone = userPhone;
                        ws.id = clientId;
                        // Обновляем статус
                        await pool.query('UPDATE users SET status = $1, last_seen = NOW() WHERE phone = $2', ['онлайн', phone]);
                        console.log(`✅ [${clientId}] Информация о пользователе получена: ${phone}`);
                    } else {
                        console.log(`⚠️ [${clientId}] Неизвестный пользователь: ${phone}`);
                    }
                }
            }

            // ========== УСТАНОВКА ПУБЛИЧНОГО КЛЮЧА ==========
            if (msg.type === 'set_public_key') {
                const phone = msg.from || userPhone;
                if (phone) {
                    await pool.query('UPDATE users SET public_key = $1 WHERE phone = $2', [msg.publicKey, phone]);
                    ws.send(JSON.stringify({ type: 'public_key_saved', success: true }));
                    console.log(`🔑 [${clientId}] Ключ сохранён для ${phone}`);
                }
            }

            // ========== ЗАПРОС ПУБЛИЧНОГО КЛЮЧА ==========
            if (msg.type === 'get_public_key') {
                const result = await pool.query('SELECT public_key FROM users WHERE phone = $1', [msg.targetPhone]);
                const publicKey = result.rows[0]?.public_key || null;
                ws.send(JSON.stringify({ type: 'public_key_response', phone: msg.targetPhone, publicKey }));
            }

            // ========== ПОИСК ПОЛЬЗОВАТЕЛЯ ==========
            if (msg.type === 'find_user') {
                const result = await pool.query('SELECT phone, name, avatar, status FROM users WHERE phone = $1', [msg.phone]);
                if (result.rows.length > 0) {
                    const found = result.rows[0];
                    ws.send(JSON.stringify({
                        type: 'user_found',
                        user: {
                            phone: found.phone,
                            name: found.name,
                            avatar: found.avatar,
                            status: clients.has(found.phone) ? 'онлайн' : 'оффлайн'
                        }
                    }));
                } else {
                    ws.send(JSON.stringify({ type: 'user_not_found', phone: msg.phone }));
                }
            }

            // ========== СОЗДАНИЕ ЧАТА (сохранение контакта) ==========
            if (msg.type === 'create_chat') {
                const from = userPhone;
                const to = msg.to;
                if (from && to && from !== to) {
                    await pool.query('INSERT INTO contacts (user_phone, contact_phone) VALUES ($1, $2) ON CONFLICT DO NOTHING', [from, to]);
                    await pool.query('INSERT INTO contacts (user_phone, contact_phone) VALUES ($1, $2) ON CONFLICT DO NOTHING', [to, from]);
                    console.log(`📝 [${clientId}] Контакт сохранён: ${from} ↔ ${to}`);
                    const recipient = clients.get(to);
                    if (recipient) {
                        recipient.send(JSON.stringify({ type: 'create_chat', from, fromName: from, to }));
                    }
                } else {
                    console.log(`⚠️ [${clientId}] Некорректные данные create_chat: from=${from}, to=${to}`);
                }
            }

            // ========== ПОЛУЧЕНИЕ КОНТАКТОВ ==========
            if (msg.type === 'get_contacts') {
                const result = await pool.query('SELECT contact_phone FROM contacts WHERE user_phone = $1', [userPhone]);
                const contacts = result.rows.map(row => row.contact_phone);
                ws.send(JSON.stringify({ type: 'contacts_list', contacts }));
                console.log(`📋 [${clientId}] Отправлены контакты: ${contacts.join(', ')}`);
            }

            // ========== ИСТОРИЯ СООБЩЕНИЙ ==========
            if (msg.type === 'get_messages') {
                const result = await pool.query(
                    `SELECT from_phone, to_phone, content, encrypted, timestamp
                     FROM messages
                     WHERE from_phone = $1 OR to_phone = $1
                     ORDER BY timestamp ASC`,
                    [userPhone]
                );
                ws.send(JSON.stringify({ type: 'messages_history', messages: result.rows }));
            }

            // ========== ОТПРАВКА СООБЩЕНИЯ ==========
            if (msg.type === 'chat_message') {
                const { from, fromName, to, content, encrypted, timestamp } = msg;
                await pool.query(
                    `INSERT INTO messages (from_phone, to_phone, content, encrypted, timestamp)
                     VALUES ($1, $2, $3, $4, $5)`,
                    [from, to, content, encrypted, timestamp || new Date().toISOString()]
                );
                const recipient = clients.get(to);
                if (recipient) {
                    recipient.send(JSON.stringify({ type: 'chat_message', from, fromName, content, encrypted, timestamp }));
                    console.log(`✅ [${clientId}] Сообщение доставлено ${to}`);
                } else {
                    console.log(`❌ [${clientId}] Получатель оффлайн`);
                }
            }

            // ========== ОБНОВЛЕНИЕ ПРОФИЛЯ ==========
            if (msg.type === 'update_profile') {
                const { user } = msg;
                if (user && user.phone) {
                    const fields = [];
                    const values = [];
                    let idx = 1;
                    if (user.name) { fields.push(`name = $${idx++}`); values.push(user.name); }
                    if (user.avatar) { fields.push(`avatar = $${idx++}`); values.push(user.avatar); }
                    if (user.status) { fields.push(`status = $${idx++}`); values.push(user.status); }
                    if (user.email) { fields.push(`email = $${idx++}`); values.push(user.email); }
                    if (user.settings) { fields.push(`settings = $${idx++}`); values.push(JSON.stringify(user.settings)); }
                    if (fields.length > 0) {
                        values.push(user.phone);
                        await pool.query(`UPDATE users SET ${fields.join(', ')} WHERE phone = $${idx}`, values);
                        console.log(`✅ [${clientId}] Профиль обновлён ${user.phone}`);
                    }
                }
            }

            // ========== ПОЛУЧЕНИЕ ПРОФИЛЯ ==========
            if (msg.type === 'get_profile') {
                const phone = msg.phone || userPhone;
                const result = await pool.query('SELECT phone, name, avatar, status, email, public_key, settings FROM users WHERE phone = $1', [phone]);
                if (result.rows.length > 0) {
                    ws.send(JSON.stringify({ type: 'profile_data', user: result.rows[0] }));
                } else {
                    ws.send(JSON.stringify({ type: 'profile_error', error: 'Пользователь не найден' }));
                }
            }

            // ========== ИНДИКАТОР НАБОРА ==========
            if (msg.type === 'typing') {
                const recipient = clients.get(msg.to);
                if (recipient) recipient.send(JSON.stringify({ type: 'typing', from: msg.from }));
            }

            // ========== WEBRTC СИГНАЛИНГ ==========
            if (['offer', 'answer', 'ice-candidate'].includes(msg.type)) {
                const recipient = clients.get(msg.to);
                if (recipient) {
                    recipient.send(JSON.stringify({
                        type: msg.type,
                        offer: msg.offer,
                        answer: msg.answer,
                        candidate: msg.candidate,
                        from: msg.from
                    }));
                }
            }

            if (msg.type === 'call_ended') {
                const recipient = clients.get(msg.to);
                if (recipient) recipient.send(JSON.stringify({ type: 'call_ended', from: msg.from }));
            }

            if (msg.type === 'change_password') {
                await pool.query('UPDATE users SET password = $1 WHERE phone = $2', [msg.newPassword, msg.phone]);
                ws.send(JSON.stringify({ type: 'password_changed', success: true }));
            }

        } catch (err) {
            console.error(`❌ [${clientId}] Ошибка:`, err);
            ws.send(JSON.stringify({ type: 'error', error: err.message }));
        }
    });

    ws.on('close', () => {
        console.log(`🔴 [${clientId}] Отключился`);
        if (userPhone) {
            clients.delete(userPhone);
            pool.query('UPDATE users SET status = $1 WHERE phone = $2', ['оффлайн', userPhone]).catch(console.error);
        }
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