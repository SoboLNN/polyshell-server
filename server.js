// ============================================
// PolyShell Signaling Server для Render.com
// ============================================

const WebSocket = require('ws');

// Render.com автоматически задаёт PORT через переменную окружения
const PORT = process.env.PORT || 8080;

// Создаём WebSocket сервер
const wss = new WebSocket.Server({ 
    port: PORT, 
    host: '0.0.0.0' 
});

// Хранилище подключений: телефон -> WebSocket
const clients = new Map();

console.log('🚀 ========================================');
console.log('🚀 PolyShell Signaling Server');
console.log(`🚀 Порт: ${PORT}`);
console.log('🚀 Слушает: 0.0.0.0 (доступен из интернета)');
console.log('🚀 ========================================\n');

// Обработка новых подключений
wss.on('connection', (ws, req) => {
    const clientId = Math.random().toString(36).substr(2, 9);
    const clientIp = req.socket.remoteAddress;
    let userPhone = null;
    
    console.log(`🟢 [${clientId}] Новое подключение с ${clientIp}`);
    
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            console.log(`\n📨 [${clientId}] Тип: ${message.type}`);
            
            // Регистрация пользователя
            if (message.phone && ['login', 'register', 'user_info'].includes(message.type)) {
                userPhone = message.phone;
                clients.set(userPhone, ws);
                ws.phone = userPhone;
                ws.id = clientId;
                
                console.log(`✅ [${clientId}] Зарегистрирован: ${userPhone}`);
                console.log(`📋 Всего клиентов: ${clients.size}`);
                console.log(`📋 В сети: ${Array.from(clients.keys()).join(', ')}`);
                
                ws.send(JSON.stringify({
                    type: 'login_success',
                    phone: userPhone
                }));
            }
            
            // Пересылка сообщений
            if (message.type === 'message') {
                console.log(`📤 [${clientId}] Сообщение:`);
                console.log(`   От: ${message.from}`);
                console.log(`   Кому: ${message.to}`);
                console.log(`   Текст: ${message.content}`);
                
                const recipient = clients.get(message.to);
                
                if (recipient && recipient.readyState === WebSocket.OPEN) {
                    const forwardMessage = {
                        type: 'message',
                        from: message.from,
                        fromName: message.fromName || message.from,
                        content: message.content,
                        timestamp: message.timestamp || new Date().toISOString()
                    };
                    
                    recipient.send(JSON.stringify(forwardMessage));
                    console.log(`✅ [${clientId}] ДОСТАВЛЕНО получателю ${message.to}`);
                } else {
                    console.log(`❌ [${clientId}] НЕ ДОСТАВЛЕНО`);
                    console.log(`   Получатель ${message.to} не найден или оффлайн`);
                }
            }
            
            // Поиск пользователя
            if (message.type === 'find_user') {
                const found = clients.has(message.phone);
                console.log(`🔍 [${clientId}] Поиск ${message.phone}: ${found ? 'НАЙДЕН' : 'НЕ НАЙДЕН'}`);
                
                ws.send(JSON.stringify({
                    type: found ? 'user_found' : 'user_not_found',
                    user: found ? { 
                        phone: message.phone, 
                        name: message.phone, 
                        status: 'онлайн',
                        avatar: '👤'
                    } : null
                }));
            }
            
            // Создание чата
            if (message.type === 'create_chat') {
                console.log(`📝 [${clientId}] Создание чата: ${userPhone} → ${message.to}`);
                
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
            
            // Индикатор набора текста
            if (message.type === 'typing') {
                const recipient = clients.get(message.to);
                if (recipient) {
                    recipient.send(JSON.stringify({
                        type: 'typing',
                        from: message.from
                    }));
                }
            }
            
            // WebRTC сигналинг
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
            
            // Завершение звонка
            if (message.type === 'call_ended') {
                const recipient = clients.get(message.to);
                if (recipient) {
                    recipient.send(JSON.stringify({
                        type: 'call_ended',
                        from: message.from
                    }));
                }
            }
            
        } catch (e) {
            console.error(`❌ [${clientId}] Ошибка парсинга:`, e.message);
        }
    });
    
    ws.on('close', () => {
        console.log(`\n🔴 [${clientId}] Отключился`);
        if (userPhone) {
            clients.delete(userPhone);
            console.log(`🗑️ Удалён из системы: ${userPhone}`);
            console.log(`📋 Осталось клиентов: ${clients.size}`);
        }
    });
    
    ws.on('error', (err) => {
        console.error(`⚠️ [${clientId}] Ошибка:`, err.message);
    });
    
    // Heartbeat
    ws.isAlive = true;
    ws.on('pong', () => {
        ws.isAlive = true;
    });
});

// Проверка активных соединений
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

console.log('\n📡 Ожидание подключений...\n');
console.log('💡 URL для подключения:');
console.log(`   wss://ВАШ_DOMAIN.onrender.com`);
console.log('\n⚠️ Не забудьте вставить этот URL в HTML файл!\n');