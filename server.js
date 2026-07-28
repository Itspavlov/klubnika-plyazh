const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ===== ПОДКЛЮЧЕНИЕ К БАЗЕ =====
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// ===== НАСТРОЙКИ =====
const WORK_HOURS = { 
    start: 9,
    end: 30
};

let settings = {
    technicalBreak: false,
    menuItems: {},
    sessionDuration: 420
};

// ===== СОЗДАНИЕ ТАБЛИЦ =====
async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value JSONB
            );
            CREATE TABLE IF NOT EXISTS orders (
                id SERIAL PRIMARY KEY,
                data JSONB,
                status TEXT DEFAULT 'ожидает',
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
            CREATE TABLE IF NOT EXISTS sessions (
                bungalow INTEGER PRIMARY KEY,
                data JSONB,
                expires_at BIGINT
            );
            CREATE TABLE IF NOT EXISTS chats (
                phone TEXT PRIMARY KEY,
                data JSONB
            );
            CREATE TABLE IF NOT EXISTS reviews (
                id SERIAL PRIMARY KEY,
                data JSONB,
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
            CREATE TABLE IF NOT EXISTS gifts (
                id SERIAL PRIMARY KEY,
                ip TEXT NOT NULL,
                bungalow INTEGER,
                claimed BOOLEAN DEFAULT false,
                claimed_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        console.log('📦 Таблицы созданы');
    } catch (e) {
        console.error('Ошибка создания таблиц:', e.message);
    }
}

function generateCode() {
    return Math.floor(1000 + Math.random() * 9000).toString();
}

async function loadSettings() {
    try {
        const res = await pool.query("SELECT value FROM settings WHERE key = 'main'");
        if (res.rows.length > 0) {
            settings = res.rows[0].value;
            console.log('📂 Настройки загружены из БД');
        } else {
            await saveSettings();
            console.log('📂 Настройки по умолчанию');
        }
    } catch (e) {
        console.error('Ошибка загрузки настроек:', e.message);
    }
}

async function saveSettings() {
    await pool.query(
        "INSERT INTO settings (key, value) VALUES ('main', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
        [JSON.stringify(settings)]
    ).catch(e => console.error(e.message));
}

function isWorkingTime() {
    const now = new Date();
    let mskTime;
    try { mskTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Moscow' })); }
    catch (e) { mskTime = now; }
    
    const hours = mskTime.getHours();
    const minutes = mskTime.getMinutes();
    const currentMinutes = hours * 60 + minutes;
    const startMinutes = WORK_HOURS.start * 60;
    const endMinutes = WORK_HOURS.end * 60;
    let normalized = currentMinutes < startMinutes ? currentMinutes + 24 * 60 : currentMinutes;
    return normalized >= startMinutes && normalized < endMinutes;
}

// ===== ЛОГИРОВАНИЕ =====
app.use((req, res, next) => {
    console.log(`📨 ${req.method} ${req.url}`);
    next();
});

// ===== АВТО-АКТИВАЦИЯ =====
app.get('/', async (req, res, next) => {
    const b = parseInt(req.query.b);
    if (b && b > 0) {
        try {
            const exist = await pool.query('SELECT * FROM sessions WHERE bungalow = $1 AND expires_at > $2', [b, Date.now()]);
            if (exist.rows.length === 0) {
                const now = Date.now();
                const duration = settings.sessionDuration || 420;
                const exp = now + (duration * 60 * 1000);
                await pool.query(
                    'INSERT INTO sessions (bungalow, data, expires_at) VALUES ($1, $2, $3) ON CONFLICT (bungalow) DO UPDATE SET expires_at = $3',
                    [b, JSON.stringify({ bungalow: b, activatedAt: now, duration }), exp]
                );
                console.log(`✅ Авто-активация: бунгало #${b}`);
            }
        } catch (e) {}
    }
    next();
});

app.use(express.static('.'));

// ===== API: НАСТРОЙКИ =====
app.get('/api/settings', (req, res) => res.json(settings));

app.post('/api/settings', async (req, res) => {
    const { technicalBreak, menuItems, sessionDuration, customItems } = req.body;
    if (technicalBreak !== undefined) settings.technicalBreak = technicalBreak;
    if (menuItems) settings.menuItems = { ...settings.menuItems, ...menuItems };
    if (sessionDuration !== undefined) settings.sessionDuration = sessionDuration;
    if (customItems !== undefined) settings.customItems = customItems;
    await saveSettings();
    res.json({ success: true, settings });
});

// ===== API: СЕССИИ =====
app.get('/api/check-session', async (req, res) => {
    const b = parseInt(req.query.b);
    if (!b || b <= 0) return res.json({ valid: false, reason: 'no_bungalow' });
    try {
        const r = await pool.query('SELECT * FROM sessions WHERE bungalow = $1', [b]);
        if (r.rows.length === 0) return res.json({ valid: false, reason: 'no_session' });
        if (Date.now() > r.rows[0].expires_at) {
            await pool.query('DELETE FROM sessions WHERE bungalow = $1', [b]);
            return res.json({ valid: false, reason: 'expired' });
        }
        const rem = Math.ceil((r.rows[0].expires_at - Date.now()) / 60000);
        res.json({ valid: true, bungalow: b, expiresAt: r.rows[0].expires_at, remainingMinutes: rem });
    } catch (e) {
        res.json({ valid: false, reason: 'error' });
    }
});

app.get('/api/activate-session', async (req, res) => {
    const b = parseInt(req.query.b);
    const d = parseInt(req.query.d) || settings.sessionDuration || 420;
    if (!b || b <= 0) return res.json({ success: false });
    const exp = Date.now() + (d * 60 * 1000);
    await pool.query(
        'INSERT INTO sessions (bungalow, data, expires_at) VALUES ($1, $2, $3) ON CONFLICT (bungalow) DO UPDATE SET expires_at = $3',
        [b, JSON.stringify({ bungalow: b }), exp]
    );
    res.json({ success: true, bungalow: b, expiresAt: exp });
});

// ===== API: ЗАКАЗЫ (С ГЕОЛОКАЦИЕЙ) =====
app.post('/api/order', async (req, res) => {
    if (settings.technicalBreak) return res.json({ success: false, error: '🔧 Технический перерыв!' });
    if (!isWorkingTime()) return res.json({ success: false, error: '🔒 Не принимаем заказы' });
    
    const order = req.body;
    
    if (order.location) {
        order.lat = order.location.lat;
        order.lng = order.location.lng;
        console.log(`📍 Геолокация заказа: ${order.lat}, ${order.lng}`);
    } else {
        console.log('⚠️ Заказ без геолокации');
    }
    
    if (order.bungalow) {
        const s = await pool.query('SELECT * FROM sessions WHERE bungalow = $1', [order.bungalow]);
        if (s.rows.length === 0 || Date.now() > s.rows[0].expires_at)
            return res.json({ success: false, error: '❌ Сессия недействительна' });
    }
    
    const exist = await pool.query(
        "SELECT id FROM orders WHERE data->>'customerPhone' = $1 AND status = 'ожидает'",
        [order.customerPhone]
    );
    if (exist.rows.length > 0)
        return res.json({ success: false, error: '⚠️ У вас уже есть активный заказ' });
    
    const code = generateCode();
    try {
        const r = await pool.query(
            "INSERT INTO orders (data, status) VALUES ($1, 'ожидает') RETURNING id",
            [JSON.stringify({ ...order, confirmCode: code })]
        );
        console.log(`🍓 Новый заказ #${r.rows[0].id} | ${order.customerName} | ${order.total} ₽`);
        if (order.location) {
            console.log(`📍 Координаты: ${order.location.lat}, ${order.location.lng}`);
        }
        
        // ===== УВЕДОМЛЕНИЕ В АДМИНКУ ЧЕРЕЗ WEBSOCKET =====
        io.to('admin-room').emit('new-order', {
            id: r.rows[0].id,
            customerName: order.customerName,
            total: order.total,
            bungalow: order.bungalow,
            location: order.location || null,
            timestamp: new Date().toISOString()
        });
        
        res.json({ success: true, orderId: r.rows[0].id, confirmCode: code });
    } catch (e) {
        console.error('Ошибка создания заказа:', e);
        res.json({ success: false, error: 'Ошибка сервера' });
    }
});

app.post('/api/my-orders', async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.json({ success: false });
    try {
        const r = await pool.query(
            "SELECT id, data, status, created_at FROM orders WHERE data->>'customerPhone' = $1 ORDER BY created_at DESC",
            [phone]
        );
        const orders = r.rows.map(row => ({ id: row.id, ...row.data, status: row.status, createdAt: row.created_at }));
        res.json({ success: true, orders });
    } catch (e) {
        res.json({ success: false, orders: [] });
    }
});

app.post('/api/cancel-order', async (req, res) => {
    const { orderId, phone } = req.body;
    const r = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
    if (r.rows.length === 0) return res.json({ success: false, error: 'Не найден' });
    if (r.rows[0].data.customerPhone !== phone) return res.json({ success: false, error: 'Не ваш' });
    await pool.query("UPDATE orders SET status = 'отменен' WHERE id = $1", [orderId]);
    res.json({ success: true });
});

app.post('/api/confirm', async (req, res) => {
    const { orderId, code } = req.body;
    const r = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
    if (r.rows.length === 0) return res.json({ success: false });
    if (r.rows[0].data.confirmCode !== code) return res.json({ success: false, error: 'Неверный код' });
    await pool.query("UPDATE orders SET status = 'выполнен' WHERE id = $1", [orderId]);
    console.log(`✅ Заказ #${orderId} выполнен`);
    res.json({ success: true });
});

app.post('/api/cancel', async (req, res) => {
    await pool.query("UPDATE orders SET status = 'отменен' WHERE id = $1", [req.body.orderId]);
    res.json({ success: true });
});

app.get('/api/orders', async (req, res) => {
    try {
        const r = await pool.query('SELECT id, data, status, created_at FROM orders ORDER BY created_at DESC');
        res.json(r.rows.map(row => ({ id: row.id, ...row.data, status: row.status, createdAt: row.created_at })));
    } catch (e) {
        console.error('Ошибка загрузки заказов:', e);
        res.json([]);
    }
});

app.post('/api/clear-orders', async (req, res) => {
    await pool.query('DELETE FROM orders');
    res.json({ success: true });
});

// ===== СТАТИСТИКА =====
app.get('/api/stats', async (req, res) => {
    const { period } = req.query;
    let interval = '1 day';
    switch(period) {
        case 'week': interval = '7 days'; break;
        case 'month': interval = '30 days'; break;
        default: interval = '1 day';
    }
    
    try {
        const r = await pool.query(`
            SELECT 
                COUNT(*) as total,
                COALESCE(SUM((data->>'total')::int), 0) as revenue,
                COUNT(CASE WHEN status = 'ожидает' THEN 1 END) as active,
                COUNT(CASE WHEN status = 'выполнен' THEN 1 END) as done,
                COUNT(CASE WHEN status = 'отменен' THEN 1 END) as cancelled
            FROM orders 
            WHERE created_at > NOW() - INTERVAL '${interval}'
        `);
        res.json(r.rows[0]);
    } catch (e) {
        res.json({ total: 0, revenue: 0, active: 0, done: 0, cancelled: 0 });
    }
});

// ===== ЭКСПОРТ ЗАКАЗОВ =====
app.get('/api/export-orders', async (req, res) => {
    try {
        const r = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
        const rows = r.rows.map(row => ({
            id: row.id,
            name: row.data.customerName || '',
            phone: row.data.customerPhone || '',
            bungalow: row.data.bungalow || '',
            total: row.data.total || 0,
            items: row.data.items?.map(i => `${i.name}×${i.quantity}`).join(', ') || '',
            status: row.status,
            created_at: row.created_at,
            lat: row.data.lat || '',
            lng: row.data.lng || ''
        }));
        
        const csv = [
            ['ID','Клиент','Телефон','Бунгало','Сумма','Товары','Статус','Дата','lat','lng'],
            ...rows.map(r => Object.values(r))
        ].map(row => row.join(';')).join('\n');
        
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename=orders.csv');
        res.send('\uFEFF' + csv);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ================================================================
// ===== АВТОМАТИЧЕСКОЕ УВЕДОМЛЕНИЕ О ЗАДЕРЖКЕ =====
// ================================================================

setInterval(async () => {
    try {
        const result = await pool.query(
            `SELECT id, data FROM orders 
             WHERE status = 'ожидает' 
             AND created_at < NOW() - INTERVAL '15 minutes'
             AND data->>'delay_notified' IS NULL`
        );

        for (const row of result.rows) {
            const order = row.data;
            const orderId = row.id;
            const phone = order.customerPhone;
            const name = order.customerName || 'Клиент';

            if (!phone) continue;

            const chatExist = await pool.query('SELECT data FROM chats WHERE phone = $1', [phone]);
            let chatData = chatExist.rows[0]?.data || { name: name, messages: [], unread: 0 };

            const message = {
                text: `🍓 Уважаемый(ая) ${name}! Приносим свои извинения за задержку заказа #${orderId} 🙏\nЗаказов очень много, но наш курьер уже спешит к вам! 🏃‍♂️\nМы работаем над тем, чтобы стать быстрее. Спасибо за ваше терпение! ❤️`,
                from: 'admin',
                time: new Date().toISOString()
            };

            chatData.messages.push(message);
            chatData.unread = (chatData.unread || 0) + 1;

            await pool.query(
                `INSERT INTO chats (phone, data) VALUES ($1, $2) 
                 ON CONFLICT (phone) DO UPDATE SET data = $2`,
                [phone, JSON.stringify(chatData)]
            );

            await pool.query(
                `UPDATE orders SET data = jsonb_set(data, '{delay_notified}', 'true') WHERE id = $1`,
                [orderId]
            );

            console.log(`📨 Авто-уведомление о задержке отправлено для заказа #${orderId} (${phone})`);
        }
    } catch (e) {
        console.error('❌ Ошибка авто-уведомления:', e.message);
    }
}, 30000);

// ================================================================
// ===== API: ПОДАРКИ (GIFTS) =====
// ================================================================

app.post('/api/gift/check', async (req, res) => {
    const { ip } = req.body;
    if (!ip) return res.json({ hasGift: false, error: 'Нет IP' });
    
    try {
        const claimed = await pool.query(
            `SELECT * FROM gifts WHERE ip = $1 AND claimed = true`,
            [ip]
        );
        if (claimed.rows.length > 0) {
            return res.json({ hasGift: false, reason: 'already_claimed' });
        }
        
        const pending = await pool.query(
            `SELECT * FROM gifts WHERE ip = $1 AND claimed = false`,
            [ip]
        );
        if (pending.rows.length > 0) {
            return res.json({ hasGift: true, giftId: pending.rows[0].id });
        }
        
        res.json({ hasGift: false, canActivate: true });
    } catch (e) {
        res.json({ hasGift: false, error: e.message });
    }
});

// ===== ПРОВЕРКА СТАТУСА ПОДАРКА ПО IP =====
app.post('/api/gift/status', async (req, res) => {
    const { ip } = req.body;
    if (!ip) return res.json({ success: false, error: 'Нет IP' });
    
    try {
        // Проверяем, получал ли уже подарок
        const claimed = await pool.query(
            `SELECT * FROM gifts WHERE ip = $1 AND claimed = true`,
            [ip]
        );
        
        if (claimed.rows.length > 0) {
            return res.json({ 
                success: true, 
                hasGift: false, 
                alreadyClaimed: true,
                message: 'Вы уже получали подарок 🎁'
            });
        }
        
        // Проверяем, есть ли ожидающий подарок
        const pending = await pool.query(
            `SELECT * FROM gifts WHERE ip = $1 AND claimed = false`,
            [ip]
        );
        
        if (pending.rows.length > 0) {
            return res.json({ 
                success: true, 
                hasGift: true, 
                giftId: pending.rows[0].id,
                alreadyClaimed: false
            });
        }
        
        // Нет подарка — можно активировать
        res.json({ 
            success: true, 
            hasGift: false, 
            alreadyClaimed: false,
            canActivate: true 
        });
        
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

app.post('/api/gift/activate', async (req, res) => {
    const { ip, bungalow } = req.body;
    if (!ip) return res.json({ success: false, error: 'Нет IP' });
    
    try {
        const existing = await pool.query(
            `SELECT * FROM gifts WHERE ip = $1 AND claimed = true`,
            [ip]
        );
        if (existing.rows.length > 0) {
            return res.json({ success: false, message: 'Подарок уже получен' });
        }
        
        const pending = await pool.query(
            `SELECT * FROM gifts WHERE ip = $1 AND claimed = false`,
            [ip]
        );
        if (pending.rows.length > 0) {
            return res.json({ success: true, giftId: pending.rows[0].id });
        }
        
        const result = await pool.query(
            `INSERT INTO gifts (ip, bungalow) VALUES ($1, $2) RETURNING id`,
            [ip, bungalow || null]
        );
        res.json({ success: true, giftId: result.rows[0].id });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

app.post('/api/gift/claim', async (req, res) => {
    const { giftId } = req.body;
    if (!giftId) return res.json({ success: false, error: 'Нет ID' });
    
    try {
        await pool.query(
            `UPDATE gifts SET claimed = true, claimed_at = NOW() WHERE id = $1`,
            [giftId]
        );
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

app.get('/api/gift/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.json({ success: false, error: 'Неверный ID' });
    
    try {
        const result = await pool.query('SELECT * FROM gifts WHERE id = $1', [id]);
        if (result.rows.length === 0) {
            return res.json({ success: false, error: 'Подарок не найден' });
        }
        res.json({ success: true, gift: result.rows[0] });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

app.get('/api/gifts', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT * FROM gifts ORDER BY created_at DESC`
        );
        res.json({ gifts: result.rows });
    } catch (e) {
        res.json({ gifts: [], error: e.message });
    }
});

app.get('/api/gifts/stats', async (req, res) => {
    try {
        const total = await pool.query(`SELECT COUNT(*) FROM gifts`);
        const claimed = await pool.query(`SELECT COUNT(*) FROM gifts WHERE claimed = true`);
        const pending = await pool.query(`SELECT COUNT(*) FROM gifts WHERE claimed = false`);
        res.json({
            total: parseInt(total.rows[0].count),
            claimed: parseInt(claimed.rows[0].count),
            pending: parseInt(pending.rows[0].count)
        });
    } catch (e) {
        res.json({ total: 0, claimed: 0, pending: 0 });
    }
});

app.post('/api/gift/manual', async (req, res) => {
    const { ip, bungalow } = req.body;
    if (!ip) return res.json({ success: false, error: 'Нет IP' });
    
    try {
        const result = await pool.query(
            `INSERT INTO gifts (ip, bungalow) VALUES ($1, $2) RETURNING id`,
            [ip, bungalow || null]
        );
        res.json({ success: true, giftId: result.rows[0].id });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

app.post('/api/gift/reset-all', async (req, res) => {
    try {
        await pool.query('DELETE FROM gifts');
        console.log('🗑️ Все подарки сброшены!');
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

app.post('/api/gift/reset-ip', async (req, res) => {
    const { ip } = req.body;
    if (!ip) return res.json({ success: false, error: 'Нет IP' });
    
    try {
        await pool.query('DELETE FROM gifts WHERE ip = $1', [ip]);
        console.log(`🗑️ Сброшен подарок для IP: ${ip}`);
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

// ===== API: ЧАТЫ =====
app.get('/api/chats', async (req, res) => {
    try {
        const r = await pool.query('SELECT phone, data FROM chats');
        res.json({ chats: r.rows.map(row => ({ 
            phone: row.phone, 
            name: row.data?.name, 
            lastMessage: row.data?.messages?.slice(-1)[0], 
            unread: row.data?.unread || 0 
        })) });
    } catch (e) {
        res.json({ chats: [] });
    }
});

app.get('/api/chat-messages', async (req, res) => {
    try {
        const r = await pool.query('SELECT data FROM chats WHERE phone = $1', [req.query.phone]);
        res.json({ success: true, messages: r.rows[0]?.data?.messages || [] });
    } catch (e) {
        res.json({ success: true, messages: [] });
    }
});

app.post('/api/chat-send', async (req, res) => {
    const { phone, text, from, name } = req.body;
    if (!phone || !text) return res.json({ success: false });
    try {
        const exist = await pool.query('SELECT data FROM chats WHERE phone = $1', [phone]);
        let data = exist.rows[0]?.data || { name: name || 'Клиент', messages: [], unread: 0 };
        data.messages.push({ text, from: from || 'client', time: new Date().toISOString() });
        data.unread = from === 'client' ? (data.unread || 0) + 1 : 0;
        if (name) data.name = name;
        await pool.query('INSERT INTO chats (phone, data) VALUES ($1, $2) ON CONFLICT (phone) DO UPDATE SET data = $2', [phone, JSON.stringify(data)]);
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

app.post('/api/chat-read', async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.json({ success: false });
    try {
        const exist = await pool.query('SELECT data FROM chats WHERE phone = $1', [phone]);
        if (exist.rows.length > 0) {
            let data = exist.rows[0].data;
            data.unread = 0;
            await pool.query('UPDATE chats SET data = $1 WHERE phone = $2', [JSON.stringify(data), phone]);
        }
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false });
    }
});

app.post('/api/delete-chat', async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.json({ success: false });
    try {
        await pool.query('DELETE FROM chats WHERE phone = $1', [phone]);
        res.json({ success: true });
    } catch(e) {
        res.json({ success: false, error: e.message });
    }
});

// ===== API: ОТЗЫВЫ =====
app.get('/api/reviews', async (req, res) => {
    try {
        const r = await pool.query('SELECT data FROM reviews ORDER BY created_at DESC');
        res.json({ success: true, reviews: r.rows.map(r => r.data) });
    } catch (e) {
        res.json({ success: true, reviews: [] });
    }
});

app.post('/api/review', async (req, res) => {
    const { orderId, name, phone, rating, text } = req.body;
    if (!orderId || !rating || !text) return res.json({ success: false, error: 'Нет данных' });
    try {
        const review = { 
            id: Date.now(), 
            orderId, 
            name, 
            phone, 
            rating: Math.min(5, Math.max(1, rating)), 
            text: text.trim(), 
            createdAt: new Date().toISOString() 
        };
        await pool.query('INSERT INTO reviews (data) VALUES ($1)', [JSON.stringify(review)]);
        await pool.query("UPDATE orders SET data = jsonb_set(data, '{reviewed}', 'true') WHERE id = $1", [orderId]);
        res.json({ success: true, review });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

app.delete('/api/review/:id', async (req, res) => {
    try {
        await pool.query("DELETE FROM reviews WHERE data->>'id' = $1", [req.params.id]);
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

// ===== IP ДЛЯ КЛИЕНТА =====
app.get('/api/my-ip', (req, res) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const cleanIp = ip ? ip.split(',')[0].trim() : 'unknown';
    res.json({ ip: cleanIp });
});

// ================================================================
// ===== API: BARISTA (AI-ПОМОЩНИК) =====
// ================================================================

const BARISTA_MENU = [
    { id: '1', name: 'Классика', desc: 'Клубника в молочном шоколаде', price: 450, badge: '🔥 Хит' },
    { id: '2', name: 'Клубника в сливках', desc: 'Нежная клубника в бельгийских сливках', price: 450, badge: '⭐' },
    { id: '9', name: 'Клубника в сливках и шоколаде', desc: 'Нежная клубника в сливках и шоколаде', price: 450, badge: '🔥 Хит' },
    { id: '4', name: 'Микс клубника-банан', desc: 'Клубника и банан в шоколаде', price: 450 },
    { id: '5', name: 'Банан в шоколаде', desc: 'Спелый банан в молочном шоколаде', price: 450 },
    { id: '16', name: 'Клубника в стакане', desc: 'Свежая клубника без шоколада', price: 350 }
];

const BARISTA_PROMO = [
    '🍓 При заказе 2+ стаканчиков — скидка 10%',
    '🎁 Бесплатная мини-порция для первых посетителей',
    '❤️ Для постоянных клиентов — подарок'
];

const BARISTA_SYSTEM_PROMPT = `Ты — Клубничный Бариста 🍓 в кафе "Strawberry in Chocolate" на пляже.

ТВОИ ДАННЫЕ:
Меню:
${BARISTA_MENU.map(i => `- ${i.name}: ${i.price} ₽ (${i.desc})${i.badge ? ' ' + i.badge : ''}`).join('\n')}

Акции:
${BARISTA_PROMO.map(p => `- ${p}`).join('\n')}

ТВОЯ РОЛЬ:
1. Ты работаешь в кафе, общаешься с гостями
2. Ты знаешь ВСЁ о меню, ценах, акциях
3. Ты УМЕЕШЬ ИСКАТЬ БЛИЖАЙШИЕ МАГАЗИНЫ, КАФЕ, АПТЕКИ, ГОСТИНИЦЫ и строить МАРШРУТЫ
4. Ты дружелюбный и весёлый помощник
5. Ты НЕ предлагаешь клубнику, если не спрашивают о ней

ПРАВИЛА:
- Отвечай ТОЛЬКО на русском
- Будь коротким и полезным (2-4 предложения)
- Используй эмодзи 🍓🍫😊🌊
- НА ЛЮБЫЕ ВОПРОСЫ ОТВЕЧАЙ ДРУЖЕЛЮБНО И ПОМОЩНО
- ЕСЛИ СПРАШИВАЮТ НЕ ПРО КЛУБНИКУ — НЕ ПРЕДЛАГАЙ ЕЁ

КАК ИСКАТЬ ТОЧКИ:
Если гость спрашивает "где купить воду", "ближайший магазин", "аптека", "кафе", "гостиница" — ты можешь найти это через карту.

ОТВЕЧАЙ ТАК:
1. Сначала подтверди, что ищешь: "Сейчас посмотрю на карте! 🔍"
2. Затем напиши, что нашёл: "Ближайший магазин — 50 метров налево 🏪"
3. Предложи показать на карте: "Хотите, покажу на карте? Нажмите на маркер!"

ГЛАВНОЕ: Ты — дружелюбный бариста, который умеет поддержать разговор и помочь с любым вопросом! НЕ НАВЯЗЫВАЙ КЛУБНИКУ!`;

app.post('/api/barista', async (req, res) => {
    const { message, history } = req.body;
    
    const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
    if (!DEEPSEEK_API_KEY) {
        return res.status(500).json({ error: 'API ключ не настроен на сервере' });
    }
    
    try {
        const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
            },
            body: JSON.stringify({
                model: 'deepseek-chat',
                messages: [
                    { role: 'system', content: BARISTA_SYSTEM_PROMPT },
                    ...(history || []).slice(-10),
                    { role: 'user', content: message }
                ],
                temperature: 0.85,
                max_tokens: 300
            })
        });
        
        const data = await response.json();
        
        if (data.error) {
            console.error('DeepSeek API Error:', data.error);
            return res.status(500).json({ error: data.error.message });
        }
        
        res.json(data);
    } catch (error) {
        console.error('Barista Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ================================================================
// ===== API: ПОИСК БЛИЖАЙШИХ ТОЧЕК ЧЕРЕЗ ЯНДЕКС КАРТЫ =====
// ================================================================

app.post('/api/nearby-places', async (req, res) => {
    const { lat, lng, query } = req.body;
    
    if (!lat || !lng) {
        return res.status(400).json({ error: 'Нет координат' });
    }
    
    const YANDEX_API_KEY = process.env.YANDEX_MAPS_API_KEY || '7aafdf73-bf1e-4ec7-8d18-07b14be93c80';
    
    try {
        // Определяем категорию поиска
        let searchQuery = 'магазин';
        const lowerQuery = (query || '').toLowerCase();
        if (lowerQuery.includes('аптек')) searchQuery = 'аптека';
        else if (lowerQuery.includes('кафе') || lowerQuery.includes('еда') || lowerQuery.includes('ресторан')) searchQuery = 'кафе';
        else if (lowerQuery.includes('гостиниц') || lowerQuery.includes('отель')) searchQuery = 'гостиница';
        else if (lowerQuery.includes('туалет')) searchQuery = 'туалет';
        else if (lowerQuery.includes('парк')) searchQuery = 'парк';
        else if (lowerQuery.includes('пляж')) searchQuery = 'пляж';
        else if (lowerQuery.includes('вод') || lowerQuery.includes('пить')) searchQuery = 'магазин';
        
        // Ищем через Geocoder API Яндекс.Карт
        const url = `https://geocode-maps.yandex.ru/1.x/?apikey=${YANDEX_API_KEY}&geocode=${searchQuery}&ll=${lng},${lat}&spn=0.005,0.005&rspn=1&format=json&results=5`;
        
        console.log(`🔍 Поиск "${searchQuery}" по координатам: ${lat}, ${lng}`);
        
        const response = await fetch(url);
        const data = await response.json();
        
        const featureMember = data.response.GeoObjectCollection.featureMember || [];
        
        const places = featureMember.map(item => {
            const geo = item.GeoObject;
            const coords = geo.Point.pos.split(' ').map(Number);
            const name = geo.name || searchQuery;
            const address = geo.description || geo.name || 'Адрес не указан';
            return {
                name: name,
                address: address,
                lat: coords[1],
                lng: coords[0],
                distance: getDistance(lat, lng, coords[1], coords[0])
            };
        }).filter(p => p.distance < 2).sort((a, b) => a.distance - b.distance);
        
        res.json({ success: true, places: places.slice(0, 5) });
    } catch (error) {
        console.error('Ошибка поиска:', error);
        res.status(500).json({ error: error.message });
    }
});

function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}

// ===== QR-КОД =====
app.get('/generate-qr', (req, res) => {
    const bungalow = req.query.b || 1;
    const duration = req.query.d || settings.sessionDuration || 420;
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const activateUrl = `${baseUrl}/activate?b=${bungalow}&d=${duration}`;
    const durH = Math.floor(duration / 60), durM = duration % 60;
    const durText = durH > 0 ? `${durH}ч ${durM}мин` : `${durM}мин`;
    
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>QR #${bungalow}</title><script src="https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js"></script><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;background:linear-gradient(135deg,#FFF5F5,#FFE8EC);padding:20px}.qr-card{background:#fff;padding:30px;border-radius:24px;box-shadow:0 20px 60px rgba(255,71,87,0.15);text-align:center;max-width:400px;width:100%}.qr-card h2{color:#FF4757;font-size:28px;margin-bottom:8px;font-weight:800}.subtitle{color:#6B7280;margin-bottom:20px;font-size:14px}#qrcode{display:flex;justify-content:center;margin:20px 0;padding:20px;background:#fff;border-radius:16px;border:2px dashed #FFE0B2}.info-box{background:#FFF8E1;padding:16px;border-radius:16px;margin:15px 0;border:1px solid #FFE0B2}.duration{font-size:32px;font-weight:800;color:#FF4757}.label{font-size:13px;color:#6B7280;margin-top:4px}.activate-btn{display:inline-block;background:linear-gradient(135deg,#FF4757,#E63946);color:#fff;padding:16px 32px;border-radius:100px;text-decoration:none;font-weight:700;font-size:16px;margin-top:15px;box-shadow:0 6px 20px rgba(255,71,87,0.3)}.url-display{background:#F8FAFC;padding:12px;border-radius:12px;margin-top:15px;font-size:11px;word-break:break-all;color:#9CA3AF;font-family:monospace}.warning{color:#EF4444;font-size:13px;margin-top:15px;padding:10px;background:#FEF2F2;border-radius:12px}.schedule{font-size:13px;color:#6B7280;margin-top:12px}</style></head><body><div class="qr-card"><h2>🏖️ Бунгало #${bungalow}</h2><p class="subtitle">Отсканируйте для заказа 🍓</p><div id="qrcode"></div><div class="info-box"><div class="duration">⏱️ ${durText}</div><div class="label">Сессия после сканирования</div></div><a href="${activateUrl}" class="activate-btn">🍓 Открыть меню</a><p class="schedule">🕐 Доставка: 9:00-20:00<br>🏪 Киоск: 9:00-6:00</p><div class="warning">⚠️ После истечения — повторное сканирование</div><div class="url-display">${activateUrl}</div></div><script>new QRCode(document.getElementById("qrcode"),{text:"${activateUrl}",width:250,height:250,colorDark:"#FF4757",colorLight:"#FFFFFF",correctLevel:QRCode.CorrectLevel.H})</script></body></html>`);
});

// ===== АКТИВАЦИЯ =====
app.get('/activate', async (req, res) => {
    const b = parseInt(req.query.b);
    const d = parseInt(req.query.d) || settings.sessionDuration || 420;
    if (!b || b <= 0) return res.send('<h1>❌ Неверный номер бунгало</h1>');
    const exp = Date.now() + (d * 60 * 1000);
    await pool.query('INSERT INTO sessions (bungalow, data, expires_at) VALUES ($1,$2,$3) ON CONFLICT (bungalow) DO UPDATE SET expires_at=$3', [b, JSON.stringify({ bungalow: b }), exp]);
    res.redirect(`/?b=${b}`);
});

// ===== ОЧИСТКА СЕССИЙ =====
setInterval(async () => {
    await pool.query('DELETE FROM sessions WHERE expires_at < $1', [Date.now()]).catch(() => {});
}, 30000);

// ================================================================
// ===== ЗАПУСК СЕРВЕРА С WEBSOCKET =====
// ================================================================

const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: '*' }
});

// ===== WEBSOCKET: ПОДКЛЮЧЕНИЯ =====
io.on('connection', (socket) => {
    console.log('📡 Новое подключение:', socket.id);

    // Админ подключается
    socket.on('admin-join', () => {
        socket.join('admin-room');
        console.log('👨‍💼 Админ подключен к уведомлениям');
        socket.emit('admin-connected', { status: 'ok' });
    });

    socket.on('disconnect', () => {
        console.log('🔌 Отключение:', socket.id);
    });
});

// ===== СТАРТ =====
(async () => {
    await initDB();
    await loadSettings();
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, '0.0.0.0', () => {
        const endHour = WORK_HOURS.end > 24 ? WORK_HOURS.end - 24 : WORK_HOURS.end;
        console.log(`🍓 Сервер на порту ${PORT} | БД подключена | ${WORK_HOURS.start}:00-${endHour}:00`);
        console.log('📨 Авто-уведомления о задержке включены (15 минут)');
        console.log('📍 Геолокация клиентов сохраняется в заказах');
        console.log('🎁 Система подарков (gifts) активирована!');
        console.log('📷 QR-сканер подарков доступен в админке');
        console.log('👨‍💼 WebSocket уведомления для админа активны');
        console.log('📊 Статистика доступна по /api/stats');
        console.log('📤 Экспорт заказов: /api/export-orders');
        console.log('🍓 Клубничный Бариста (AI) активирован!');
        console.log('🗺️ Поиск точек через Яндекс.Карты активирован!');
    });
})();