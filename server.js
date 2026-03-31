// ============================================
// PolyShell Signaling Server
// Полное серверное хранение: пользователи, ключи, контакты, сообщения, настройки
// ============================================
// Запуск: node server.js
// Установка: npm install ws
// ============================================

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Создаём WebSocket сервер на порту 8080
const wss = new WebSocket.Server({ port: 8080, host: '0.0.0.0' });

// Пути к файлам данных
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const CONTACTS_FILE = path.join(DATA_DIR, 'contacts.json');

// Создаём папку data если не существует
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Инициализация файлов данных
function initDataFiles() {
    if (!fs.existsSync(USERS_FILE)) {
        fs.writeFileSync(USERS_FILE, JSON.stringify({}));
    }
    if (!fs.existsSync(MESSAGES_FILE)) {
        fs.writeFileSync(MESSAGES_FILE, JSON.stringify({}));
    }
    if (!fs.existsSync(CONTACTS_FILE)) {
        fs.writeFileSync(CONTACTS_FILE, JSON.stringify({}));
    }
}

// Чтение данных
function readData(file) {
    try {
        const data = fs.readFileSync(file, 'utf8');
        return JSON.parse(data);
    } catch (e) {
        return {};
    }
}

// Запись данных
function writeData(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// Хранилище подключений: телефон -> WebSocket
const clients = new Map();

console.log('🚀 ========================================');
console.log('🚀 PolyShell Signaling Server (Full Storage)');
console.log('🚀 Порт: 8080');
console.log('🚀 Хранение: ' + DATA_DIR);
console.log('🚀 ========================================\n');

// Инициализация
initDataFiles();

// Обработка новых подключений
wss.on('connection', (ws) => {
    const clientId = Math.random().toString(36).substr(2, 9);
    let userPhone = null;
    
    console.log(`🟢 [${clientId}] Новое подключение`);
    
    // Обработка входящих сообщений
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            console.log(`\n📨 [${clientId}] Тип: ${message.type}`);
            
            // ============================================
            // РЕГИСТРАЦИЯ ПОЛЬЗОВАТЕЛЯ
            // ============================================
            if (message.type === 'register') {
                const users = readData(USERS_FILE);
                
                if (users[message.phone]) {
                    ws.send(JSON.stringify({
                        type: 'register_error',
                        error: 'Пользователь с таким номером уже существует'
                    }));
                    console.log(`❌ [${clientId}] Регистрация failed: пользователь существует`);
                    return;
                }
                
                // Сохраняем пользователя (включая публичный ключ и настройки по умолчанию)
                users[message.phone] = {
                    name: message.name,
                    phone: message.phone,
                    password: message.password, // В продакшене нужно хешировать!
                    avatar: message.avatar || '👤',
                    status: 'онлайн',
                    email: message.email || '',
                    publicKey: message.publicKey || '',
                    settings: {
                        profileVisibility: 'all',
                        lastSeenVisibility: 'all',
                        soundEnabled: true,
                        vibrationEnabled: true,
                        messagePreview: true,
                        theme: 'system'  // system, dark, light
                    },
                    createdAt: new Date().toISOString(),
                    lastSeen: new Date().toISOString()
                };
                
                writeData(USERS_FILE, users);
                
                // Инициализируем хранилище сообщений для пользователя
                const allMessages = readData(MESSAGES_FILE);
                allMessages[message.phone] = [];
                writeData(MESSAGES_FILE, allMessages);
                
                console.log(`✅ [${clientId}] Зарегистрирован: ${message.phone}`);
                console.log(`🔑 Публичный ключ сохранён: ${message.publicKey ? 'да' : 'нет'}`);
                
                ws.send(JSON.stringify({
                    type: 'register_success',
                    user: {
                        phone: message.phone,
                        name: message.name,
                        avatar: message.avatar || '👤',
                        status: 'онлайн',
                        email: message.email || '',
                        publicKey: message.publicKey || '',
                        settings: users[message.phone].settings
                    }
                }));
            }
            
            // ============================================
            // ВХОД ПОЛЬЗОВАТЕЛЯ
            // ============================================
            if (message.type === 'login') {
                const users = readData(USERS_FILE);
                
                if (!users[message.phone]) {
                    ws.send(JSON.stringify({
                        type: 'login_error',
                        error: 'Аккаунт не найден'
                    }));
                    console.log(`❌ [${clientId}] Вход failed: аккаунт не найден`);
                    return;
                }
                
                // Проверка пароля (в реальном приложении – сравнение хешей)
                if (users[message.phone].password !== message.password) {
                    ws.send(JSON.stringify({
                        type: 'login_error',
                        error: 'Неверный пароль'
                    }));
                    console.log(`❌ [${clientId}] Вход failed: неверный пароль`);
                    return;
                }
                
                // Успешный вход
                userPhone = message.phone;
                clients.set(userPhone, ws);
                ws.phone = userPhone;
                ws.id = clientId;
                
                // Обновляем статус и время последнего входа
                users[message.phone].status = 'онлайн';
                users[message.phone].lastSeen = new Date().toISOString();
                writeData(USERS_FILE, users);
                
                console.log(`✅ [${clientId}] Вошёл: ${message.phone}`);
                console.log(`📋 Всего клиентов: ${clients.size}`);
                console.log(`📋 В сети: ${Array.from(clients.keys()).join(', ')}`);
                
                ws.send(JSON.stringify({
                    type: 'login_success',
                    user: {
                        phone: users[message.phone].phone,
                        name: users[message.phone].name,
                        avatar: users[message.phone].avatar,
                        status: 'онлайн',
                        email: users[message.phone].email || '',
                        publicKey: users[message.phone].publicKey || '',
                        settings: users[message.phone].settings || {
                            profileVisibility: 'all',
                            lastSeenVisibility: 'all',
                            soundEnabled: true,
                            vibrationEnabled: true,
                            messagePreview: true,
                            theme: 'system'
                        }
                    }
                }));
            }
            
            // ============================================
            // ОБНОВЛЕНИЕ ПРОФИЛЯ (включая настройки)
            // ============================================
            if (message.type === 'update_profile') {
                const users = readData(USERS_FILE);
                const phone = message.user.phone;
                if (users[phone]) {
                    // Обновляем только переданные поля
                    users[phone] = {
                        ...users[phone],
                        ...message.user,
                        // Обновляем настройки, если они переданы отдельно
                        settings: message.user.settings || users[phone].settings
                    };
                    writeData(USERS_FILE, users);
                    console.log(`✅ [${clientId}] Профиль обновлён: ${phone}`);
                    
                    // Оповещаем контакты об изменении (опционально)
                    const contacts = readData(CONTACTS_FILE);
                    const userContacts = contacts[phone] || [];
                    for (const contactPhone of userContacts) {
                        const contactWs = clients.get(contactPhone);
                        if (contactWs && contactWs.readyState === WebSocket.OPEN) {
                            contactWs.send(JSON.stringify({
                                type: 'contact_updated',
                                contact: {
                                    phone,
                                    name: users[phone].name,
                                    avatar: users[phone].avatar,
                                    status: users[phone].status,
                                    publicKey: users[phone].publicKey
                                }
                            }));
                        }
                    }
                    
                    ws.send(JSON.stringify({
                        type: 'profile_updated',
                        success: true,
                        user: users[phone]
                    }));
                }
            }
            
            // ============================================
            // УСТАНОВКА ПУБЛИЧНОГО КЛЮЧА (если не был передан при регистрации)
            // ============================================
            if (message.type === 'set_public_key') {
                const users = readData(USERS_FILE);
                const phone = message.from || userPhone;
                if (phone && users[phone]) {
                    users[phone].publicKey = message.publicKey;
                    writeData(USERS_FILE, users);
                    console.log(`🔑 [${clientId}] Сохранён публичный ключ для ${phone}`);
                    ws.send(JSON.stringify({
                        type: 'public_key_saved',
                        success: true
                    }));
                }
            }
            
            // ============================================
            // ЗАПРОС ПУБЛИЧНОГО КЛЮЧА ДРУГОГО ПОЛЬЗОВАТЕЛЯ
            // ============================================
            if (message.type === 'get_public_key') {
                const users = readData(USERS_FILE);
                const targetPhone = message.targetPhone;
                const targetUser = users[targetPhone];
                const publicKey = targetUser ? targetUser.publicKey : null;
                
                console.log(`🔑 [${clientId}] Запрос ключа для ${targetPhone}: ${publicKey ? 'найден' : 'не найден'}`);
                
                ws.send(JSON.stringify({
                    type: 'public_key_response',
                    phone: targetPhone,
                    publicKey: publicKey || null
                }));
            }
            
            // ============================================
            // ПОЛУЧЕНИЕ ПОЛНОГО ПРОФИЛЯ (для синхронизации настроек)
            // ============================================
            if (message.type === 'get_profile') {
                const users = readData(USERS_FILE);
                const phone = message.phone || userPhone;
                const user = users[phone];
                if (user) {
                    ws.send(JSON.stringify({
                        type: 'profile_data',
                        user: {
                            phone: user.phone,
                            name: user.name,
                            avatar: user.avatar,
                            status: user.status,
                            email: user.email,
                            publicKey: user.publicKey,
                            settings: user.settings,
                            lastSeen: user.lastSeen
                        }
                    }));
                } else {
                    ws.send(JSON.stringify({
                        type: 'profile_error',
                        error: 'Пользователь не найден'
                    }));
                }
            }
            
            // ============================================
            // ПЕРЕСЫЛКА СООБЩЕНИЙ (с серверным хранением)
            // ============================================
            if (message.type === 'message' || message.type === 'chat_message') {
                console.log(`📤 [${clientId}] Сообщение:`);
                console.log(`   От: ${message.from}`);
                console.log(`   Кому: ${message.to}`);
                console.log(`   Текст: ${message.content ? message.content.substring(0, 50) : '...'}`);
                
                // Сохраняем сообщение на сервере
                const allMessages = readData(MESSAGES_FILE);
                if (!allMessages[message.to]) {
                    allMessages[message.to] = [];
                }
                allMessages[message.to].push({
                    from: message.from,
                    fromName: message.fromName,
                    content: message.content,
                    timestamp: message.timestamp,
                    type: message.type,
                    encrypted: message.encrypted || false
                });
                // Также сохраняем для отправителя? Для истории чата нужно сохранять и для отправителя.
                if (!allMessages[message.from]) {
                    allMessages[message.from] = [];
                }
                allMessages[message.from].push({
                    from: message.from,
                    fromName: message.fromName,
                    content: message.content,
                    timestamp: message.timestamp,
                    type: message.type,
                    encrypted: message.encrypted || false,
                    direction: 'sent'
                });
                writeData(MESSAGES_FILE, allMessages);
                
                const recipient = clients.get(message.to);
                
                if (recipient && recipient.readyState === WebSocket.OPEN) {
                    const forwardMessage = {
                        type: 'chat_message',
                        from: message.from,
                        fromName: message.fromName || message.from,
                        content: message.content,
                        timestamp: message.timestamp || new Date().toISOString(),
                        encrypted: message.encrypted || false
                    };
                    
                    recipient.send(JSON.stringify(forwardMessage));
                    console.log(`✅ [${clientId}] ДОСТАВЛЕНО получателю ${message.to}`);
                } else {
                    console.log(`❌ [${clientId}] НЕ ДОСТАВЛЕНО - получатель оффлайн`);
                }
            }
            
            // ============================================
            // ПОИСК ПОЛЬЗОВАТЕЛЯ
            // ============================================
            if (message.type === 'find_user') {
                const users = readData(USERS_FILE);
                const found = users[message.phone];
                
                console.log(`🔍 [${clientId}] Поиск ${message.phone}: ${found ? 'НАЙДЕН' : 'НЕ НАЙДЕН'}`);
                
                ws.send(JSON.stringify({
                    type: found ? 'user_found' : 'user_not_found',
                    user: found ? { 
                        phone: found.phone, 
                        name: found.name, 
                        status: clients.has(found.phone) ? 'онлайн' : 'оффлайн',
                        avatar: found.avatar || '👤',
                        publicKey: found.publicKey || ''
                    } : null
                }));
            }
            
            // ============================================
            // СОЗДАНИЕ ЧАТА (добавление контакта)
            // ============================================
            if (message.type === 'create_chat') {
                console.log(`📝 [${clientId}] Создание чата: ${userPhone} → ${message.to}`);
                
                const contacts = readData(CONTACTS_FILE);
                if (!contacts[userPhone]) contacts[userPhone] = [];
                if (!contacts[userPhone].includes(message.to)) {
                    contacts[userPhone].push(message.to);
                }
                if (!contacts[message.to]) contacts[message.to] = [];
                if (!contacts[message.to].includes(userPhone)) {
                    contacts[message.to].push(userPhone);
                }
                writeData(CONTACTS_FILE, contacts);
                
                const recipient = clients.get(message.to);
                if (recipient) {
                    recipient.send(JSON.stringify({
                        type: 'create_chat',
                        from: userPhone,
                        fromName: userPhone,
                        to: message.to
                    }));
                    console.log(`✅ [${clientId}] Уведомление о чате отправлено`);
                }
            }
            
            // ============================================
            // ПОЛУЧЕНИЕ СПИСКА КОНТАКТОВ
            // ============================================
            if (message.type === 'get_contacts') {
                const contacts = readData(CONTACTS_FILE);
                const userContacts = contacts[userPhone] || [];
                ws.send(JSON.stringify({
                    type: 'contacts_list',
                    contacts: userContacts
                }));
            }
            
            // ============================================
            // ПОЛУЧЕНИЕ ИСТОРИИ СООБЩЕНИЙ
            // ============================================
            if (message.type === 'get_messages') {
                const allMessages = readData(MESSAGES_FILE);
                const userMessages = allMessages[userPhone] || [];
                ws.send(JSON.stringify({
                    type: 'messages_history',
                    messages: userMessages
                }));
            }
            
            // ============================================
            // ИНДИКАТОР НАБОРА ТЕКСТА
            // ============================================
            if (message.type === 'typing') {
                const recipient = clients.get(message.to);
                if (recipient) {
                    recipient.send(JSON.stringify({
                        type: 'typing',
                        from: message.from
                    }));
                }
            }
            
            // ============================================
            // WEBRTC СИГНАЛИНГ (звонки)
            // ============================================
            if (['offer', 'answer', 'ice-candidate'].includes(message.type)) {
                console.log(`📞 [${clientId}] WebRTC: ${message.type} → ${message.to}`);
                
                const recipient = clients.get(message.to);
                if (recipient) {
                    recipient.send(JSON.stringify({
                        type: message.type,
                        offer: message.offer,
                        answer: message.answer,
                        candidate: message.candidate,
                        from: message.from
                    }));
                }
            }
            
            // ============================================
            // ЗАВЕРШЕНИЕ ЗВОНКА
            // ============================================
            if (message.type === 'call_ended') {
                const recipient = clients.get(message.to);
                if (recipient) {
                    recipient.send(JSON.stringify({
                        type: 'call_ended',
                        from: message.from
                    }));
                }
            }
            
            // ============================================
            // СМЕНА ПАРОЛЯ
            // ============================================
            if (message.type === 'change_password') {
                const users = readData(USERS_FILE);
                if (users[message.phone]) {
                    users[message.phone].password = message.newPassword;
                    writeData(USERS_FILE, users);
                    console.log(`✅ [${clientId}] Пароль изменён: ${message.phone}`);
                    ws.send(JSON.stringify({
                        type: 'password_changed',
                        success: true
                    }));
                }
            }
            
        } catch (e) {
            console.error(`❌ [${clientId}] Ошибка парсинга:`, e.message);
        }
    });
    
    // Обработка отключения
    ws.on('close', () => {
        console.log(`\n🔴 [${clientId}] Отключился`);
        if (userPhone) {
            clients.delete(userPhone);
            
            // Обновляем статус на оффлайн
            const users = readData(USERS_FILE);
            if (users[userPhone]) {
                users[userPhone].status = 'оффлайн';
                users[userPhone].lastSeen = new Date().toISOString();
                writeData(USERS_FILE, users);
            }
            
            console.log(`🗑️ Удалён из системы: ${userPhone}`);
            console.log(`📋 Осталось клиентов: ${clients.size}`);
        }
    });
    
    // Обработка ошибок
    ws.on('error', (err) => {
        console.error(`⚠️ [${clientId}] Ошибка:`, err.message);
    });
    
    // Heartbeat для поддержания соединения
    ws.isAlive = true;
    ws.on('pong', () => {
        ws.isAlive = true;
    });
});

// ============================================
// ПРОВЕРКА АКТИВНЫХ СОЕДИНЕНИЙ
// ============================================
const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            if (ws.phone) {
                clients.delete(ws.phone);
            }
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

wss.on('close', () => {
    clearInterval(interval);
});

// ============================================
// ЗАПУСК СЕРВЕРА
// ============================================
console.log('\n📡 Ожидание подключений...\n');
console.log('💡 Для подключения используйте:');
console.log('   ws://localhost:8080 (локально)');
console.log('   ws://ВАШ_IP:8080 (из сети)');
console.log('   wss://ВАШ_ДОМЕН (интернет)\n');
console.log('📁 Данные сохраняются в: ' + DATA_DIR + '\n');