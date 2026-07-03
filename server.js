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

let settings = {
    technicalBreak: false,
    menuItems: {
        '1': true, '2': true, '3': true, '4': true, '5': true,
        '6': true, '7': true, '8': true, '9': true, '10': true,
        '11': true, '12': true, '13': true, '14': true, '15': true
    }
};

// ===== ЗАГРУЗКА ДАННЫХ =====
function loadData() {
    try {
        const data = fs.readFileSync('settings.json');
        settings = JSON.parse(data);
        console.log('📂 Настройки загружены');
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

function generateCode() {
    return Math.floor(1000 + Math.random() * 9000).toString();
}

// ================================================================
// ===== НАСТРОЙКИ =====
// ================================================================

app.get('/api/settings', (req, res) => {
    res.json(settings);
});

app.post('/api/settings', (req, res) => {
    const { technicalBreak, menuItems } = req.body;
    
    if (technicalBreak !== undefined) {
        settings.technicalBreak = technicalBreak;
        console.log(`🔧 Технический перерыв: ${technicalBreak ? 'ВКЛЮЧЕН' : 'ВЫКЛЮЧЕН'}`);
    }
    
    if (menuItems) {
        settings.menuItems = { ...settings.menuItems, ...menuItems };
        console.log('📋 Меню обновлено');
    }
    
    saveSettings();
    res.json({ success: true, settings });
});

// ================================================================
// ===== ЗАКАЗЫ =====
// ================================================================

app.post('/api/order', (req, res) => {
    if (settings.technicalBreak) {
        return res.json({ success: false, error: '🔧 Технический перерыв!' });
    }
    
    const order = req.body;
    
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
╠═══════════════════════════════════════════╣
║  💬 Чаты: свайп влево для удаления       ║
║  ⭐ Отзывы: удаление по кнопке           ║
║  ⏱️ Сессия: 7 часов                      ║
║  📦 Доставка: 15 минут                   ║
╚═══════════════════════════════════════════╝
    `);
});