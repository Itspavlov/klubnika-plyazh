const express = require('express');
const cors = require('cors');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

let orders = [];
let orderCounter = 1000;

// ===== НАСТРОЙКИ (хранятся в файле) =====
let settings = {
    technicalBreak: false, // Технический перерыв
    menuItems: {
        // Каждая позиция: доступна или нет
        '1': true,  // Классика
        '2': true,  // Белый шоколад
        '3': true,  // Тиффани
        '4': true,  // Микс
        '5': true,  // Банан
        '6': true,  // Лимонад
        '7': true,  // Кока-Кола
        '8': true   // Пиво
    }
};

// Загружаем настройки
try {
    const data = fs.readFileSync('settings.json');
    const saved = JSON.parse(data);
    settings = saved;
    console.log('📂 Настройки загружены');
} catch (e) {
    console.log('📂 Созданы настройки по умолчанию');
}

// Сохраняем настройки
function saveSettings() {
    try {
        fs.writeFileSync('settings.json', JSON.stringify(settings, null, 2));
    } catch (e) {
        console.log('❌ Ошибка сохранения настроек:', e.message);
    }
}

function generateCode() {
    return Math.floor(1000 + Math.random() * 9000).toString();
}

function saveOrders() {
    try {
        fs.writeFileSync('orders.json', JSON.stringify(orders, null, 2));
    } catch (e) {
        console.log('❌ Ошибка сохранения заказов:', e.message);
    }
}

// Загружаем заказы
try {
    const data = fs.readFileSync('orders.json');
    const savedOrders = JSON.parse(data);
    orders.push(...savedOrders);
    if (orders.length > 0) {
        const maxId = Math.max(...orders.map(o => o.id || 0));
        orderCounter = Math.max(orderCounter, maxId + 1);
    }
    console.log(`📂 Загружено ${savedOrders.length} заказов`);
} catch (e) {
    console.log('📂 Новый файл заказов');
}

// ================================================================
// ===== ЭНДПОИНТЫ ДЛЯ АДМИНКИ =====
// ================================================================

// Получить настройки
app.get('/api/settings', (req, res) => {
    res.json(settings);
});

// Обновить настройки
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
// ===== НОВЫЙ ЗАКАЗ =====
// ================================================================

app.post('/api/order', (req, res) => {
    // Проверяем технический перерыв
    if (settings.technicalBreak) {
        return res.json({ 
            success: false, 
            error: '🔧 Технический перерыв! Заказы временно не принимаются.' 
        });
    }
    
    const order = req.body;
    
    // Проверяем, что все позиции доступны
    const unavailableItems = order.items.filter(item => {
        const itemId = item.id.toString();
        return settings.menuItems[itemId] === false;
    });
    
    if (unavailableItems.length > 0) {
        const names = unavailableItems.map(i => i.name).join(', ');
        return res.json({ 
            success: false, 
            error: `❌ Следующие позиции временно недоступны: ${names}` 
        });
    }
    
    const confirmCode = generateCode();
    
    const newOrder = {
        id: orderCounter++,
        ...order,
        confirmCode: confirmCode,
        status: 'ожидает',
        createdAt: new Date().toISOString(),
        cancelAvailable: true
    };
    
    orders.push(newOrder);
    saveOrders();
    
    const itemsText = order.items.map(item => 
        `  • ${item.name} x${item.quantity} = ${item.price * item.quantity} ₽`
    ).join('\n');
    
    console.log(`
╔═══════════════════════════════════════════╗
║  🍓 НОВЫЙ ЗАКАЗ!                         ║
║  📍 Бунгало: #${order.bungalow}           ║
║  👤 Имя: ${order.customerName || 'не указано'}  ║
║  📞 Телефон: ${order.customerPhone || 'не указан'} ║
║  🔑 КОД: ${confirmCode}                   ║
${itemsText}
║  💰 Итого: ${order.total} ₽               ║
║  🕐 Время: ${new Date().toLocaleString()} ║
║  ⏰ Отменить можно в течение 5 минут!     ║
╚═══════════════════════════════════════════╝
    `);
    
    res.json({ 
        success: true, 
        orderId: newOrder.id,
        confirmCode: confirmCode,
        message: 'Заказ принят! Отменить можно в течение 5 минут.'
    });
});

// ================================================================
// ===== ОСТАЛЬНЫЕ ЭНДПОИНТЫ =====
// ================================================================

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
        return res.json({ success: false, error: '⏰ Прошло больше 5 минут. Заказ уже готовится!' });
    }
    
    if (order.status === 'отменен') {
        return res.json({ success: false, error: 'Заказ уже отменен' });
    }
    
    if (order.status === 'выполнен') {
        return res.json({ success: false, error: 'Заказ уже доставлен' });
    }
    
    order.status = 'отменен';
    order.cancelAvailable = false;
    saveOrders();
    
    console.log(`❌ Заказ #${orderId} отменен клиентом!`);
    res.json({ success: true, message: '✅ Заказ отменен!' });
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
    res.json({ success: true });
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

const PORT = 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔═══════════════════════════════════════════╗
║  🚀 СЕРВЕР ЗАПУЩЕН!                      ║
║  📱 http://localhost:${PORT}              ║
║  📋 http://localhost:${PORT}/admin.html   ║
╠═══════════════════════════════════════════╣
║  🔧 Управление:                           ║
║  - Технический перерыв                    ║
║  - Вкл/Выкл позиций меню                 ║
╚═══════════════════════════════════════════╝
    `);
});