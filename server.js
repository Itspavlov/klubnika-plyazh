const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// ===== НАСТРОЙКИ =====
const WORK_HOURS = { 
    start: 9,   // 9:00
    end: 25     // 25 = 1:00 ночи следующего дня (24 + 1)
};

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
    sessionDuration: 420 // 7 часов (420 минут)
};

// ===== ЗАГРУЗКА ДАННЫХ =====
function loadData() {
    try {
        const data = fs.readFileSync('settings.json');
        settings = JSON.parse(data);
        console.log('📂 Настройки загружены');
        console.log(`⏱️ Длительность сессии: ${settings.sessionDuration || 420} мин`);
    } catch (e) {
        console.log('📂 Созданы настройки по умолчанию (сессия 7 часов)');
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

    try {
        const data = fs.readFileSync('sessions.json');
        activeSessions = JSON.parse(data);
        
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

// ===== ПРОВЕРКА РАБОЧЕГО ВРЕМЕНИ =====
function isWorkingTime() {
    const now = new Date();
    
    let mskTime;
    try {
        const mskString = now.toLocaleString('en-US', { timeZone: 'Europe/Moscow' });
        mskTime = new Date(mskString);
    } catch (e) {
        mskTime = now;
    }
    
    const hours = mskTime.getHours();
    const minutes = mskTime.getMinutes();
    const currentMinutes = hours * 60 + minutes;
    const startMinutes = WORK_HOURS.start * 60;   // 540
    const endMinutes = WORK_HOURS.end * 60;        // 1500
    
    // Нормализуем текущее время для сравнения
    let normalizedCurrent = currentMinutes;
    if (currentMinutes < startMinutes) {
        normalizedCurrent = currentMinutes + 24 * 60; // Добавляем сутки
    }
    
    const isWorking = normalizedCurrent >= startMinutes && normalizedCurrent < endMinutes;
    
    console.log(`🕐 ${hours}:${String(minutes).padStart(2, '0')} | ${WORK_HOURS.start}:00-1:00 | ${isWorking ? '✅ ОТКРЫТО' : '❌ ЗАКРЫТО'}`);
    
    return isWorking;
}

// ===== ОЧИСТКА ПРОСРОЧЕННЫХ СЕССИЙ =====
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

// ===== АВТО-АКТИВАЦИЯ ДЛЯ ТЕСТА =====
app.get('/', (req, res, next) => {
    const b = parseInt(req.query.b);
    
    // Если перешли с параметром b и нет активной сессии - создаем её
    if (b && b > 0 && !activeSessions[b]) {
        const now = Date.now();
        const duration = settings.sessionDuration || 420;
        const expiresAt = now + (duration * 60 * 1000);
        
        activeSessions[b] = {
            bungalow: b,
            activatedAt: now,
            expiresAt: expiresAt,
            duration: duration
        };
        
        saveSessions();
        console.log(`✅ Авто-активация для теста: бунгало #${b} на ${duration} мин`);
    }
    
    next();
});

// ===== API: НАСТРОЙКИ =====
app.get('/api/settings', (req, res) => {
    res.json(settings);
});

app.post('/api/settings', (req, res) => {
    const { technicalBreak, menuItems, sessionDuration, customItems } = req.body;
    
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
    
    if (customItems !== undefined) {
        settings.customItems = customItems;
        console.log(`📋 Кастомные позиции обновлены (${customItems.length} шт.)`);
    }
    
    saveSettings();
    res.json({ success: true, settings });
});

// ===== API: ПРОВЕРКА РАБОЧЕГО ВРЕМЕНИ =====
app.get('/api/check-time', (req, res) => {
    const working = isWorkingTime();
    const now = new Date();
    let mskTime;
    try {
        mskTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));
    } catch (e) {
        mskTime = now;
    }
    
    res.json({
        working: working,
        currentTime: mskTime.toISOString(),
        hours: mskTime.getHours(),
        minutes: mskTime.getMinutes(),
        schedule: {
            start: WORK_HOURS.start,
            end: WORK_HOURS.end > 24 ? WORK_HOURS.end - 24 : WORK_HOURS.end,
            nextDay: WORK_HOURS.end > 24
        }
    });
});

// ===== API: СЕССИИ БУНГАЛО =====
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
    const remainingHours = Math.floor(remainingMinutes / 60);
    const remainingMins = remainingMinutes % 60;
    
    return res.json({ 
        valid: true, 
        bungalow: bungalow,
        expiresAt: session.expiresAt,
        remainingMinutes: remainingMinutes,
        remainingTime: remainingHours > 0 ? `${remainingHours}ч ${remainingMins}мин` : `${remainingMins}мин`,
        message: `Сессия активна. Осталось ${remainingHours > 0 ? remainingHours + 'ч ' : ''}${remainingMins}мин`
    });
});

app.get('/api/activate-session', (req, res) => {
    const bungalow = parseInt(req.query.b);
    const duration = parseInt(req.query.d) || settings.sessionDuration || 420;
    
    if (!bungalow || isNaN(bungalow) || bungalow <= 0) {
        return res.json({ 
            success: false, 
            error: 'Неверный номер бунгало' 
        });
    }

    const now = Date.now();
    const expiresAt = now + (duration * 60 * 1000);
    
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
    
    const expiresDate = new Date(expiresAt);
    console.log(`
╔═══════════════════════════════════════════╗
║  ✅ СЕССИЯ АКТИВИРОВАНА                  ║
║  📍 Бунгало: #${bungalow}                 ║
║  ⏱️ Длительность: ${duration} мин (${Math.floor(duration/60)}ч ${duration%60}мин)
║  ⏰ Истекает: ${expiresDate.toLocaleString()} ║
╚═══════════════════════════════════════════╝
    `);
    
    return res.json({ 
        success: true, 
        bungalow: bungalow,
        expiresAt: expiresAt,
        duration: duration,
        message: `Сессия активирована на ${Math.floor(duration/60)}ч ${duration%60}мин`
    });
});

app.post('/api/deactivate-session', (req, res) => {
    const bungalow = parseInt(req.body.bungalow);
    
    if (!bungalow || isNaN(bungalow)) {
        return res.json({ success: false, error: 'Не указан номер бунгало' });
    }

    if (activeSessions[bungalow]) {
        delete activeSessions[bungalow];
        saveSessions();
        console.log(`👋 Сессия бунгало #${bungalow} деактивирована`);
        return res.json({ success: true, message: 'Сессия деактивирована' });
    }

    return res.json({ success: true, message: 'Сессия не найдена' });
});

app.get('/api/sessions', (req, res) => {
    const sessionsList = Object.values(activeSessions).map(s => ({
        ...s,
        remainingMinutes: Math.max(0, Math.ceil((s.expiresAt - Date.now()) / 60000))
    }));
    
    res.json({ success: true, sessions: sessionsList, count: sessionsList.length });
});

// ===== API: ЗАКАЗЫ =====
app.post('/api/order', (req, res) => {
    if (settings.technicalBreak) {
        return res.json({ success: false, error: '🔧 Технический перерыв!' });
    }
    
    if (!isWorkingTime()) {
        return res.json({ success: false, error: '🔒 Сейчас не принимаем заказы. Работаем с 9:00 до 1:00' });
    }
    
    const order = req.body;
    
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
║  📍 Бунгало: #${order.bungalow || 'самовывоз'}
║  👤 Имя: ${order.customerName || 'не указано'}
║  📞 Телефон: ${order.customerPhone || 'не указан'}
║  🔑 КОД: ${confirmCode}
${itemsText}
║  💰 Итого: ${order.total} ₽
║  🕐 Время: ${new Date().toLocaleString()}
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

// ===== API: ЧАТЫ =====
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
        chats[phone] = { name: name || 'Клиент', messages: [], unread: 0 };
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

// ===== API: ОТЗЫВЫ =====
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

app.delete('/api/review/:id', (req, res) => {
    const reviewId = parseInt(req.params.id);
    
    const index = reviews.findIndex(r => r.id === reviewId);
    
    if (index === -1) {
        return res.json({ success: false, error: 'Отзыв не найден' });
    }
    
    const deleted = reviews[index];
    reviews.splice(index, 1);
    saveReviews();
    
    console.log(`🗑️ Удален отзыв #${reviewId} от ${deleted.name}`);
    res.json({ success: true, message: 'Отзыв удален' });
});

// ===== ГЕНЕРАЦИЯ QR-КОДА =====
app.get('/generate-qr', (req, res) => {
    const bungalow = req.query.b || 1;
    const duration = req.query.d || settings.sessionDuration || 420;
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const activateUrl = `${baseUrl}/activate?b=${bungalow}&d=${duration}`;
    const durationHours = Math.floor(duration / 60);
    const durationMins = duration % 60;
    const durationText = durationHours > 0 ? `${durationHours}ч ${durationMins}мин` : `${durationMins}мин`;
    
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
                    background: linear-gradient(135deg, #FFF5F5 0%, #FFE8EC 100%);
                    padding: 20px;
                }
                .qr-card {
                    background: white;
                    padding: 30px;
                    border-radius: 24px;
                    box-shadow: 0 20px 60px rgba(255, 71, 87, 0.15);
                    text-align: center;
                    max-width: 400px;
                    width: 100%;
                }
                .qr-card h2 {
                    color: #FF4757;
                    font-size: 28px;
                    margin-bottom: 8px;
                    font-weight: 800;
                }
                .qr-card .subtitle {
                    color: #6B7280;
                    margin-bottom: 20px;
                    font-size: 14px;
                }
                #qrcode {
                    display: flex;
                    justify-content: center;
                    margin: 20px 0;
                    padding: 20px;
                    background: white;
                    border-radius: 16px;
                    border: 2px dashed #FFE0B2;
                }
                .info-box {
                    background: #FFF8E1;
                    padding: 16px;
                    border-radius: 16px;
                    margin: 15px 0;
                    border: 1px solid #FFE0B2;
                }
                .info-box .duration {
                    font-size: 32px;
                    font-weight: 800;
                    color: #FF4757;
                }
                .info-box .label {
                    font-size: 13px;
                    color: #6B7280;
                    margin-top: 4px;
                }
                .activate-btn {
                    display: inline-block;
                    background: linear-gradient(135deg, #FF4757, #E63946);
                    color: white;
                    padding: 16px 32px;
                    border-radius: 100px;
                    text-decoration: none;
                    font-weight: 700;
                    font-size: 16px;
                    margin-top: 15px;
                    box-shadow: 0 6px 20px rgba(255, 71, 87, 0.3);
                    transition: all 0.3s;
                }
                .activate-btn:active {
                    transform: scale(0.95);
                }
                .url-display {
                    background: #F8FAFC;
                    padding: 12px;
                    border-radius: 12px;
                    margin-top: 15px;
                    font-size: 11px;
                    word-break: break-all;
                    color: #9CA3AF;
                    font-family: monospace;
                }
                .warning {
                    color: #EF4444;
                    font-size: 13px;
                    margin-top: 15px;
                    padding: 10px;
                    background: #FEF2F2;
                    border-radius: 12px;
                }
                .schedule {
                    font-size: 13px;
                    color: #6B7280;
                    margin-top: 12px;
                }
            </style>
        </head>
        <body>
            <div class="qr-card">
                <h2>🏖️ Бунгало #${bungalow}</h2>
                <p class="subtitle">Отсканируйте для заказа клубники 🍓</p>
                
                <div id="qrcode"></div>
                
                <div class="info-box">
                    <div class="duration">⏱️ ${durationText}</div>
                    <div class="label">Сессия активна после сканирования</div>
                </div>
                
                <a href="${activateUrl}" class="activate-btn">
                    🍓 Открыть меню
                </a>
                
                <p class="schedule">
                    🕐 Доставка: 9:00-20:00<br>
                    🏪 Киоск: 9:00-1:00
                </p>
                
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
                    colorDark: "#FF4757",
                    colorLight: "#FFFFFF",
                    correctLevel: QRCode.CorrectLevel.H
                });
            </script>
        </body>
        </html>
    `);
});

// ===== АКТИВАЦИЯ СЕССИИ =====
app.get('/activate', (req, res) => {
    const bungalow = parseInt(req.query.b);
    const duration = parseInt(req.query.d) || settings.sessionDuration || 420;
    
    if (!bungalow || isNaN(bungalow) || bungalow <= 0) {
        return res.send(`
            <html>
            <head><meta charset="UTF-8"><title>Ошибка</title></head>
            <body style="font-family:sans-serif;text-align:center;padding:40px;">
                <h1 style="color:#EF4444;">❌ Ошибка</h1>
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
    
    console.log(`✅ Сессия бунгало #${bungalow} активирована на ${Math.floor(duration/60)}ч ${duration%60}мин`);
    
    res.redirect(`/?b=${bungalow}`);
});

// ===== ЗАПУСК СЕРВЕРА =====
loadData();

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    const endHour = WORK_HOURS.end > 24 ? WORK_HOURS.end - 24 : WORK_HOURS.end;
    const sessionHours = Math.floor(settings.sessionDuration / 60);
    const sessionMins = settings.sessionDuration % 60;
    
    console.log(`
╔═══════════════════════════════════════════╗
║  🍓 STRAWBERRY IN CHOCOLATE             ║
║  🚀 СЕРВЕР ЗАПУЩЕН!                      ║
╠═══════════════════════════════════════════╣
║  📱 http://localhost:${PORT}              ║
║  📋 http://localhost:${PORT}/admin.html   ║
║  🔑 http://localhost:${PORT}/generate-qr  ║
╠═══════════════════════════════════════════╣
║  🕐 График: ${WORK_HOURS.start}:00 - ${endHour}:00
║  ⏱️ Сессия: ${sessionHours}ч ${sessionMins}мин
║  📦 Доставка: 15 минут
║  🔐 Сессии сохраняются в файл
╚═══════════════════════════════════════════╝
    `);
});