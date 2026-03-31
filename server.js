const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const CONTACTS_FILE = path.join(DATA_DIR, 'contacts.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');

function readUsers() {
    try {
        return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    } catch (e) {
        return {};
    }
}
function writeUsers(users) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}
function readContacts() {
    try {
        return JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8'));
    } catch (e) {
        return {};
    }
}
function writeContacts(contacts) {
    fs.writeFileSync(CONTACTS_FILE, JSON.stringify(contacts, null, 2));
}
function readMessages() {
    try {
        return JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8'));
    } catch (e) {
        return {};
    }
}
function writeMessages(messages) {
    fs.writeFileSync(MESSAGES_FILE, JSON.stringify(messages, null, 2));
}

// Инициализация файлов, если их нет
if (!fs.existsSync(USERS_FILE)) writeUsers({});
if (!fs.existsSync(CONTACTS_FILE)) writeContacts({});
if (!fs.existsSync(MESSAGES_FILE)) writeMessages({});

const clients = new Map(); // phone -> ws

console.log(`🚀 PolyShell Signaling Server запущен на порту ${PORT}`);
console.log('📁 Хранилище:', DATA_DIR);

wss.on('connection', (ws) => {
    let userPhone = null;

    ws.on('message', (data) => {
        let msg;
        try {
            msg = JSON.parse(data);
        } catch (e) {
            console.error('Ошибка парсинга:', e);
            return;
        }
        console.log('📨 Получено:', msg.type);

        switch (msg.type) {
            case 'register':
                const users = readUsers();
                if (users[msg.phone]) {
                    ws.send(JSON.stringify({ type: 'register_error', error: 'Пользователь уже существует' }));
                    return;
                }
                users[msg.phone] = {
                    name: msg.name,
                    phone: msg.phone,
                    password: msg.password, // в продакшене хешировать!
                    avatar: msg.avatar || '👤',
                    status: 'онлайн',
                    email: msg.email || '',
                    publicKey: msg.publicKey || '',
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
                    user: users[msg.phone]
                }));
                break;

            case 'login':
                const usersData = readUsers();
                const user = usersData[msg.phone];
                if (!user) {
                    ws.send(JSON.stringify({ type: 'login_error', error: 'Аккаунт не найден' }));
                    return;
                }
                if (user.password !== msg.password) {
                    ws.send(JSON.stringify({ type: 'login_error', error: 'Неверный пароль' }));
                    return;
                }
                userPhone = msg.phone;
                user.status = 'онлайн';
                user.lastSeen = new Date().toISOString();
                writeUsers(usersData);
                clients.set(userPhone, ws);
                ws.send(JSON.stringify({
                    type: 'login_success',
                    user: {
                        phone: user.phone,
                        name: user.name,
                        avatar: user.avatar,
                        status: user.status,
                        email: user.email,
                        publicKey: user.publicKey,
                        settings: user.settings
                    }
                }));
                break;

            case 'set_public_key':
                if (userPhone) {
                    const usersUpd = readUsers();
                    if (usersUpd[userPhone]) {
                        usersUpd[userPhone].publicKey = msg.publicKey;
                        writeUsers(usersUpd);
                        ws.send(JSON.stringify({ type: 'public_key_saved', success: true }));
                    }
                }
                break;

            case 'get_public_key':
                const usersGet = readUsers();
                const target = usersGet[msg.targetPhone];
                ws.send(JSON.stringify({
                    type: 'public_key_response',
                    phone: msg.targetPhone,
                    publicKey: target ? target.publicKey : null
                }));
                break;

            case 'find_user':
                const allUsers = readUsers();
                const found = allUsers[msg.phone];
                if (found) {
                    ws.send(JSON.stringify({
                        type: 'user_found',
                        user: {
                            phone: found.phone,
                            name: found.name,
                            avatar: found.avatar,
                            status: clients.has(found.phone) ? 'онлайн' : 'оффлайн',
                            publicKey: found.publicKey || ''
                        }
                    }));
                } else {
                    ws.send(JSON.stringify({ type: 'user_not_found', phone: msg.phone }));
                }
                break;

            case 'create_chat':
                if (!userPhone) return;
                const contacts = readContacts();
                if (!contacts[userPhone]) contacts[userPhone] = [];
                if (!contacts[userPhone].includes(msg.to)) contacts[userPhone].push(msg.to);
                if (!contacts[msg.to]) contacts[msg.to] = [];
                if (!contacts[msg.to].includes(userPhone)) contacts[msg.to].push(userPhone);
                writeContacts(contacts);
                // Уведомляем собеседника, если он онлайн
                const recipient = clients.get(msg.to);
                if (recipient && recipient.readyState === WebSocket.OPEN) {
                    recipient.send(JSON.stringify({
                        type: 'create_chat',
                        from: userPhone,
                        fromName: userPhone,
                        to: msg.to
                    }));
                }
                break;

            case 'get_contacts':
                if (!userPhone) return;
                const userContacts = readContacts()[userPhone] || [];
                ws.send(JSON.stringify({ type: 'contacts_list', contacts: userContacts }));
                break;

            case 'get_messages':
                if (!userPhone) return;
                const allMessages = readMessages();
                const userMessages = allMessages[userPhone] || [];
                ws.send(JSON.stringify({ type: 'messages_history', messages: userMessages }));
                break;

            case 'get_profile':
                if (!userPhone) return;
                const profileUser = readUsers()[userPhone];
                if (profileUser) {
                    ws.send(JSON.stringify({
                        type: 'profile_data',
                        user: {
                            phone: profileUser.phone,
                            name: profileUser.name,
                            avatar: profileUser.avatar,
                            status: profileUser.status,
                            email: profileUser.email,
                            publicKey: profileUser.publicKey,
                            settings: profileUser.settings
                        }
                    }));
                } else {
                    ws.send(JSON.stringify({ type: 'profile_error', error: 'Пользователь не найден' }));
                }
                break;

            case 'update_profile':
                if (!userPhone) return;
                const usersUpd = readUsers();
                if (usersUpd[userPhone]) {
                    Object.assign(usersUpd[userPhone], msg.user);
                    writeUsers(usersUpd);
                }
                break;

            case 'chat_message':
                if (!userPhone) return;
                // Сохраняем сообщение для обоих участников
                const allMsgs = readMessages();
                const msgTo = msg.to;
                const msgFrom = userPhone;
                const storedMsg = {
                    from: msgFrom,
                    fromName: msg.fromName,
                    content: msg.content,
                    timestamp: msg.timestamp,
                    encrypted: msg.encrypted
                };
                if (!allMsgs[msgTo]) allMsgs[msgTo] = [];
                allMsgs[msgTo].push(storedMsg);
                if (!allMsgs[msgFrom]) allMsgs[msgFrom] = [];
                allMsgs[msgFrom].push({ ...storedMsg, direction: 'sent' });
                writeMessages(allMsgs);
                // Пересылаем получателю, если он онлайн
                const targetWs = clients.get(msgTo);
                if (targetWs && targetWs.readyState === WebSocket.OPEN) {
                    targetWs.send(JSON.stringify({
                        type: 'chat_message',
                        from: msgFrom,
                        fromName: msg.fromName,
                        content: msg.content,
                        timestamp: msg.timestamp,
                        encrypted: msg.encrypted
                    }));
                }
                break;

            case 'typing':
                const typingRecipient = clients.get(msg.to);
                if (typingRecipient && typingRecipient.readyState === WebSocket.OPEN) {
                    typingRecipient.send(JSON.stringify({
                        type: 'typing',
                        from: userPhone
                    }));
                }
                break;

            case 'offer':
            case 'answer':
            case 'ice-candidate':
                const r = clients.get(msg.to);
                if (r && r.readyState === WebSocket.OPEN) {
                    r.send(JSON.stringify({
                        type: msg.type,
                        from: userPhone,
                        offer: msg.offer,
                        answer: msg.answer,
                        candidate: msg.candidate
                    }));
                }
                break;

            case 'call_ended':
                const callRecipient = clients.get(msg.to);
                if (callRecipient && callRecipient.readyState === WebSocket.OPEN) {
                    callRecipient.send(JSON.stringify({
                        type: 'call_ended',
                        from: userPhone
                    }));
                }
                break;

            case 'change_password':
                if (!userPhone) return;
                const usersPass = readUsers();
                if (usersPass[userPhone]) {
                    usersPass[userPhone].password = msg.newPassword;
                    writeUsers(usersPass);
                    ws.send(JSON.stringify({ type: 'password_changed', success: true }));
                }
                break;

            default:
                console.log('Неизвестный тип:', msg.type);
        }
    });

    ws.on('close', () => {
        if (userPhone) {
            clients.delete(userPhone);
            const usersOff = readUsers();
            if (usersOff[userPhone]) {
                usersOff[userPhone].status = 'оффлайн';
                writeUsers(usersOff);
            }
            console.log(`🔴 Пользователь ${userPhone} отключился`);
        }
    });
});