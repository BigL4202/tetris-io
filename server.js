// --- IMPORTS & SETUP ---
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const fs = require('fs');

// Serve static files from the CURRENT directory
// This allows index.html, style.css, and script.js to be loaded from the same folder
app.use(express.static(__dirname));

// --- DATA STORAGE ---
const DATA_FILE = path.join(__dirname, 'accounts.json');
let accounts = {}; 

// Load existing accounts from disk
function loadAccounts() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            accounts = JSON.parse(fs.readFileSync(DATA_FILE));
            console.log("Accounts loaded successfully.");
        }
    } catch (err) { 
        console.error("Error loading accounts:", err);
        accounts = {}; 
    }
}

// Save accounts to disk
function saveAccounts() {
    try { 
        fs.writeFileSync(DATA_FILE, JSON.stringify(accounts, null, 2)); 
    } catch (err) {
        console.error("Error saving accounts:", err);
    }
}
loadAccounts();

// --- GAME STATE ---
// We only have one lobby type in v3.9.1: The Standard FFA Lobby
let ffaLobby = {
    players: [],      // Array of player objects: { id, username, alive, damageLog }
    state: 'waiting', // States: 'waiting', 'countdown', 'playing', 'finished'
    seed: 12345,      // Random seed for shared piece sequence
    matchStats: [],   // Stores results for the current match
    startTime: 0,     // Timestamp when the match started
    timer: null       // Reference to the countdown timer
};

// --- SOCKET CONNECTION ---
io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    // --- CHAT SYSTEM ---
    socket.on('send_chat', (msg) => {
        // Basic sanitization to prevent HTML injection
        const cleanMsg = msg.replace(/</g, "&lt;").replace(/>/g, "&gt;").substring(0, 50);
        const name = socket.username || "Anon";
        
        // If the player is in the lobby, only send chat to that room
        if (socket.rooms.has('lobby_ffa')) {
            io.to('lobby_ffa').emit('receive_chat', { user: name, text: cleanMsg });
        } else {
            // Otherwise, send to global chat (Zen/Menu users)
            io.emit('receive_chat', { user: name, text: cleanMsg });
        }
    });

    // --- LOGIN SYSTEM ---
    socket.on('login_attempt', (data) => {
        const user = data.username.trim().substring(0, 12);
        const pass = data.password.trim();
        
        if (!user || !pass) {
            return socket.emit('login_response', { success: false, msg: "Please enter both username and password." });
        }

        // Create account if it doesn't exist
        if (!accounts[user]) {
            accounts[user] = { 
                password: pass, 
                wins: 0, 
                bestAPM: 0, 
                bestCombo: 0, 
                history: [] 
            };
            saveAccounts();
            console.log(`New account created: ${user}`);
        } else if (accounts[user].password !== pass) {
            return socket.emit('login_response', { success: false, msg: "Incorrect Password!" });
        }

        // Login successful
        socket.username = user;
        socket.emit('login_response', { 
            success: true, 
            username: user, 
            wins: accounts[user].wins, 
            bestAPM: accounts[user].bestAPM || 0 
        });
        
        // Broadcast updated leaderboard to everyone
        io.emit('leaderboard_update', getLeaderboards());
    });

    // --- STATS SYSTEM ---
    socket.on('request_all_stats', () => {
        // Send a sanitized version of accounts (no passwords)
        const safeData = {};
        for (const [key, val] of Object.entries(accounts)) {
            safeData[key] = { 
                wins: val.wins, 
                bestAPM: val.bestAPM, 
                bestCombo: val.bestCombo || 0, 
                history: val.history || [] 
            };
        }
        socket.emit('receive_all_stats', safeData);
    });

    socket.on('submit_apm', (val) => {
        if (!socket.username) return;
        const score = parseInt(val) || 0;
        
        if (accounts[socket.username]) {
            if (score > (accounts[socket.username].bestAPM || 0)) {
                accounts[socket.username].bestAPM = score;
                saveAccounts();
                socket.emit('update_my_apm', score);
            }
        }
    });

    // --- LOBBY MANAGEMENT ---
    
    // Helper function to remove a player safely from the lobby
    async function leaveFFA() {
        const idx = ffaLobby.players.findIndex(p => p.id === socket.id);
        
        if (idx !== -1) {
            const p = ffaLobby.players[idx];
            ffaLobby.players.splice(idx, 1);
            
            // Strictly remove from the socket.io room
            await socket.leave('lobby_ffa');
            
            // Notify remaining players
            io.to('lobby_ffa').emit('lobby_update', { count: ffaLobby.players.length });
            
            // If the game is in progress and a living player leaves, mark them dead
            if (ffaLobby.state === 'playing' && p.alive) {
                io.to('lobby_ffa').emit('elimination', { username: p.username, killer: "Disconnect" });
                checkWinCondition();
            }
            
            // If the lobby drops below 2 players during countdown, cancel start
            if (ffaLobby.players.length < 2 && ffaLobby.state === 'countdown') {
                ffaLobby.state = 'waiting';
                clearTimeout(ffaLobby.timer);
                io.to('lobby_ffa').emit('lobby_reset');
            }
        }
    }

    socket.on('leave_lobby', () => { leaveFFA(); });
    socket.on('disconnect', () => { leaveFFA(); });

    // Join FFA Logic
    socket.on('join_ffa', async () => {
        if (!socket.username) return;
        
        // Ensure they aren't already in the lobby
        await leaveFFA(); 
        
        await socket.join('lobby_ffa');
        
        const pData = { 
            id: socket.id, 
            username: socket.username, 
            alive: true, 
            damageLog: [] // Used for Smart Kill Feed
        };
        
        ffaLobby.players.push(pData);

        // If waiting, just add them. If playing, they become a spectator.
        if (ffaLobby.state === 'waiting' || ffaLobby.state === 'finished') {
            io.to('lobby_ffa').emit('lobby_update', { count: ffaLobby.players.length });
            tryStartGame();
        } else {
            // Late join = Spectator
            pData.alive = false;
            // Send current game state to the spectator
            const livingPlayers = ffaLobby.players.filter(p => p.alive).map(p => ({ id: p.id, username: p.username }));
            socket.emit('ffa_spectate', { seed: ffaLobby.seed, players: livingPlayers });
        }
    });

    // --- GAMEPLAY EVENTS ---
    
    // Relay board updates to opponents
    socket.on('update_board', (grid) => {
        socket.to('lobby_ffa').emit('enemy_board_update', { id: socket.id, grid: grid });
    });

    // Handle Garbage Attacks
    socket.on('send_garbage', (data) => {
        if (ffaLobby.state === 'playing') {
            const sender = ffaLobby.players.find(p => p.id === socket.id);
            if (!sender || !sender.alive) return;

            const targets = ffaLobby.players.filter(p => p.alive && p.id !== socket.id);
            
            if (targets.length > 0) {
                // Split garbage evenly among survivors
                let split = Math.floor(data.amount / targets.length);
                // Ensure at least 1 line is sent if the attack was a Quad+ (4+)
                if (data.amount >= 4 && split === 0) split = 1;
                
                if (split > 0) {
                    targets.forEach(t => {
                        // Log this damage for the Kill Feed
                        t.damageLog.push({ attacker: sender.username, amount: split, time: Date.now() });
                        io.to(t.id).emit('receive_garbage', split);
                    });
                }
            }
        }
    });

    // Handle Player Death
    socket.on('player_died', (stats) => {
        const p = ffaLobby.players.find(x => x.id === socket.id);
        
        if (p && ffaLobby.state === 'playing' && p.alive) {
            p.alive = false;
            
            // Smart Kill Feed Calculation
            let killer = "Gravity";
            const recentDamage = p.damageLog.filter(l => Date.now() - l.time < 15000); // 15 seconds memory
            
            if (recentDamage.length > 0) {
                // Find who dealt the most damage recently
                const damageMap = {};
                recentDamage.forEach(l => {
                    damageMap[l.attacker] = (damageMap[l.attacker] || 0) + l.amount;
                });
                killer = Object.keys(damageMap).reduce((a, b) => damageMap[a] > damageMap[b] ? a : b);
            }

            const survivalTime = Date.now() - ffaLobby.startTime;
            recordMatchStat(p.username, stats, false, survivalTime);
            
            io.to('lobby_ffa').emit('elimination', { username: p.username, killer: killer });
            checkWinCondition();
        }
    });

    // Handle Winner
    socket.on('match_won', (stats) => {
        if (ffaLobby.state === 'playing' || ffaLobby.state === 'finished') {
            const survivalTime = Date.now() - ffaLobby.startTime;
            recordMatchStat(socket.username, stats, true, survivalTime);
            finishGame(socket.username);
        }
    });
});

// --- HELPER FUNCTIONS ---

function tryStartGame() {
    if (ffaLobby.state === 'waiting' && ffaLobby.players.length >= 2) {
        startFFARound();
    }
}

function startFFARound() {
    ffaLobby.state = 'countdown';
    ffaLobby.seed = Math.floor(Math.random() * 1000000); // Sync RNG
    ffaLobby.matchStats = []; 
    
    // Revive everyone
    ffaLobby.players.forEach(p => { 
        p.alive = true; 
        p.damageLog = []; 
    });

    console.log(`Starting FFA game with ${ffaLobby.players.length} players.`);
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

function checkWinCondition() {
    const survivors = ffaLobby.players.filter(p => p.alive);
    if (survivors.length <= 1) {
        ffaLobby.state = 'finished';
        
        if (survivors.length === 1) {
            // Ask the last player for their stats before ending
            io.to(survivors[0].id).emit('request_win_stats');
        } else {
            // Draw or everyone died/left
            finishGame(null);
        }
    }
}

function recordMatchStat(username, stats, isWinner, sTime) {
    // Prevent duplicates
    if (ffaLobby.matchStats.find(s => s.username === username)) return;

    ffaLobby.matchStats.push({
        username: username,
        isWinner: isWinner,
        apm: stats.apm || 0,
        pps: stats.pps || 0,
        sent: stats.sent || 0,
        recv: stats.recv || 0,
        maxCombo: stats.maxCombo || 0, 
        survivalTime: sTime || 0,
        timestamp: Date.now()
    });
}

function finishGame(winnerName) {
    const winnerObj = ffaLobby.matchStats.find(s => s.isWinner);
    const losers = ffaLobby.matchStats.filter(s => !s.isWinner).sort((a, b) => b.timestamp - a.timestamp);
    
    const results = [];
    const formatTime = (ms) => {
        const m = Math.floor(ms / 60000);
        const s = Math.floor((ms % 60000) / 1000);
        return `${m}m ${s}s`;
    };

    if (winnerObj) {
        results.push({ ...winnerObj, place: 1, durationStr: formatTime(winnerObj.survivalTime) });
    }
    
    losers.forEach((l, index) => {
        results.push({ ...l, place: (winnerObj ? 2 : 1) + index, durationStr: formatTime(l.survivalTime) });
    });

    // Update Persistent Accounts
    results.forEach(res => {
        if (accounts[res.username]) {
            if (res.place === 1) accounts[res.username].wins++;
            
            if ((res.maxCombo || 0) > (accounts[res.username].bestCombo || 0)) {
                accounts[res.username].bestCombo = res.maxCombo;
            }
            if ((res.apm || 0) > (accounts[res.username].bestAPM || 0)) {
                accounts[res.username].bestAPM = res.apm;
            }

            if (!accounts[res.username].history) accounts[res.username].history = [];
            accounts[res.username].history.push({
                date: new Date().toISOString(),
                place: res.place,
                apm: res.apm,
                pps: res.pps,
                sent: res.sent,
                received: res.recv,
                maxCombo: res.maxCombo
            });
        }
    });
    
    saveAccounts();

    // Update Winner's Client immediately
    if (winnerName && accounts[winnerName]) {
        const winnerSocket = ffaLobby.players.find(p => p.username === winnerName);
        if (winnerSocket && io.sockets.sockets.get(winnerSocket.id)) {
             io.to(winnerSocket.id).emit('update_my_wins', accounts[winnerName].wins);
        }
    }

    io.emit('leaderboard_update', getLeaderboards());
    io.to('lobby_ffa').emit('match_summary', results);

    // 5 SECOND RESTART TIMER (Requested in v3.9.1)
    setTimeout(() => {
        if (ffaLobby.players.length >= 2) {
            startFFARound();
        } else {
            ffaLobby.state = 'waiting';
            io.to('lobby_ffa').emit('lobby_reset');
            // Update lobby count for those remaining
            io.to('lobby_ffa').emit('lobby_update', { count: ffaLobby.players.length });
        }
    }, 5000); 
}

function getLeaderboards() {
    const allUsers = Object.entries(accounts);
    const wins = allUsers.map(([n, d]) => ({ name: n, val: d.wins })).sort((a, b) => b.val - a.val).slice(0, 5);
    const combos = allUsers.map(([n, d]) => ({ name: n, val: d.bestCombo || 0 })).filter(u => u.val > 0).sort((a, b) => b.val - a.val).slice(0, 5);
    return { wins, combos };
}

http.listen(3000, () => { console.log('SERVER RUNNING ON PORT 3000'); });
