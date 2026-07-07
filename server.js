const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const WORK_HOURS = { start: 9, end: 28 };

let settings = { technicalBreak: false, menuItems: {}, sessionDuration: 420 };

async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value JSONB);
            CREATE TABLE IF NOT EXISTS orders (id SERIAL PRIMARY KEY, data JSONB, status TEXT DEFAULT 'ожидает', created_at TIMESTAMPTZ DEFAULT NOW());
            CREATE TABLE IF NOT EXISTS sessions (bungalow INTEGER PRIMARY KEY, data JSONB, expires_at BIGINT);
            CREATE TABLE IF NOT EXISTS chats (phone TEXT PRIMARY KEY, data JSONB);
            CREATE TABLE IF NOT EXISTS reviews (id SERIAL PRIMARY KEY, data JSONB, created_at TIMESTAMPTZ DEFAULT NOW());
        `);
        console.log('📦 Таблицы готовы');
    } catch (e) { console.error(e.message); }
}

function generateCode() { return Math.floor(1000 + Math.random() * 9000).toString(); }

async function loadSettings() {
    try {
        const r = await pool.query("SELECT value FROM settings WHERE key = 'main'");
        if (r.rows.length > 0) settings = r.rows[0].value;
        else await saveSettings();
    } catch (e) {}
}

async function saveSettings() {
    await pool.query("INSERT INTO settings (key, value) VALUES ('main', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [JSON.stringify(settings)]).catch(() => {});
}

function isWorkingTime() {
    const now = new Date();
    let msk;
    try { msk = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Moscow' })); } catch (e) { msk = now; }
    const h = msk.getHours(), m = msk.getMinutes();
    const cur = h * 60 + m, start = WORK_HOURS.start * 60, end = WORK_HOURS.end * 60;
    return (cur < start ? cur + 24*60 : cur) >= start && (cur < start ? cur + 24*60 : cur) < end;
}

app.use((req, res, next) => { console.log(`📨 ${req.method} ${req.url}`); next(); });

app.get('/', async (req, res, next) => {
    const b = parseInt(req.query.b);
    if (b && b > 0) {
        try {
            const ex = await pool.query('SELECT * FROM sessions WHERE bungalow = $1 AND expires_at > $2', [b, Date.now()]);
            if (ex.rows.length === 0) {
                const exp = Date.now() + (settings.sessionDuration || 420) * 60 * 1000;
                await pool.query('INSERT INTO sessions (bungalow, data, expires_at) VALUES ($1,$2,$3) ON CONFLICT (bungalow) DO UPDATE SET expires_at=$3', [b, JSON.stringify({bungalow:b}), exp]);
                console.log(`✅ Авто-активация #${b}`);
            }
        } catch (e) {}
    }
    next();
});

app.use(express.static('.'));

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

app.get('/api/check-session', async (req, res) => {
    const b = parseInt(req.query.b);
    if (!b || b <= 0) return res.json({ valid: false });
    try {
        const r = await pool.query('SELECT * FROM sessions WHERE bungalow = $1', [b]);
        if (r.rows.length === 0) return res.json({ valid: false });
        if (Date.now() > r.rows[0].expires_at) { await pool.query('DELETE FROM sessions WHERE bungalow = $1', [b]); return res.json({ valid: false }); }
        res.json({ valid: true, bungalow: b, expiresAt: r.rows[0].expires_at });
    } catch (e) { res.json({ valid: false }); }
});

app.get('/api/activate-session', async (req, res) => {
    const b = parseInt(req.query.b), d = parseInt(req.query.d) || 420;
    if (!b || b <= 0) return res.json({ success: false });
    const exp = Date.now() + d * 60 * 1000;
    await pool.query('INSERT INTO sessions (bungalow, data, expires_at) VALUES ($1,$2,$3) ON CONFLICT (bungalow) DO UPDATE SET expires_at=$3', [b, JSON.stringify({bungalow:b}), exp]);
    res.json({ success: true });
});

app.post('/api/order', async (req, res) => {
    if (settings.technicalBreak) return res.json({ success: false, error: '🔧 Перерыв' });
    if (!isWorkingTime()) return res.json({ success: false, error: '🔒 Закрыто' });
    const order = req.body;
    if (order.bungalow) {
        const s = await pool.query('SELECT * FROM sessions WHERE bungalow = $1', [order.bungalow]);
        if (s.rows.length === 0 || Date.now() > s.rows[0].expires_at) return res.json({ success: false, error: '❌ Сессия' });
    }
    const ex = await pool.query("SELECT id FROM orders WHERE data->>'customerPhone' = $1 AND status = 'ожидает'", [order.customerPhone]);
    if (ex.rows.length > 0) return res.json({ success: false, error: '⚠️ Активный заказ уже есть' });
    const code = generateCode();
    try {
        const r = await pool.query("INSERT INTO orders (data, status) VALUES ($1, 'ожидает') RETURNING id", [JSON.stringify({...order, confirmCode: code})]);
        console.log(`🍓 Заказ #${r.rows[0].id} | ${order.total} ₽`);
        res.json({ success: true, orderId: r.rows[0].id, confirmCode: code });
    } catch (e) { res.json({ success: false, error: 'Ошибка' }); }
});

app.post('/api/my-orders', async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.json({ success: false });
    const r = await pool.query("SELECT id, data, status, created_at FROM orders WHERE data->>'customerPhone' = $1 ORDER BY created_at DESC", [phone]);
    res.json({ success: true, orders: r.rows.map(row => ({ id: row.id, ...row.data, status: row.status, createdAt: row.created_at })) });
});

app.post('/api/cancel-order', async (req, res) => {
    const { orderId, phone } = req.body;
    const r = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
    if (r.rows.length === 0) return res.json({ success: false });
    if (r.rows[0].data.customerPhone !== phone) return res.json({ success: false });
    await pool.query("UPDATE orders SET status = 'отменен' WHERE id = $1", [orderId]);
    res.json({ success: true });
});

app.post('/api/confirm', async (req, res) => {
    const { orderId, code } = req.body;
    const r = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
    if (r.rows.length === 0) return res.json({ success: false });
    if (r.rows[0].data.confirmCode !== code) return res.json({ success: false, error: 'Неверный код' });
    await pool.query("UPDATE orders SET status = 'выполнен' WHERE id = $1", [orderId]);
    res.json({ success: true });
});

app.post('/api/cancel', async (req, res) => {
    await pool.query("UPDATE orders SET status = 'отменен' WHERE id = $1", [req.body.orderId]);
    res.json({ success: true });
});

app.get('/api/orders', async (req, res) => {
    const r = await pool.query('SELECT id, data, status, created_at FROM orders ORDER BY created_at DESC');
    res.json(r.rows.map(row => ({ id: row.id, ...row.data, status: row.status, createdAt: row.created_at })));
});

app.post('/api/clear-orders', async (req, res) => {
    await pool.query('DELETE FROM orders');
    res.json({ success: true });
});

setInterval(async () => {
    await pool.query("UPDATE orders SET status = 'отменен (таймаут)' WHERE status = 'ожидает' AND created_at < NOW() - INTERVAL '15 minutes'").catch(() => {});
}, 60000);

// ===== ЧАТЫ =====
app.get('/api/chats', async (req, res) => {
    const r = await pool.query('SELECT phone, data FROM chats');
    res.json({ chats: r.rows.map(row => ({ phone: row.phone, name: row.data?.name, lastMessage: row.data?.messages?.slice(-1)[0], unread: row.data?.unread || 0 })) });
});

app.get('/api/chat-messages', async (req, res) => {
    const r = await pool.query('SELECT data FROM chats WHERE phone = $1', [req.query.phone]);
    res.json({ success: true, messages: r.rows[0]?.data?.messages || [] });
});

app.post('/api/chat-send', async (req, res) => {
    const { phone, text, from, name } = req.body;
    if (!phone || !text) return res.json({ success: false });
    const ex = await pool.query('SELECT data FROM chats WHERE phone = $1', [phone]);
    let data = ex.rows[0]?.data || { name: name || 'Клиент', messages: [], unread: 0 };
    data.messages.push({ text, from: from || 'client', time: new Date().toISOString() });
    data.unread = from === 'client' ? (data.unread || 0) + 1 : 0;
    if (name) data.name = name;
    await pool.query('INSERT INTO chats (phone, data) VALUES ($1,$2) ON CONFLICT (phone) DO UPDATE SET data=$2', [phone, JSON.stringify(data)]);
    res.json({ success: true });
});

app.post('/api/chat-read', async (req, res) => {
    const { phone } = req.body;
    if (phone) {
        try {
            const ex = await pool.query('SELECT data FROM chats WHERE phone = $1', [phone]);
            if (ex.rows[0]) {
                let data = ex.rows[0].data;
                data.unread = 0;
                await pool.query('UPDATE chats SET data = $1 WHERE phone = $2', [JSON.stringify(data), phone]);
            }
        } catch (e) {}
    }
    res.json({ success: true });
});

// ===== ОТЗЫВЫ =====
app.get('/api/reviews', async (req, res) => {
    const r = await pool.query('SELECT data FROM reviews ORDER BY created_at DESC');
    res.json({ success: true, reviews: r.rows.map(r => r.data) });
});

app.post('/api/review', async (req, res) => {
    const { orderId, name, phone, rating, text } = req.body;
    if (!orderId || !rating) return res.json({ success: false });
    const review = { id: Date.now(), orderId, name, phone, rating: Math.min(5, Math.max(1, rating)), text: (text || '').trim(), createdAt: new Date().toISOString() };
    await pool.query('INSERT INTO reviews (data) VALUES ($1)', [JSON.stringify(review)]);
    await pool.query("UPDATE orders SET data = jsonb_set(data, '{reviewed}', 'true') WHERE id = $1", [orderId]);
    res.json({ success: true, review });
});

app.delete('/api/review/:id', async (req, res) => {
    await pool.query("DELETE FROM reviews WHERE data->>'id' = $1", [req.params.id]);
    res.json({ success: true });
});

// ===== QR / ACTIVATE =====
app.get('/generate-qr', (req, res) => {
    const b = req.query.b || 1, d = req.query.d || 420;
    const url = `${req.protocol}://${req.get('host')}/activate?b=${b}&d=${d}`;
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>QR #${b}</title><script src="https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js"></script><style>*{margin:0;padding:0}body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;background:linear-gradient(135deg,#FFF5F5,#FFE8EC)}.qr-card{background:#fff;padding:30px;border-radius:24px;text-align:center;box-shadow:0 20px 60px rgba(255,71,87,.15)}h2{color:#FF4757}#qrcode{margin:20px 0;padding:20px;background:#fff;border-radius:16px;border:2px dashed #FFE0B2;display:inline-block}a{display:inline-block;background:linear-gradient(135deg,#FF4757,#E63946);color:#fff;padding:16px 32px;border-radius:100px;text-decoration:none;font-weight:700;margin-top:15px}</style></head><body><div class="qr-card"><h2>🏖️ Бунгало #${b}</h2><div id="qrcode"></div><a href="${url}">🍓 Открыть</a></div><script>new QRCode(document.getElementById("qrcode"),{text:"${url}",width:250,height:250,colorDark:"#FF4757",colorLight:"#FFFFFF"})</script></body></html>`);
});

app.get('/activate', async (req, res) => {
    const b = parseInt(req.query.b), d = parseInt(req.query.d) || 420;
    if (!b) return res.send('<h1>❌ Ошибка</h1>');
    await pool.query('INSERT INTO sessions (bungalow, data, expires_at) VALUES ($1,$2,$3) ON CONFLICT (bungalow) DO UPDATE SET expires_at=$3', [b, JSON.stringify({bungalow:b}), Date.now()+d*60*1000]);
    res.redirect(`/?b=${b}`);
});

setInterval(async () => { await pool.query('DELETE FROM sessions WHERE expires_at < $1', [Date.now()]).catch(() => {}); }, 30000);

(async () => {
    await initDB();
    await loadSettings();
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, '0.0.0.0', () => console.log(`🍓 Сервер:${PORT} | БД`));
})();