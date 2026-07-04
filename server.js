const express = require('express');
const cors = require('cors');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// ===== ЛОГИРОВАНИЕ ЗАПРОСОВ =====
app.use((req, res, next) => {
    console.log(`📨 ${req.method} ${req.url}`);
    if (req.method === 'POST' && req.body && Object.keys(req.body).length > 0) {
        console.log('📦 Body:', JSON.stringify(req.body, null, 2));
    }
    next();
});

let orders = [];
let orderCounter = 1000;
let chats = {};
let reviews = [];

// ===== ХРАНИЛИЩЕ АКТИВНЫХ СЕССИЙ БУНГАЛО =====
let activeSessions = {};

let settings = {
    technicalBreak: false,
    menuItems: {
        '1': true, '2': true, '3': true, '4': true, '5': true,
        '6': true, '7': true, '8': true, '9': true, '10': true,
        '11': true, '12': true, '13': true, '14': true, '15': true
    },
    sessionDuration: 420 // Длительность сессии в минутах (1 для теста, 420 для 7 часов)
};

// ===== ЗАГРУЗКА ДАННЫХ =====
function loadData() {
    try {
        const data = fs.readFileSync('settings.json');
        settings = JSON.parse(data);
        console.log('📂 Настройки загружены');
        console.log(`⏱️ Длительность сессии: ${settings.sessionDuration || 1} мин`);
    } catch (e) {
        console.log('📂 Созданы настройки по умолчанию');
        saveSettings();
    }

    try {
        const data = fs.readFileSync('orders.json');
        const savedOrders = JSON.parse(data);
        orders = savedOrders;
        if (orders.length > 0) {
            const maxId = Math.max(...orders.map(o => o.id || 0));
            orderCounter = Math.max(orderCounter, maxId + 1);
        }
        console.log(`📂 Загружено ${orders.length} заказов`);
    } catch (e) {
        console.log('📂 Новый файл заказов');
        saveOrders();
    }

    try {
        const data = fs.readFileSync('chats.json');
        chats = JSON.parse(data);
        console.log(`📂 Загружено ${Object.keys(chats).length} чатов`);
    } catch (e) {
        console.log('📂 Новый файл чатов');
        saveChats();
    }

    try {
        const data = fs.readFileSync('reviews.json');
        reviews = JSON.parse(data);
        console.log(`📂 Загружено ${reviews.length} отзывов`);
    } catch (e) {
        console.log('📂 Новый файл отзывов');
        saveReviews();
    }

    // Загружаем активные сессии
    try {
        const data = fs.readFileSync('sessions.json');
        activeSessions = JSON.parse(data);
        
        // Очищаем просроченные сессии при загрузке
        const now = Date.now();
        let cleaned = false;
        for (const bungalow in activeSessions) {
            if (now > activeSessions[bungalow].expiresAt) {
                delete activeSessions[bungalow];
                cleaned = true;
            }
        }
        if (cleaned) {
            saveSessions();
        }
        
        console.log(`📂 Загружено ${Object.keys(activeSessions).length} активных сессий`);
    } catch (e) {
        console.log('📂 Новый файл сессий');
        activeSessions = {};
        saveSessions();
    }
}

function saveSettings() {
    try { fs.writeFileSync('settings.json', JSON.stringify(settings, null, 2)); } catch (e) {}
}

function saveOrders() {
    try { fs.writeFileSync('orders.json', JSON.stringify(orders, null, 2)); } catch (e) {}
}

function saveChats() {
    try { fs.writeFileSync('chats.json', JSON.stringify(chats, null, 2)); } catch (e) {}
}

function saveReviews() {
    try { fs.writeFileSync('reviews.json', JSON.stringify(reviews, null, 2)); } catch (e) {}
}

function saveSessions() {
    try { fs.writeFileSync('sessions.json', JSON.stringify(activeSessions, null, 2)); } catch (e) {}
}

function generateCode() {
    return Math.floor(1000 + Math.random() * 9000).toString();
}

// ================================================================
// ===== ОЧИСТКА ПРОСРОЧЕННЫХ СЕССИЙ (каждые 30 секунд) =====
// ================================================================
setInterval(() => {
    const now = Date.now();
    let changed = false;
    
    for (const bungalow in activeSessions) {
        if (now > activeSessions[bungalow].expiresAt) {
            console.log(`⏰ Сессия бунгало #${bungalow} истекла и удалена`);
            delete activeSessions[bungalow];
            changed = true;
        }
    }
    
    if (changed) {
        saveSessions();
    }
}, 30000);

// ================================================================
// ===== НАСТРОЙКИ =====
// ================================================================

app.get('/api/settings', (req, res) => {
    res.json(settings);
});

app.post('/api/settings', (req, res) => {
    const { technicalBreak, menuItems, sessionDuration } = req.body;
    
    if (technicalBreak !== undefined) {
        settings.technicalBreak = technicalBreak;
        console.log(`🔧 Технический перерыв: ${technicalBreak ? 'ВКЛЮЧЕН' : 'ВЫКЛЮЧЕН'}`);
    }
    
    if (menuItems) {
        settings.menuItems = { ...settings.menuItems, ...menuItems };
        console.log('📋 Меню обновлено');
    }
    
    if (sessionDuration !== undefined) {
        settings.sessionDuration = sessionDuration;
        console.log(`⏱️ Длительность сессии изменена на ${sessionDuration} мин`);
    }
    
    saveSettings();
    res.json({ success: true, settings });
});

// ================================================================
// ===== СЕССИИ БУНГАЛО =====
// ================================================================

// Проверка активной сессии
app.get('/api/check-session', (req, res) => {
    const bungalow = parseInt(req.query.b);
    
    if (!bungalow || isNaN(bungalow) || bungalow <= 0) {
        return res.json({ 
            valid: false, 
            reason: 'no_bungalow',
            message: 'Номер бунгало не указан'
        });
    }

    const session = activeSessions[bungalow];
    
    if (!session) {
        return res.json({ 
            valid: false, 
            reason: 'no_session',
            message: 'Нет активной сессии. Отсканируйте QR-код в бунгало.'
        });
    }

    const now = Date.now();
    if (now > session.expiresAt) {
        delete activeSessions[bungalow];
        saveSessions();
        
        return res.json({ 
            valid: false, 
            reason: 'expired',
            message: 'Сессия истекла. Отсканируйте QR-код заново.'
        });
    }

    const remainingMs = session.expiresAt - now;
    const remainingMinutes = Math.ceil(remainingMs / 60000);
    
    return res.json({ 
        valid: true, 
        bungalow: bungalow,
        expiresAt: session.expiresAt,
        remainingMinutes: remainingMinutes,
        message: `Сессия активна. Осталось ${remainingMinutes} мин.`
    });
});

// Активация сессии (по QR-коду)
app.get('/api/activate-session', (req, res) => {
    const bungalow = parseInt(req.query.b);
    const duration = parseInt(req.query.d) || settings.sessionDuration || 1;
    
    if (!bungalow || isNaN(bungalow) || bungalow <= 0) {
        return res.json({ 
            success: false, 
            error: 'Неверный номер бунгало' 
        });
    }

    const now = Date.now();
    const expiresAt = now + (duration * 60 * 1000);
    
    // Проверяем, есть ли уже активная сессия
    const existingSession = activeSessions[bungalow];
    if (existingSession && now < existingSession.expiresAt) {
        const remainingMin = Math.ceil((existingSession.expiresAt - now) / 60000);
        console.log(`🔄 Продление сессии бунгало #${bungalow} (было ${remainingMin} мин)`);
    }
    
    activeSessions[bungalow] = {
        bungalow: bungalow,
        activatedAt: now,
        expiresAt: expiresAt,
        duration: duration
    };
    
    saveSessions();
    
    console.log(`
╔═══════════════════════════════════════════╗
║  ✅ СЕССИЯ АКТИВИРОВАНА                  ║
║  📍 Бунгало: #${bungalow}                 ║
║  ⏱️ Длительность: ${duration} мин         ║
║  ⏰ Истекает: ${new Date(expiresAt).toLocaleString()} ║
╚═══════════════════════════════════════════╝
    `);
    
    return res.json({ 
        success: true, 
        bungalow: bungalow,
        expiresAt: expiresAt,
        duration: duration,
        message: `Сессия активирована на ${duration} мин`
    });
});

// Деактивация сессии (пользователь ушел)
app.post('/api/deactivate-session', (req, res) => {
    const bungalow = parseInt(req.body.bungalow);
    
    if (!bungalow || isNaN(bungalow)) {
        return res.json({ 
            success: false, 
            error: 'Не указан номер бунгало' 
        });
    }

    if (activeSessions[bungalow]) {
        delete activeSessions[bungalow];
        saveSessions();
        
        console.log(`👋 Сессия бунгало #${bungalow} деактивирована пользователем`);
        return res.json({ 
            success: true, 
            message: 'Сессия деактивирована' 
        });
    }

    return res.json({ 
        success: true, 
        message: 'Сессия не найдена' 
    });
});

// Получить все активные сессии (для админки)
app.get('/api/sessions', (req, res) => {
    const sessionsList = Object.values(activeSessions).map(s => ({
        ...s,
        remainingMinutes: Math.max(0, Math.ceil((s.expiresAt - Date.now()) / 60000))
    }));
    
    res.json({ 
        success: true, 
        sessions: sessionsList,
        count: sessionsList.length
    });
});

// ================================================================
// ===== ЗАКАЗЫ (с проверкой сессии) =====
// ================================================================

app.post('/api/order', (req, res) => {
    if (settings.technicalBreak) {
        return res.json({ success: false, error: '🔧 Технический перерыв!' });
    }
    
    const order = req.body;
    
    // Проверяем сессию бунгало
    if (order.bungalow) {
        const session = activeSessions[order.bungalow];
        if (!session) {
            return res.json({ 
                success: false, 
                error: '❌ Нет активной сессии. Отсканируйте QR-код в бунгало.' 
            });
        }
        
        if (Date.now() > session.expiresAt) {
            delete activeSessions[order.bungalow];
            saveSessions();
            return res.json({ 
                success: false, 
                error: '⏰ Сессия истекла. Отсканируйте QR-код заново.' 
            });
        }
    }
    
    // Проверяем доступность позиций
    const unavailableItems = order.items.filter(item => {
        const itemId = item.id.toString();
        return settings.menuItems[itemId] === false;
    });
    
    if (unavailableItems.length > 0) {
        const names = unavailableItems.map(i => i.name).join(', ');
        return res.json({ success: false, error: `❌ Недоступно: ${names}` });
    }
    
    const confirmCode = generateCode();
    
    const newOrder = {
        id: orderCounter++,
        ...order,
        confirmCode: confirmCode,
        status: 'ожидает',
        createdAt: new Date().toISOString(),
        cancelAvailable: true,
        reviewed: false
    };
    
    orders.push(newOrder);
    saveOrders();
    
    const itemsText = order.items.map(item => 
        `  • ${item.name} x${item.quantity} = ${item.price * item.quantity} ₽`
    ).join('\n');
    
    console.log(`
╔═══════════════════════════════════════════╗
║  🍓 НОВЫЙ ЗАКАЗ!                         ║
║  📍 Бунгало: #${order.bungalow || 'самовывоз'}   ║
║  👤 Имя: ${order.customerName || 'не указано'}  ║
║  📞 Телефон: ${order.customerPhone || 'не указан'} ║
║  🔑 КОД: ${confirmCode}                   ║
${itemsText}
║  💰 Итого: ${order.total} ₽               ║
║  🕐 Время: ${new Date().toLocaleString()} ║
╚═══════════════════════════════════════════╝
    `);
    
    res.json({ success: true, orderId: newOrder.id, confirmCode });
});

app.post('/api/my-orders', (req, res) => {
    const { phone } = req.body;
    if (!phone) {
        return res.json({ success: false, error: 'Телефон не указан' });
    }
    
    const userOrders = orders
        .filter(o => o.customerPhone === phone)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    res.json({ success: true, orders: userOrders });
});

app.post('/api/cancel-order', (req, res) => {
    const { orderId, phone } = req.body;
    const order = orders.find(o => o.id === orderId);
    
    if (!order) {
        return res.json({ success: false, error: 'Заказ не найден' });
    }
    
    if (order.customerPhone !== phone) {
        return res.json({ success: false, error: 'Это не ваш заказ' });
    }
    
    const created = new Date(order.createdAt);
    const now = new Date();
    const minutes = (now - created) / 1000 / 60;
    
    if (minutes > 5) {
        return res.json({ success: false, error: '⏰ Прошло больше 5 минут' });
    }
    
    if (order.status !== 'ожидает') {
        return res.json({ success: false, error: 'Заказ уже нельзя отменить' });
    }
    
    order.status = 'отменен';
    order.cancelAvailable = false;
    saveOrders();
    
    console.log(`❌ Заказ #${orderId} отменен!`);
    res.json({ success: true });
});

app.post('/api/confirm', (req, res) => {
    const { orderId, code } = req.body;
    const order = orders.find(o => o.id === orderId);
    
    if (!order) {
        return res.json({ success: false, error: 'Заказ не найден' });
    }
    if (order.confirmCode !== code) {
        return res.json({ success: false, error: 'Неверный код' });
    }
    
    order.status = 'выполнен';
    order.cancelAvailable = false;
    saveOrders();
    
    console.log(`✅ Заказ #${orderId} выполнен!`);
    res.json({ success: true, orderId: orderId });
});

app.post('/api/cancel', (req, res) => {
    const { orderId } = req.body;
    const order = orders.find(o => o.id === orderId);
    
    if (!order) {
        return res.json({ success: false, error: 'Заказ не найден' });
    }
    
    order.status = 'отменен';
    order.cancelAvailable = false;
    saveOrders();
    res.json({ success: true });
});

app.get('/api/orders', (req, res) => {
    res.json(orders);
});

app.post('/api/clear-orders', (req, res) => {
    orders = [];
    saveOrders();
    res.json({ success: true });
});

// Автоотмена через 15 минут
setInterval(() => {
    const now = new Date();
    let changed = false;
    
    orders.forEach(order => {
        if (order.status === 'ожидает') {
            const created = new Date(order.createdAt);
            const minutes = (now - created) / 1000 / 60;
            if (minutes > 15) {
                order.status = 'отменен (таймаут)';
                order.cancelAvailable = false;
                changed = true;
            }
        }
    });
    
    if (changed) {
        saveOrders();
    }
}, 60000);

// ================================================================
// ===== ЧАТЫ =====
// ================================================================

app.get('/api/chats', (req, res) => {
    const chatList = Object.keys(chats).map(phone => ({
        phone,
        name: chats[phone].name || 'Клиент',
        lastMessage: chats[phone].messages.length > 0 ? chats[phone].messages[chats[phone].messages.length - 1] : null,
        unread: chats[phone].unread || 0
    }));
    
    chatList.sort((a, b) => {
        const timeA = a.lastMessage ? new Date(a.lastMessage.time) : new Date(0);
        const timeB = b.lastMessage ? new Date(b.lastMessage.time) : new Date(0);
        return timeB - timeA;
    });
    
    res.json({ chats: chatList });
});

app.get('/api/chat-messages', (req, res) => {
    const { phone } = req.query;
    if (!phone) {
        return res.json({ success: false, error: 'Телефон не указан' });
    }
    
    const chat = chats[phone] || { messages: [], unread: 0 };
    res.json({ success: true, messages: chat.messages || [] });
});

app.post('/api/chat-send', (req, res) => {
    const { phone, text, from, name } = req.body;
    
    if (!phone || !text) {
        return res.json({ success: false, error: 'Недостаточно данных' });
    }
    
    if (!chats[phone]) {
        chats[phone] = { 
            name: name || 'Клиент', 
            messages: [], 
            unread: 0 
        };
    }
    
    const message = {
        text: text,
        from: from || 'client',
        time: new Date().toISOString()
    };
    
    chats[phone].messages.push(message);
    
    if (from === 'client') {
        chats[phone].unread = (chats[phone].unread || 0) + 1;
    } else {
        chats[phone].unread = 0;
    }
    
    if (name) {
        chats[phone].name = name;
    }
    
    saveChats();
    
    console.log(`💬 [${from}] ${phone}: ${text}`);
    res.json({ success: true });
});

app.post('/api/chat-read', (req, res) => {
    const { phone } = req.body;
    
    if (phone && chats[phone]) {
        chats[phone].unread = 0;
        saveChats();
    }
    
    res.json({ success: true });
});

// ===== УДАЛЕНИЕ ЧАТА =====
app.delete('/api/chat-delete', (req, res) => {
    const { phone } = req.query;
    
    if (!phone) {
        return res.json({ success: false, error: 'Телефон не указан' });
    }
    
    if (!chats[phone]) {
        return res.json({ success: false, error: 'Чат не найден' });
    }
    
    delete chats[phone];
    saveChats();
    
    console.log(`🗑️ Чат с ${phone} удален`);
    res.json({ success: true, message: 'Чат удален' });
});

// ================================================================
// ===== ОТЗЫВЫ =====
// ================================================================

app.get('/api/reviews', (req, res) => {
    const sorted = [...reviews].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ success: true, reviews: sorted });
});

app.post('/api/review', (req, res) => {
    const { orderId, name, phone, rating, text } = req.body;
    
    if (!orderId || !rating || !text) {
        return res.json({ success: false, error: 'Недостаточно данных' });
    }
    
    const order = orders.find(o => o.id === orderId);
    if (!order) {
        return res.json({ success: false, error: 'Заказ не найден' });
    }
    
    if (order.status !== 'выполнен') {
        return res.json({ success: false, error: 'Заказ еще не выполнен' });
    }
    
    if (order.reviewed) {
        return res.json({ success: false, error: 'Вы уже оставили отзыв' });
    }
    
    if (order.customerPhone !== phone) {
        return res.json({ success: false, error: 'Это не ваш заказ' });
    }
    
    const review = {
        id: Date.now(),
        orderId: orderId,
        name: name || order.customerName || 'Клиент',
        phone: phone,
        rating: Math.min(5, Math.max(1, rating)),
        text: text.trim(),
        createdAt: new Date().toISOString()
    };
    
    reviews.push(review);
    order.reviewed = true;
    
    saveReviews();
    saveOrders();
    
    console.log(`⭐ Новый отзыв на заказ #${orderId}: ${rating}⭐`);
    res.json({ success: true, review: review });
});

// ===== УДАЛЕНИЕ ОТЗЫВА =====
app.delete('/api/review/:id', (req, res) => {
    const reviewId = parseInt(req.params.id);
    console.log(`🗑️ Попытка удалить отзыв #${reviewId}`);
    
    const index = reviews.findIndex(r => r.id === reviewId);
    
    if (index === -1) {
        console.log(`❌ Отзыв #${reviewId} не найден`);
        return res.json({ success: false, error: 'Отзыв не найден' });
    }
    
    const deleted = reviews[index];
    reviews.splice(index, 1);
    saveReviews();
    
    console.log(`🗑️ Удален отзыв #${reviewId} от ${deleted.name}`);
    res.json({ success: true, message: 'Отзыв удален' });
});

// ================================================================
// ===== ГЕНЕРАЦИЯ QR-КОДА =====
// ================================================================
app.get('/generate-qr', (req, res) => {
    const bungalow = req.query.b || 1;
    const duration = req.query.d || settings.sessionDuration || 1;
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const activateUrl = `${baseUrl}/activate?b=${bungalow}&d=${duration}`;
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>QR-код для бунгало #${bungalow}</title>
            <script src="https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js"></script>
            <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body {
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    min-height: 100vh;
                    background: linear-gradient(135deg, #FFF8F0 0%, #FFE8E0 100%);
                    padding: 20px;
                }
                .qr-card {
                    background: white;
                    padding: 30px;
                    border-radius: 24px;
                    box-shadow: 0 12px 48px rgba(212, 56, 13, 0.15);
                    text-align: center;
                    max-width: 400px;
                    width: 100%;
                }
                .qr-card h2 {
                    color: #D4380D;
                    font-size: 28px;
                    margin-bottom: 8px;
                }
                .qr-card .subtitle {
                    color: #8D6E63;
                    margin-bottom: 20px;
                    font-size: 14px;
                }
                #qrcode {
                    display: flex;
                    justify-content: center;
                    margin: 20px 0;
                    padding: 15px;
                    background: white;
                    border-radius: 16px;
                    border: 2px dashed #FFE0B2;
                }
                .info-box {
                    background: #FFF8E1;
                    padding: 12px 16px;
                    border-radius: 12px;
                    margin: 15px 0;
                    border: 1px solid #FFE0B2;
                }
                .info-box .duration {
                    font-size: 24px;
                    font-weight: 800;
                    color: #E65100;
                }
                .info-box .label {
                    font-size: 13px;
                    color: #8D6E63;
                    margin-top: 4px;
                }
                .activate-btn {
                    display: inline-block;
                    background: linear-gradient(135deg, #D4380D, #B8300A);
                    color: white;
                    padding: 14px 32px;
                    border-radius: 50px;
                    text-decoration: none;
                    font-weight: 700;
                    font-size: 16px;
                    margin-top: 15px;
                    box-shadow: 0 6px 20px rgba(212, 56, 13, 0.3);
                    transition: all 0.3s;
                }
                .activate-btn:hover {
                    transform: translateY(-2px);
                    box-shadow: 0 8px 24px rgba(212, 56, 13, 0.4);
                }
                .activate-btn:active {
                    transform: scale(0.95);
                }
                .url-display {
                    background: #F5F5F5;
                    padding: 10px;
                    border-radius: 8px;
                    margin-top: 15px;
                    font-size: 11px;
                    word-break: break-all;
                    color: #888;
                    font-family: monospace;
                }
                .warning {
                    color: #D32F2F;
                    font-size: 13px;
                    margin-top: 15px;
                    padding: 10px;
                    background: #FFEBEE;
                    border-radius: 8px;
                }
            </style>
        </head>
        <body>
            <div class="qr-card">
                <h2>🏖️ Бунгало #${bungalow}</h2>
                <p class="subtitle">Отсканируйте для заказа клубники 🍓</p>
                
                <div id="qrcode"></div>
                
                <div class="info-box">
                    <div class="duration">⏱️ ${duration} мин</div>
                    <div class="label">Сессия активна ${duration} мин после сканирования</div>
                </div>
                
                <a href="${activateUrl}" class="activate-btn">
                    🍓 Открыть меню
                </a>
                
                <div class="warning">
                    ⚠️ После истечения сессии потребуется повторное сканирование QR-кода
                </div>
                
                <div class="url-display">
                    ${activateUrl}
                </div>
            </div>
            
            <script>
                new QRCode(document.getElementById("qrcode"), {
                    text: "${activateUrl}",
                    width: 250,
                    height: 250,
                    colorDark: "#D4380D",
                    colorLight: "#FFFFFF",
                    correctLevel: QRCode.CorrectLevel.H
                });
            </script>
        </body>
        </html>
    `);
});

// ================================================================
// ===== АКТИВАЦИЯ СЕССИИ (переход по QR) =====
// ================================================================
app.get('/activate', (req, res) => {
    const bungalow = parseInt(req.query.b);
    const duration = parseInt(req.query.d) || settings.sessionDuration || 1;
    
    if (!bungalow || isNaN(bungalow) || bungalow <= 0) {
        return res.send(`
            <html>
            <head><meta charset="UTF-8"><title>Ошибка</title></head>
            <body style="font-family:sans-serif; text-align:center; padding:40px;">
                <h1 style="color:#D32F2F;">❌ Ошибка</h1>
                <p>Неверный номер бунгало</p>
            </body>
            </html>
        `);
    }
    
    const now = Date.now();
    const expiresAt = now + (duration * 60 * 1000);
    
    activeSessions[bungalow] = {
        bungalow: bungalow,
        activatedAt: now,
        expiresAt: expiresAt,
        duration: duration
    };
    
    saveSessions();
    
    console.log(`✅ Сессия бунгало #${bungalow} активирована через QR на ${duration} мин`);
    
    // Перенаправляем на главную с параметром b
    res.redirect(`/?b=${bungalow}`);
});

// ================================================================
// ===== ЗАПУСК =====
// ================================================================

loadData();

const PORT = 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔═══════════════════════════════════════════╗
║  🚀 СЕРВЕР ЗАПУЩЕН!                      ║
║  📱 http://localhost:${PORT}              ║
║  📋 http://localhost:${PORT}/admin.html   ║
║  🔑 http://localhost:${PORT}/generate-qr  ║
╠═══════════════════════════════════════════╣
║  💬 Чаты: свайп влево для удаления       ║
║  ⭐ Отзывы: удаление по кнопке           ║
║  ⏱️ Сессия: ${settings.sessionDuration || 1} мин                       ║
║  📦 Доставка: 15 минут                   ║
║  🔐 Сессии сохраняются в файл            ║
╚═══════════════════════════════════════════╝
    `);
});