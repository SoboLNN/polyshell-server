const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const CONTACTS_FILE = path.join(DATA_DIR, 'contacts.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function initFiles() {
    if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '{}');
    if (!fs.existsSync(CONTACTS_FILE)) fs.writeFileSync(CONTACTS_FILE, '{}');
    if (!fs.existsSync(MESSAGES_FILE)) fs.writeFileSync(MESSAGES_FILE, '[]');
}
initFiles();

function readUsers() { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
function writeUsers(data) { fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2)); }
function readContacts() { return JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8')); }
function writeContacts(data) { fs.writeFileSync(CONTACTS_FILE, JSON.stringify(data, null, 2)); }
function readMessages() { return JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8')); }
function writeMessages(data) { fs.writeFileSync(MESSAGES_FILE, JSON.stringify(data, null, 2)); }

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

            // ---------- РЕГИСТРАЦИЯ ----------
            if (msg.type === 'register') {
                const { phone, name, password, avatar, email, publicKey } = msg;
                const users = readUsers();
                if (users[phone]) {
                    ws.send(JSON.stringify({ type: 'register_error', error: 'Пользователь уже существует' }));
                    return;
                }
                users[phone] = {
                    name, phone, password,
                    avatar: avatar || '👤',
                    status: 'онлайн',
                    email: email || '',
                    publicKey: publicKey || '',
                    settings: {
                        profileVisibility: 'all',
                        lastSeenVisibility: 'all',
                        soundEnabled: true,
                        vibrationEnabled: true,
                        messagePreview: true,
                        theme: 'system'
                    },
                    createdAt: new Date().toISOString(),
                    lastSeen: new Date().toISOString()
                };
                writeUsers(users);
                ws.send(JSON.stringify({
                    type: 'register_success',
                    user: {
                        phone, name, avatar: avatar || '👤', status: 'онлайн', email: email || '',
                        publicKey: publicKey || '',
                        settings: users[phone].settings
                    }
                }));
                console.log(`✅ [${clientId}] Зарегистрирован ${phone}`);
            }

            // ---------- ВХОД ----------
            if (msg.type === 'login') {
                const { phone, password } = msg;
                const users = readUsers();
                const user = users[phone];
                if (!user) {
                    ws.send(JSON.stringify({ type: 'login_error', error: 'Аккаунт не найден' }));
                    return;
                }
                if (user.password !== password) {
                    ws.send(JSON.stringify({ type: 'login_error', error: 'Неверный пароль' }));
                    return;
                }
                user.status = 'онлайн';
                user.lastSeen = new Date().toISOString();
                writeUsers(users);
                userPhone = phone;
                clients.set(userPhone, ws);
                ws.phone = userPhone;
                ws.id = clientId;
                ws.send(JSON.stringify({
                    type: 'login_success',
                    user: {
                        phone: user.phone,
                        name: user.name,
                        avatar: user.avatar,
                        status: 'онлайн',
                        email: user.email,
                        publicKey: user.publicKey,
                        settings: user.settings
                    }
                }));
                console.log(`✅ [${clientId}] Вход ${phone}`);
            }

            // ---------- УСТАНОВКА ПУБЛИЧНОГО КЛЮЧА ----------
            if (msg.type === 'set_public_key') {
                const phone = msg.from || userPhone;
                if (phone) {
                    const users = readUsers();
                    if (users[phone]) {
                        users[phone].publicKey = msg.publicKey;
                        writeUsers(users);
                        ws.send(JSON.stringify({ type: 'public_key_saved', success: true }));
                        console.log(`🔑 [${clientId}] Ключ сохранён для ${phone}`);
                    }
                }
            }

            // ---------- ЗАПРОС ПУБЛИЧНОГО КЛЮЧА ----------
            if (msg.type === 'get_public_key') {
                const users = readUsers();
                const publicKey = users[msg.targetPhone]?.publicKey || null;
                ws.send(JSON.stringify({ type: 'public_key_response', phone: msg.targetPhone, publicKey }));
            }

            // ---------- ПОИСК ПОЛЬЗОВАТЕЛЯ ----------
            if (msg.type === 'find_user') {
                const users = readUsers();
                const found = users[msg.phone];
                if (found) {
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

            // ---------- СОЗДАНИЕ ЧАТА (добавление контакта) ----------
            if (msg.type === 'create_chat') {
                const from = userPhone;
                const to = msg.to;
                if (from && to) {
                    const contacts = readContacts();
                    if (!contacts[from]) contacts[from] = [];
                    if (!contacts[from].includes(to)) contacts[from].push(to);
                    if (!contacts[to]) contacts[to] = [];
                    if (!contacts[to].includes(from)) contacts[to].push(from);
                    writeContacts(contacts);
                    console.log(`📝 [${clientId}] Контакт сохранён: ${from} ↔ ${to}`);
                    const recipient = clients.get(to);
                    if (recipient) {
                        recipient.send(JSON.stringify({ type: 'create_chat', from: from, fromName: from, to: to }));
                        console.log(`📨 [${clientId}] Уведомление отправлено получателю ${to}`);
                    }
                }
            }

            // ---------- ПОЛУЧЕНИЕ КОНТАКТОВ ----------
            if (msg.type === 'get_contacts') {
                const contacts = readContacts();
                const userContacts = contacts[userPhone] || [];
                ws.send(JSON.stringify({ type: 'contacts_list', contacts: userContacts }));
                console.log(`📞 [${clientId}] Отправлены контакты: ${userContacts.join(', ')}`);
            }

            // ---------- ПОЛУЧЕНИЕ ИСТОРИИ СООБЩЕНИЙ ----------
            if (msg.type === 'get_messages') {
                const allMessages = readMessages();
                const userMessages = allMessages.filter(m => m.from === userPhone || m.to === userPhone);
                ws.send(JSON.stringify({ type: 'messages_history', messages: userMessages }));
                console.log(`💬 [${clientId}] Отправлено ${userMessages.length} сообщений`);
            }

            // ---------- ОТПРАВКА СООБЩЕНИЯ ----------
            if (msg.type === 'chat_message') {
                const { from, fromName, to, content, encrypted, timestamp } = msg;
                const allMessages = readMessages();
                allMessages.push({ from, fromName, to, content, encrypted, timestamp: timestamp || new Date().toISOString() });
                writeMessages(allMessages);
                console.log(`📤 [${clientId}] Сообщение от ${from} → ${to}`);
                const recipient = clients.get(to);
                if (recipient) {
                    recipient.send(JSON.stringify({ type: 'chat_message', from, fromName, content, encrypted, timestamp }));
                    console.log(`✅ [${clientId}] Доставлено получателю`);
                } else {
                    console.log(`❌ [${clientId}] Получатель оффлайн`);
                }
            }

            // ---------- ОБНОВЛЕНИЕ ПРОФИЛЯ ----------
            if (msg.type === 'update_profile') {
                const { user } = msg;
                if (user && user.phone) {
                    const users = readUsers();
                    if (users[user.phone]) {
                        Object.assign(users[user.phone], user);
                        writeUsers(users);
                        console.log(`✅ [${clientId}] Профиль обновлён ${user.phone}`);
                    }
                }
            }

            // ---------- ПОЛУЧЕНИЕ ПРОФИЛЯ ----------
            if (msg.type === 'get_profile') {
                const users = readUsers();
                const user = users[msg.phone || userPhone];
                if (user) {
                    ws.send(JSON.stringify({
                        type: 'profile_data',
                        user: {
                            phone: user.phone, name: user.name, avatar: user.avatar,
                            status: user.status, email: user.email, publicKey: user.publicKey,
                            settings: user.settings
                        }
                    }));
                } else {
                    ws.send(JSON.stringify({ type: 'profile_error', error: 'Пользователь не найден' }));
                }
            }

            // ---------- ИНДИКАТОР НАБОРА ----------
            if (msg.type === 'typing') {
                const recipient = clients.get(msg.to);
                if (recipient) recipient.send(JSON.stringify({ type: 'typing', from: msg.from }));
            }

            // ---------- WEBRTC ----------
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
                const users = readUsers();
                if (users[msg.phone]) {
                    users[msg.phone].password = msg.newPassword;
                    writeUsers(users);
                    ws.send(JSON.stringify({ type: 'password_changed', success: true }));
                }
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
            const users = readUsers();
            if (users[userPhone]) {
                users[userPhone].status = 'оффлайн';
                writeUsers(users);
            }
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