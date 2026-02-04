// --- IMPORTS & SETUP ---
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const fs = require('fs');

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- DATA STORAGE ---
const DATA_FILE = path.join(__dirname, 'accounts.json');
let accounts = {}; 

function loadAccounts() {
    try { if (fs.existsSync(DATA_FILE)) accounts = JSON.parse(fs.readFileSync(DATA_FILE)); } catch (err) { accounts = {}; }
}
function saveAccounts() {
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(accounts, null, 2)); } catch (err) {}
}
loadAccounts();

// --- GAME STATE ---
let ffaLobby = {
    players: [],      // { id, username, alive, damageLog, lastActivity }
    state: 'waiting', // waiting, countdown, playing, finished
    seed: 12345,
    matchStats: [],
    startTime: 0,
    timer: null
};

// --- AFK CHECKER LOOP (Runs every 1s) ---
setInterval(() => {
    if (ffaLobby.state === 'playing') {
        const now = Date.now();
        // Identify AFK players (10s timeout)
        const afkPlayers = ffaLobby.players.filter(p => p.alive && (now - p.lastActivity > 10000));
        
        afkPlayers.forEach(p => {
            console.log(`Kicking ${p.username} for AFK`);
            io.to(p.id).emit('force_disconnect', 'You were kicked for being AFK.');
            io.to('lobby_ffa').emit('elimination', { username: p.username, killer: "AFK Timer" });
            
            // Mark dead and handle disconnect logic
            p.alive = false;
            // We treat AFK as a "death" to trigger win conditions, but we also remove them from lobby
            removePlayerFromLobby(p.id); 
        });

        if (afkPlayers.length > 0) checkWinCondition();
    }
}, 1000);


// --- SOCKET CONNECTION ---
io.on('connection', (socket) => {
    
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
            success: true, username: user, wins: accounts[user].wins, bestAPM: accounts[user].bestAPM || 0 
        });
        io.emit('leaderboard_update', getLeaderboards());
    });

    // LOBBY MANAGEMENT
    socket.on('join_ffa', async () => {
        if (!socket.username) return;
        
        // Ensure they aren't already in
        removePlayerFromLobby(socket.id);
        
        await socket.join('lobby_ffa');
        
        const pData = { 
            id: socket.id, 
            username: socket.username, 
            alive: true, 
            damageLog: [], 
            lastActivity: Date.now() // Init timer
        };
        
        ffaLobby.players.push(pData);

        if (ffaLobby.state === 'waiting' || ffaLobby.state === 'finished') {
            io.to('lobby_ffa').emit('lobby_update', { count: ffaLobby.players.length });
            if (ffaLobby.players.length >= 2) tryStartGame();
        } else {
            // Late joiner = Spectator
            pData.alive = false;
            const livePlayers = ffaLobby.players.filter(p => p.alive).map(p => ({ id: p.id, username: p.username }));
            socket.emit('ffa_spectate', { seed: ffaLobby.seed, players: livePlayers });
        }
    });

    socket.on('leave_lobby', () => {
        removePlayerFromLobby(socket.id);
    });

    socket.on('disconnect', () => {
        removePlayerFromLobby(socket.id);
    });

    // GAMEPLAY EVENTS
    socket.on('update_board', (grid) => {
        const p = ffaLobby.players.find(x => x.id === socket.id);
        if (p) {
            p.lastActivity = Date.now(); // Reset AFK Timer
            socket.to('lobby_ffa').emit('enemy_board_update', { id: socket.id, grid: grid });
        }
    });

    socket.on('send_garbage', (data) => {
        if (ffaLobby.state === 'playing') {
            const sender = ffaLobby.players.find(p => p.id === socket.id);
            if (!sender || !sender.alive) return;
            
            sender.lastActivity = Date.now(); // Reset AFK Timer

            const targets = ffaLobby.players.filter(p => p.alive && p.id !== socket.id);
            if (targets.length > 0) {
                let split = Math.floor(data.amount / targets.length);
                if (data.amount >= 4 && split === 0) split = 1;
                
                if (split > 0) {
                    targets.forEach(t => {
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
            let killer = "Gravity";
            const recent = p.damageLog.filter(l => Date.now() - l.time < 15000); 
            if (recent.length > 0) {
                const map = {}; recent.forEach(l => map[l.attacker] = (map[l.attacker] || 0) + l.amount);
                killer = Object.keys(map).reduce((a, b) => map[a] > map[b] ? a : b);
            }
            recordMatchStat(p.username, stats, false, Date.now() - ffaLobby.startTime);
            io.to('lobby_ffa').emit('elimination', { username: p.username, killer: killer });
            checkWinCondition();
        }
    });

    socket.on('match_won', (stats) => {
        if (ffaLobby.state === 'playing' || ffaLobby.state === 'finished') {
            recordMatchStat(socket.username, stats, true, Date.now() - ffaLobby.startTime);
            finishGame(socket.username);
        }
    });
    
    // Chat & Stats
    socket.on('send_chat', (msg) => {
        const cleanMsg = msg.replace(/</g, "&lt;").substring(0, 50);
        const name = socket.username || "Anon";
        io.emit('receive_chat', { user: name, text: cleanMsg });
    });
    
    socket.on('request_all_stats', () => {
        socket.emit('receive_all_stats', accounts);
    });
});

// --- HELPER FUNCTIONS ---

function removePlayerFromLobby(socketId) {
    const idx = ffaLobby.players.findIndex(p => p.id === socketId);
    if (idx !== -1) {
        const p = ffaLobby.players[idx];
        ffaLobby.players.splice(idx, 1);
        
        const ioSocket = io.sockets.sockets.get(socketId);
        if(ioSocket) ioSocket.leave('lobby_ffa');

        io.to('lobby_ffa').emit('lobby_update', { count: ffaLobby.players.length });

        // If playing and they disconnect, they die
        if (ffaLobby.state === 'playing' && p.alive) {
            io.to('lobby_ffa').emit('elimination', { username: p.username, killer: "Disconnect" });
            checkWinCondition();
        }

        // Cancel countdown if not enough players
        if (ffaLobby.players.length < 2 && ffaLobby.state === 'countdown') {
            ffaLobby.state = 'waiting';
            clearTimeout(ffaLobby.timer);
            io.to('lobby_ffa').emit('lobby_reset');
        }
    }
}

function tryStartGame() {
    if (ffaLobby.state === 'waiting' && ffaLobby.players.length >= 2) {
        ffaLobby.state = 'countdown';
        ffaLobby.seed = Math.floor(Math.random() * 1000000);
        ffaLobby.matchStats = [];
        
        // REVIVE EVERYONE FOR NEW MATCH
        ffaLobby.players.forEach(p => { 
            p.alive = true; 
            p.damageLog = []; 
            p.lastActivity = Date.now(); // Reset AFK timers
        });

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
        if (survivors.length === 1) io.to(survivors[0].id).emit('request_win_stats');
        else finishGame(null);
    }
}

function recordMatchStat(username, stats, isWinner, sTime) {
    if (ffaLobby.matchStats.find(s => s.username === username)) return;
    ffaLobby.matchStats.push({ username, isWinner, ...stats, survivalTime: sTime });
}

function finishGame(winnerName) {
    const winnerObj = ffaLobby.matchStats.find(s => s.isWinner);
    const losers = ffaLobby.matchStats.filter(s => !s.isWinner).sort((a, b) => b.survivalTime - a.survivalTime); // Fix sort order
    const results = [];
    const fmt = (ms) => `${Math.floor(ms/60000)}m ${Math.floor((ms%60000)/1000)}s`;

    if (winnerObj) results.push({ ...winnerObj, place: 1, durationStr: fmt(winnerObj.survivalTime) });
    losers.forEach((l, i) => results.push({ ...l, place: (winnerObj ? 2 : 1) + i, durationStr: fmt(l.survivalTime) }));

    // Save Stats
    results.forEach(res => {
        if (accounts[res.username]) {
            if (res.place === 1) accounts[res.username].wins++;
            if ((res.maxCombo||0) > (accounts[res.username].bestCombo||0)) accounts[res.username].bestCombo = res.maxCombo;
            if ((res.apm||0) > (accounts[res.username].bestAPM||0)) accounts[res.username].bestAPM = res.apm;
            if (!accounts[res.username].history) accounts[res.username].history = [];
            accounts[res.username].history.push({ date: new Date().toISOString(), ...res });
        }
    });
    saveAccounts();

    if (winnerName && accounts[winnerName]) {
        const sock = ffaLobby.players.find(p => p.username === winnerName);
        if (sock && io.sockets.sockets.get(sock.id)) io.to(sock.id).emit('update_my_wins', accounts[winnerName].wins);
    }

    io.emit('leaderboard_update', getLeaderboards());
    io.to('lobby_ffa').emit('match_summary', results);

    // Restart Loop
    setTimeout(() => {
        ffaLobby.state = 'waiting';
        io.to('lobby_ffa').emit('lobby_reset');
        if (ffaLobby.players.length >= 2) tryStartGame();
        else io.to('lobby_ffa').emit('lobby_update', { count: ffaLobby.players.length });
    }, 5000);
}

function getLeaderboards() {
    const all = Object.entries(accounts);
    return {
        wins: all.map(([n, d]) => ({ name: n, val: d.wins })).sort((a, b) => b.val - a.val).slice(0, 5),
        combos: all.map(([n, d]) => ({ name: n, val: d.bestCombo || 0 })).filter(u => u.val > 0).sort((a, b) => b.val - a.val).slice(0, 5)
    };
}

http.listen(3000, () => console.log('SERVER RUNNING ON PORT 3000'));
