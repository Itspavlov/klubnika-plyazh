// ================================================================
// ===== server/treasure.js — ВСЯ ЛОГИКА КЛАДА =====
// ================================================================

const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// ===== СОСТОЯНИЕ КЛАДА (В ПАМЯТИ) =====
let treasureState = {
    active: false,
    lat: null,
    lng: null,
    radius: 15,
    startTime: null,
    winner: null,
    winnerName: null,
    winnerPhone: null,
    ended: false
};

// ===== АКТИВНЫЕ ПОЛЬЗОВАТЕЛИ (В ПАМЯТИ) =====
const activeUsers = new Map();

// ================================================================
// ===== ОСНОВНЫЕ ФУНКЦИИ =====
// ================================================================

function activateTreasure(lat, lng, radius = 15) {
    if (treasureState.active) {
        return { success: false, message: '❌ Клад уже активен!' };
    }

    treasureState = {
        active: true,
        lat: lat,
        lng: lng,
        radius: radius,
        startTime: Date.now(),
        winner: null,
        winnerName: null,
        winnerPhone: null,
        ended: false
    };

    console.log(`🎯 КЛАД АКТИВИРОВАН! Координаты: ${lat}, ${lng}`);
    return { success: true, message: '✅ Клад активирован!', treasure: treasureState };
}

function deactivateTreasure() {
    if (!treasureState.active) {
        return { success: false, message: '❌ Клад не активен' };
    }
    treasureState.active = false;
    treasureState.ended = true;
    console.log('⏹️ Клад деактивирован');
    return { success: true, message: '✅ Клад деактивирован' };
}

function getTreasureStatus() {
    return {
        active: treasureState.active,
        lat: treasureState.lat,
        lng: treasureState.lng,
        radius: treasureState.radius,
        startTime: treasureState.startTime,
        winner: treasureState.winner,
        winnerName: treasureState.winnerName,
        winnerPhone: treasureState.winnerPhone,
        ended: treasureState.ended,
        usersInZone: getUsersInZone()
    };
}

function getUsersInZone() {
    if (!treasureState.active) return [];
    const inZone = [];
    for (const [userId, user] of activeUsers) {
        const distance = getDistance(user.lat, user.lng, treasureState.lat, treasureState.lng);
        if (distance <= treasureState.radius) {
            inZone.push({ userId, ...user, distance });
        }
    }
    return inZone;
}

function checkUserInZone(userId) {
    if (!treasureState.active) return null;
    const user = activeUsers.get(userId);
    if (!user) return null;
    const distance = getDistance(user.lat, user.lng, treasureState.lat, treasureState.lng);
    return { inZone: distance <= treasureState.radius, distance: distance };
}

async function declareWinner(userId, io) {
    if (!treasureState.active) {
        return { success: false, message: '❌ Клад не активен' };
    }
    if (treasureState.winner) {
        return { success: false, message: '❌ Победитель уже есть' };
    }

    const user = activeUsers.get(userId);
    if (!user) {
        return { success: false, message: '❌ Пользователь не найден' };
    }

    treasureState.winner = userId;
    treasureState.winnerName = user.name || 'Клиент';
    treasureState.winnerPhone = user.phone || 'не указан';
    treasureState.active = false;
    treasureState.ended = true;

    await saveWinnerToDB(userId, user.name, user.phone, user.lat, user.lng);

    console.log(`🏆 ПОБЕДИТЕЛЬ: ${user.name || userId}`);

    if (io) {
        io.to(user.socketId).emit('you-won', {
            message: '🎉🏆 ТЫ ПОБЕДИЛ!',
            prize: 'МЕГА-СТАКАН клубники в шоколаде',
            name: user.name || 'Клиент'
        });
        io.emit('treasure-claimed', {
            winner: user.name || 'Кто-то',
            message: '😢 Клад уже нашли! Попробуй завтра!'
        });
    }

    return { 
        success: true, 
        message: '🏆 Победитель объявлен!',
        winner: { id: userId, name: user.name || 'Клиент', phone: user.phone || 'не указан' }
    };
}

function updateUserLocation(userId, lat, lng, socketId, name, phone) {
    if (activeUsers.has(userId)) {
        const user = activeUsers.get(userId);
        user.lat = lat;
        user.lng = lng;
        user.socketId = socketId || user.socketId;
        if (name) user.name = name;
        if (phone) user.phone = phone;
    } else {
        activeUsers.set(userId, {
            lat: lat,
            lng: lng,
            socketId: socketId,
            name: name || 'Клиент',
            phone: phone || null,
            joinedAt: Date.now()
        });
    }

    if (treasureState.active) {
        const result = checkUserInZone(userId);
        if (result && result.inZone) {
            return { winner: true, userId: userId, distance: result.distance };
        }
        return { winner: false, distance: result ? result.distance : null };
    }
    return { winner: false };
}

function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c * 1000;
}

async function saveWinnerToDB(userId, name, phone, lat, lng) {
    try {
        await pool.query(
            `INSERT INTO treasure (user_id, name, phone, lat, lng, prize, claimed_at) 
             VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
            [userId, name || 'Клиент', phone || null, lat, lng, 'МЕГА-СТАКАН клубники в шоколаде']
        );
        console.log(`💾 Победитель сохранён в БД: ${name || userId}`);
    } catch (err) {
        console.error('❌ Ошибка сохранения победителя:', err.message);
    }
}

async function getWinnersHistory(limit = 20) {
    try {
        const result = await pool.query(
            `SELECT * FROM treasure ORDER BY claimed_at DESC LIMIT $1`,
            [limit]
        );
        return result.rows;
    } catch (err) {
        console.error('❌ Ошибка получения истории:', err.message);
        return [];
    }
}

async function clearWinnersHistory() {
    try {
        await pool.query('DELETE FROM treasure');
        console.log('🗑️ История победителей очищена');
        return { success: true };
    } catch (err) {
        console.error('❌ Ошибка очистки истории:', err.message);
        return { success: false, error: err.message };
    }
}

module.exports = {
    treasureState,
    activeUsers,
    activateTreasure,
    deactivateTreasure,
    getTreasureStatus,
    getUsersInZone,
    checkUserInZone,
    declareWinner,
    updateUserLocation,
    getDistance,
    saveWinnerToDB,
    getWinnersHistory,
    clearWinnersHistory
};