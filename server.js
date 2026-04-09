// server.js
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ========== НАСТРОЙКИ ==========
const PORT = process.env.PORT || 8080;
const DATA_DIR = path.join(__dirname, 'polyshell_data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const TOKENS_FILE = path.join(DATA_DIR, 'tokens.json'); // токены сессий

// ========== ИНИЦИАЛИЗАЦИЯ ДАННЫХ ==========
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readJSON(file, defaults = {}) {
    if (fs.existsSync(file)) {
        try {
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch(e) { return defaults; }
    }
    return defaults;
}

function writeJSON(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

// Загружаем данные
let users = readJSON(USERS_FILE, {});
let messages = readJSON(MESSAGES_FILE, []); // массив сообщений
let tokens = readJSON(TOKENS_FILE, {});

function saveUsers() { writeJSON(USERS_FILE, users); }
function saveMessages() { writeJSON(MESSAGES_FILE, messages); }
function saveTokens() { writeJSON(TOKENS_FILE, tokens); }

// Вспомогательные функции
function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

function getUserByPhone(phone) {
    return users[phone] || null;
}

// Добавление сообщения в историю
function addMessage(msg) {
    messages.push(msg);
    saveMessages();
}

// Получение истории между двумя пользователями
function getMessagesBetween(phone1, phone2) {
    return messages.filter(m => 
        (m.from_phone === phone1 && m.to_phone === phone2) ||
        (m.from_phone === phone2 && m.to_phone === phone1)
    );
}

// ========== WEBSOCKET СЕРВЕР ==========
const wss = new WebSocket.Server({ port: PORT });

// Храним подключения: socket -> { phone, token }
const clients = new Map();

wss.on('connection', (ws, req) => {
    console.log('Новое подключение');
    let currentPhone = null;
    let currentToken = null;

    ws.on('message', async (rawData) => {
        let msg;
        try {
            msg = JSON.parse(rawData);
        } catch(e) {
            console.error('Ошибка парсинга JSON:', e);
            return;
        }

        console.log(`Получено: ${msg.type} от ${currentPhone || 'неавторизован'}`);

        // ---- ОБРАБОТЧИКИ ----
        if (msg.type === 'register') {
            const { name, phone, password, avatar, email, publicKey, encryptedPrivateKey } = msg;
            if (!phone || !password || !name) {
                ws.send(JSON.stringify({ type: 'register_error', error: 'Не все поля заполнены' }));
                return;
            }
            if (users[phone]) {
                ws.send(JSON.stringify({ type: 'register_error', error: 'Пользователь уже существует' }));
                return;
            }
            const newUser = {
                phone,
                name,
                password, // в реальном проекте хешируйте!
                avatar: avatar || '👤',
                email: email || '',
                publicKey: publicKey || '',
                encryptedPrivateKey: encryptedPrivateKey || '',
                contacts: [],
                settings: { theme: 'dark', sound: true, vibration: true, preview: true },
                createdAt: new Date().toISOString(),
                lastSeen: new Date().toISOString()
            };
            users[phone] = newUser;
            saveUsers();
            const token = generateToken();
            tokens[token] = phone;
            saveTokens();
            ws.send(JSON.stringify({
                type: 'register_success',
                user: { ...newUser, password: undefined },
                token
            }));
            console.log(`✅ Зарегистрирован: ${phone}`);
        }
        else if (msg.type === 'login') {
            const { phone, password } = msg;
            const user = users[phone];
            if (!user || user.password !== password) {
                ws.send(JSON.stringify({ type: 'login_error', error: 'Неверный номер или пароль' }));
                return;
            }
            const token = generateToken();
            tokens[token] = phone;
            saveTokens();
            // Обновляем lastSeen
            user.lastSeen = new Date().toISOString();
            saveUsers();
            ws.send(JSON.stringify({
                type: 'login_success',
                user: { ...user, password: undefined },
                token
            }));
            currentPhone = phone;
            currentToken = token;
            clients.set(ws, { phone, token });
            console.log(`✅ Вход: ${phone}`);
        }
        else if (msg.type === 'login_with_token') {
            const { token } = msg;
            const phone = tokens[token];
            if (!phone || !users[phone]) {
                ws.send(JSON.stringify({ type: 'login_error', error: 'Неверный токен' }));
                return;
            }
            const user = users[phone];
            user.lastSeen = new Date().toISOString();
            saveUsers();
            ws.send(JSON.stringify({
                type: 'login_success',
                user: { ...user, password: undefined },
                token
            }));
            currentPhone = phone;
            currentToken = token;
            clients.set(ws, { phone, token });
            console.log(`✅ Восстановлена сессия: ${phone}`);
        }
        else if (msg.type === 'logout') {
            const { token } = msg;
            if (token && tokens[token]) {
                delete tokens[token];
                saveTokens();
            }
            if (clients.has(ws)) clients.delete(ws);
            ws.close();
        }
        // ---- ПОЛЬЗОВАТЕЛЬСКИЕ ДАННЫЕ ----
        else if (msg.type === 'get_profile') {
            const { phone } = msg;
            const user = users[phone];
            if (user) {
                ws.send(JSON.stringify({
                    type: 'profile_data',
                    user: { ...user, password: undefined }
                }));
            } else {
                ws.send(JSON.stringify({ type: 'profile_data', error: 'Пользователь не найден' }));
            }
        }
        else if (msg.type === 'update_profile') {
            if (!currentPhone) {
                ws.send(JSON.stringify({ type: 'error', error: 'Не авторизован' }));
                return;
            }
            const user = users[currentPhone];
            if (user) {
                const { name, avatar, status, email, settings } = msg.user;
                if (name !== undefined) user.name = name;
                if (avatar !== undefined) user.avatar = avatar;
                if (status !== undefined) user.status = status;
                if (email !== undefined) user.email = email;
                if (settings !== undefined) user.settings = settings;
                saveUsers();
                ws.send(JSON.stringify({ type: 'profile_data', user: { ...user, password: undefined } }));
                // Оповещаем контакты об обновлении профиля
                const contacts = user.contacts || [];
                for (const contactPhone of contacts) {
                    const contactWs = findWsByPhone(contactPhone);
                    if (contactWs) {
                        contactWs.send(JSON.stringify({
                            type: 'update_profile',
                            user: { phone: currentPhone, name: user.name, avatar: user.avatar, status: user.status }
                        }));
                    }
                }
            }
        }
        // ---- КОНТАКТЫ И ПОИСК ----
        else if (msg.type === 'find_user') {
            const { phone } = msg;
            const user = users[phone];
            if (user) {
                ws.send(JSON.stringify({
                    type: 'user_found',
                    user: { phone: user.phone, name: user.name, avatar: user.avatar, status: user.status, lastSeen: user.lastSeen }
                }));
            } else {
                ws.send(JSON.stringify({ type: 'user_not_found' }));
            }
        }
        else if (msg.type === 'create_chat') {
            if (!currentPhone) return;
            const { to } = msg;
            const fromUser = users[currentPhone];
            const toUser = users[to];
            if (!fromUser || !toUser) return;
            // Добавляем в контакты
            if (!fromUser.contacts.includes(to)) {
                fromUser.contacts.push(to);
                saveUsers();
            }
            if (!toUser.contacts.includes(currentPhone)) {
                toUser.contacts.push(currentPhone);
                saveUsers();
            }
            // Уведомляем обоих
            const toWs = findWsByPhone(to);
            if (toWs) {
                toWs.send(JSON.stringify({
                    type: 'create_chat',
                    from: currentPhone,
                    fromName: fromUser.name,
                    to: to
                }));
            }
            ws.send(JSON.stringify({
                type: 'create_chat',
                from: currentPhone,
                fromName: fromUser.name,
                to: to
            }));
        }
        else if (msg.type === 'get_contacts') {
            if (!currentPhone) return;
            const user = users[currentPhone];
            if (user) {
                ws.send(JSON.stringify({ type: 'contacts_list', contacts: user.contacts || [] }));
            }
        }
        // ---- ПУБЛИЧНЫЕ КЛЮЧИ ----
        else if (msg.type === 'get_public_key') {
            const { targetPhone } = msg;
            const targetUser = users[targetPhone];
            if (targetUser && targetUser.publicKey) {
                ws.send(JSON.stringify({
                    type: 'public_key_response',
                    phone: targetPhone,
                    publicKey: targetUser.publicKey
                }));
            } else {
                ws.send(JSON.stringify({
                    type: 'public_key_response',
                    phone: targetPhone,
                    publicKey: null
                }));
            }
        }
        else if (msg.type === 'update_keys') {
            if (!currentPhone) return;
            const { publicKey, encryptedPrivateKey } = msg;
            const user = users[currentPhone];
            if (user) {
                if (publicKey) user.publicKey = publicKey;
                if (encryptedPrivateKey) user.encryptedPrivateKey = encryptedPrivateKey;
                saveUsers();
                ws.send(JSON.stringify({ type: 'keys_updated' }));
            }
        }
        // ---- СООБЩЕНИЯ ----
        else if (msg.type === 'get_messages') {
            if (!currentPhone) return;
            // Отправляем все сообщения, где участвует currentPhone
            const allUserMessages = messages.filter(m => m.from_phone === currentPhone || m.to_phone === currentPhone);
            ws.send(JSON.stringify({ type: 'messages_history', messages: allUserMessages }));
        }
        else if (msg.type === 'chat_message') {
            if (!currentPhone) return;
            const { to, content, encrypted, isFile, fileName, fileSize, fileType, timestamp, fromName } = msg;
            // Сохраняем сообщение
            const storedMsg = {
                id: Date.now().toString() + crypto.randomBytes(4).toString('hex'),
                from_phone: currentPhone,
                to_phone: to,
                fromName: fromName || users[currentPhone]?.name || currentPhone,
                content: content,
                encrypted: encrypted || false,
                isFile: isFile || false,
                fileName: fileName || '',
                fileSize: fileSize || 0,
                fileType: fileType || '',
                timestamp: timestamp || new Date().toISOString()
            };
            addMessage(storedMsg);
            // Пересылаем получателю, если онлайн
            const recipientWs = findWsByPhone(to);
            if (recipientWs) {
                recipientWs.send(JSON.stringify({
                    type: 'chat_message',
                    from: currentPhone,
                    fromName: storedMsg.fromName,
                    content: content,
                    encrypted: storedMsg.encrypted,
                    isFile: storedMsg.isFile,
                    fileName: storedMsg.fileName,
                    fileSize: storedMsg.fileSize,
                    fileType: storedMsg.fileType,
                    timestamp: storedMsg.timestamp
                }));
            }
        }
        // ---- TYPING ----
        else if (msg.type === 'typing') {
            if (!currentPhone) return;
            const { to } = msg;
            const recipientWs = findWsByPhone(to);
            if (recipientWs) {
                recipientWs.send(JSON.stringify({
                    type: 'typing',
                    from: currentPhone
                }));
            }
        }
        // ---- WEBRTC SIGNALLING ----
        else if (msg.type === 'offer' || msg.type === 'answer' || msg.type === 'ice-candidate') {
            if (!currentPhone) return;
            const { to } = msg;
            const recipientWs = findWsByPhone(to);
            if (recipientWs) {
                const forwardMsg = { ...msg, from: currentPhone };
                delete forwardMsg.to;
                recipientWs.send(JSON.stringify(forwardMsg));
            } else {
                // Можно отправить ответ об офлайн-звонке, но не обязательно
                console.log(`Пользователь ${to} офлайн, звонок не доставлен`);
            }
        }
        else if (msg.type === 'call_ended') {
            if (!currentPhone) return;
            const { to } = msg;
            const recipientWs = findWsByPhone(to);
            if (recipientWs) {
                recipientWs.send(JSON.stringify({ type: 'call_ended', from: currentPhone }));
            }
        }
        // ---- ИЗМЕНЕНИЕ ПАРОЛЯ ----
        else if (msg.type === 'change_password') {
            if (!currentPhone) return;
            const { newPassword } = msg;
            const user = users[currentPhone];
            if (user) {
                user.password = newPassword;
                saveUsers();
                ws.send(JSON.stringify({ type: 'password_changed' }));
            }
        }
        // ---- ОТПРАВКА USER_INFO ПРИ ПОДКЛЮЧЕНИИ (для онлайна) ----
        else if (msg.type === 'user_info') {
            if (!currentPhone) return;
            const { phone, user } = msg;
            // Обновляем lastSeen
            if (users[phone]) {
                users[phone].lastSeen = new Date().toISOString();
                saveUsers();
            }
            // Оповещаем контакты, что пользователь онлайн
            const userData = users[phone];
            if (userData && userData.contacts) {
                for (const contactPhone of userData.contacts) {
                    const contactWs = findWsByPhone(contactPhone);
                    if (contactWs) {
                        contactWs.send(JSON.stringify({
                            type: 'update_profile',
                            user: { phone, name: userData.name, avatar: userData.avatar, status: 'онлайн' }
                        }));
                    }
                }
            }
            ws.send(JSON.stringify({ type: 'user_info_ack' }));
        }
        else {
            console.warn('Неизвестный тип сообщения:', msg.type);
        }
    });

    ws.on('close', () => {
        if (currentPhone) {
            console.log(`❌ Отключился: ${currentPhone}`);
            // Обновляем lastSeen
            const user = users[currentPhone];
            if (user) {
                user.lastSeen = new Date().toISOString();
                saveUsers();
            }
        }
        clients.delete(ws);
    });
});

function findWsByPhone(phone) {
    for (let [ws, info] of clients.entries()) {
        if (info.phone === phone) return ws;
    }
    return null;
}

console.log(`✅ Сервер запущен на порту ${PORT}`);