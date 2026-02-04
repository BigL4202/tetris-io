// --- IMPORTS & SETUP ---
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const fs = require('fs');

app.use(express.static(path.join(__dirname, 'public')));

// --- DATA STORAGE ---
const DATA_FILE = path.join(__dirname, 'accounts.json');
let accounts = {}; 

function loadAccounts() {
    try {
        if (fs.existsSync(DATA_FILE)) accounts = JSON.parse(fs.readFileSync(DATA_FILE));
    } catch (err) { accounts = {}; }
}
function saveAccounts() {
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(accounts, null, 2)); } catch (err) {}
}
loadAccounts();

// --- GAME STATE ---
// Robust Lobby Object
let ffaLobby = {
    players: [],      // { id, username, alive, damageLog }
    state: 'waiting', // waiting, countdown, playing, finished
    seed: 12345,
    matchStats: [],
    startTime: 0,
    timer: null
};

// --- SOCKET CONNECTION ---
io.on('connection', (socket) => {
    
    // CHAT
    socket.on('send_chat', (msg) => {
        const cleanMsg = msg.replace(/</g, "&lt;").replace(/>/g, "&gt;").substring(0, 50);
        const name = socket.username || "Anon";
        // Only send to people in the FFA room if playing, or global otherwise
        if (socket.rooms.has('lobby_ffa')) io.to('lobby_ffa').emit('receive_chat', { user: name, text: cleanMsg });
        else io.emit('receive_chat', { user: name, text: cleanMsg });
    });

    // LOGIN
    socket.on('login_attempt', (data) => {
        const user = data.username.trim().substring(0, 12);
        const pass = data.password.trim();
        if (!user || !pass) return socket.emit('login_response', { success: false, msg: "Enter user & pass." });

        if (!accounts[user]) {
            accounts[user] = { password: pass, wins: 0, bestAPM: 0, bestCombo: 0, history: [] };
            saveAccounts();
        } else if (accounts[user].password !== pass) {
            return socket.emit('login_response', { success: false, msg: "Incorrect Password!" });
        }

        socket.username = user;
        socket.emit('login_response', { 
            success: true, 
            username: user, 
            wins: accounts[user].wins, 
            bestAPM: accounts[user].bestAPM || 0 
        });
        io.emit('leaderboard_update', getLeaderboards());
    });

    // STATS
    socket.on('request_all_stats', () => {
        const safeData = {};
        for (const [key, val] of Object.entries(accounts)) {
            safeData[key] = { wins: val.wins, bestAPM: val.bestAPM, bestCombo: val.bestCombo || 0, history: val.history || [] };
        }
        socket.emit('receive_all_stats', safeData);
    });

    socket.on('submit_apm', (val) => {
        if (!socket.username) return;
        const score = parseInt(val) || 0;
        if (accounts[socket.username] && score > (accounts[socket.username].bestAPM || 0)) {
            accounts[socket.username].bestAPM = score;
            saveAccounts();
            socket.emit('update_my_apm', score);
        }
    });

    // --- LOBBY MANAGEMENT ---
    
    // 1. Leave Logic (Async to prevent race conditions)
    async function leaveFFA() {
        const idx = ffaLobby.players.findIndex(p => p.id === socket.id);
        if (idx !== -1) {
            const p = ffaLobby.players[idx];
            ffaLobby.players.splice(idx, 1);
            await socket.leave('lobby_ffa');
            
            io.to('lobby_ffa').emit('lobby_update', { count: ffaLobby.players.length });
            
            // If playing, mark as dead so game can end
            if (ffaLobby.state === 'playing' && p.alive) {
                io.to('lobby_ffa').emit('elimination', { username: p.username, killer: "Disconnect" });
                checkWinCondition();
            }
            
            // If lobby emptied during countdown, reset
            if (ffaLobby.players.length < 2 && ffaLobby.state === 'countdown') {
                ffaLobby.state = 'waiting';
                clearTimeout(ffaLobby.timer);
                io.to('lobby_ffa').emit('lobby_reset');
            }
        }
    }

    socket.on('leave_lobby', () => { leaveFFA(); });
    socket.on('disconnect', () => { leaveFFA(); });

    // 2. Join Logic
    socket.on('join_ffa', async () => {
        if (!socket.username) return;
        
        // Ensure strictly removed from previous state
        await leaveFFA(); 
        
        await socket.join('lobby_ffa');
        const pData = { id: socket.id, username: socket.username, alive: true, damageLog: [] };
        ffaLobby.players.push(pData);

        if (ffaLobby.state === 'waiting' || ffaLobby.state === 'finished') {
            io.to('lobby_ffa').emit('lobby_update', { count: ffaLobby.players.length });
            tryStartGame();
        } else {
            // Spectator Join
            pData.alive = false;
            const living = ffaLobby.players.filter(p => p.alive).map(p => ({ id: p.id, username: p.username }));
            socket.emit('ffa_spectate', { seed: ffaLobby.seed, players: living });
        }
    });

    // --- GAMEPLAY EVENTS ---
    socket.on('update_board', (grid) => {
        socket.to('lobby_ffa').emit('enemy_board_update', { id: socket.id, grid: grid });
    });

    socket.on('send_garbage', (data) => {
        if (ffaLobby.state === 'playing') {
            const sender = ffaLobby.players.find(p => p.id === socket.id);
            if (!sender || !sender.alive) return;

            const targets = ffaLobby.players.filter(p => p.alive && p.id !== socket.id);
            if (targets.length > 0) {
                let split = Math.floor(data.amount / targets.length);
                if (data.amount >= 4 && split === 0) split = 1;
                
                if (split > 0) {
                    targets.forEach(t => {
                        // Log damage for Smart Kill Feed
                        t.damageLog.push({ attacker: sender.username, amount: split, time: Date.now() });
                        io.to(t.id).emit('receive_garbage', split);
                    });
                }
            }
        }
    });

    socket.on('player_died', (stats) => {
        const p = ffaLobby.players.find(x => x.id === socket.id);
        if (p && ffaLobby.state === 'playing' && p.alive) {
            p.alive = false;
            
            // Smart Kill Feed Logic
            let killer = "Gravity";
            const recent = p.damageLog.filter(l => Date.now() - l.time < 15000); // 15s window
            if (recent.length > 0) {
                const map = {};
                recent.forEach(l => map[l.attacker] = (map[l.attacker] || 0) + l.amount);
                killer = Object.keys(map).reduce((a, b) => map[a] > map[b] ? a : b);
            }

            const sTime = Date.now() - ffaLobby.startTime;
            recordMatchStat(p.username, stats, false, sTime);
            
            io.to('lobby_ffa').emit('elimination', { username: p.username, killer: killer });
            checkWinCondition();
        }
    });

    socket.on('match_won', (stats) => {
        if (ffaLobby.state === 'playing' || ffaLobby.state === 'finished') {
            const sTime = Date.now() - ffaLobby.startTime;
            recordMatchStat(socket.username, stats, true, sTime);
            finishGame(socket.username);
        }
    });
});

// --- HELPER LOGIC ---

function tryStartGame() {
    if (ffaLobby.state === 'waiting' && ffaLobby.players.length >= 2) {
        ffaLobby.state = 'countdown';
        ffaLobby.seed = Math.floor(Math.random() * 1000000);
        ffaLobby.matchStats = [];
        ffaLobby.players.forEach(p => { p.alive = true; p.damageLog = []; });

        io.to('lobby_ffa').emit('start_countdown', { duration: 3 });

        ffaLobby.timer = setTimeout(() => {
            ffaLobby.state = 'playing';
            ffaLobby.startTime = Date.now();
            io.to('lobby_ffa').emit('match_start', {
                mode: 'ffa',
                seed: ffaLobby.seed,
                players: ffaLobby.players.map(p => ({ id: p.id, username: p.username }))
            });
        }, 3000);
    }
}

function checkWinCondition() {
    const survivors = ffaLobby.players.filter(p => p.alive);
    if (survivors.length <= 1) {
        ffaLobby.state = 'finished';
        if (survivors.length === 1) {
            io.to(survivors[0].id).emit('request_win_stats');
        } else {
            finishGame(null); // Draw / Everyone left
        }
    }
}

function recordMatchStat(username, stats, isWinner, sTime) {
    if (ffaLobby.matchStats.find(s => s.username === username)) return;
    ffaLobby.matchStats.push({
        username, isWinner,
        apm: stats.apm||0, pps: stats.pps||0, sent: stats.sent||0, recv: stats.recv||0,
        maxCombo: stats.maxCombo||0, survivalTime: sTime||0,
        timestamp: Date.now()
    });
}

function finishGame(winnerName) {
    const winnerObj = ffaLobby.matchStats.find(s => s.isWinner);
    const losers = ffaLobby.matchStats.filter(s => !s.isWinner).sort((a, b) => b.timestamp - a.timestamp);
    const results = [];
    
    // Duration formatter
    const fmt = (ms) => `${Math.floor(ms/60000)}m ${Math.floor((ms%60000)/1000)}s`;

    if (winnerObj) results.push({ ...winnerObj, place: 1, durationStr: fmt(winnerObj.survivalTime) });
    losers.forEach((l, index) => { results.push({ ...l, place: (winnerObj ? 2 : 1) + index, durationStr: fmt(l.survivalTime) }); });

    // Update Accounts
    results.forEach(res => {
        if (accounts[res.username]) {
            if (res.place === 1) accounts[res.username].wins++;
            if ((res.maxCombo||0) > (accounts[res.username].bestCombo||0)) accounts[res.username].bestCombo = res.maxCombo;
            if (!accounts[res.username].history) accounts[res.username].history = [];
            accounts[res.username].history.push({
                date: new Date().toISOString(),
                place: res.place, apm: res.apm, pps: res.pps, sent: res.sent,
                received: res.recv, maxCombo: res.maxCombo
            });
        }
    });
    saveAccounts();

    if (winnerName && accounts[winnerName]) {
        const sock = ffaLobby.players.find(p => p.username === winnerName);
        if (sock && io.sockets.sockets.get(sock.id)) {
             io.to(sock.id).emit('update_my_wins', accounts[winnerName].wins);
        }
    }

    io.emit('leaderboard_update', getLeaderboards());
    io.to('lobby_ffa').emit('match_summary', results);

    // RESTART TIMER (5 Seconds)
    setTimeout(() => {
        ffaLobby.state = 'waiting';
        io.to('lobby_ffa').emit('lobby_reset');
        
        // Check if we can restart immediately
        if (ffaLobby.players.length >= 2) {
            tryStartGame();
        } else {
            io.to('lobby_ffa').emit('lobby_update', { count: ffaLobby.players.length });
        }
    }, 5000);
}

function getLeaderboards() {
    const all = Object.entries(accounts);
    const wins = all.map(([n, d]) => ({ name: n, val: d.wins })).sort((a, b) => b.val - a.val).slice(0, 5);
    const combos = all.map(([n, d]) => ({ name: n, val: d.bestCombo || 0 })).filter(u => u.val > 0).sort((a, b) => b.val - a.val).slice(0, 5);
    return { wins, combos };
}

http.listen(3000, () => { console.log('SERVER RUNNING ON PORT 3000'); });
