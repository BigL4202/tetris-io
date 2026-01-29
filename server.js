const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

// --- GLOBAL STATE ---
let ffaPlayers = []; 
let ffaState = 'waiting'; 
let ffaSeed = 12345;

// --- DATA STORAGE ---
// { "username": { password: "...", wins: 0, bestAPM: 0 } }
const accounts = {}; 

io.on('connection', (socket) => {
    
    // --- GLOBAL CHAT ---
    socket.on('send_chat', (msg) => {
        const cleanMsg = msg.replace(/</g, "&lt;").replace(/>/g, "&gt;").substring(0, 50);
        const name = socket.username || "Anon";
        io.emit('receive_chat', { user: name, text: cleanMsg });
    });

    // --- LOGIN / REGISTER ---
    socket.on('login_attempt', (data) => {
        const user = data.username.trim().substring(0, 12);
        const pass = data.password.trim();

        if (!user || !pass) {
            socket.emit('login_response', { success: false, msg: "Enter user & pass." });
            return;
        }

        if (accounts[user]) {
            // Existing Account
            if (accounts[user].password === pass) {
                socket.username = user;
                socket.emit('login_response', { 
                    success: true, 
                    username: user, 
                    wins: accounts[user].wins,
                    bestAPM: accounts[user].bestAPM || 0 
                });
                // Send current leaderboards
                socket.emit('leaderboard_update', getLeaderboards());
            } else {
                socket.emit('login_response', { success: false, msg: "Incorrect Password!" });
            }
        } else {
            // New Account
            accounts[user] = { password: pass, wins: 0, bestAPM: 0 };
            socket.username = user;
            socket.emit('login_response', { success: true, username: user, wins: 0, bestAPM: 0 });
            io.emit('leaderboard_update', getLeaderboards());
        }
    });

    // --- APM SUBMISSION ---
    socket.on('submit_apm', (val) => {
        if (!socket.username) return; // Only logged in users
        
        const score = parseInt(val) || 0;

        // Update Personal Best in Account
        if (accounts[socket.username]) {
            const currentBest = accounts[socket.username].bestAPM || 0;
            
            if (score > currentBest) {
                accounts[socket.username].bestAPM = score;
                // Update client display
                socket.emit('update_my_apm', score);
                // Broadcast new leaderboard since a high score changed
                io.emit('leaderboard_update', getLeaderboards());
            }
        }
    });

    // --- FFA SYSTEM ---
    socket.on('join_ffa', () => {
        if (!socket.username) return;

        socket.join('ffa_room');
        const existing = ffaPlayers.find(p => p.id === socket.id);
        if (existing) return;

        if (ffaState === 'waiting' || ffaState === 'finished') {
            ffaPlayers.push({ id: socket.id, username: socket.username, alive: true, socket: socket });
            io.to('ffa_room').emit('lobby_update', { count: ffaPlayers.length });
            checkFFAStart();
        } else {
            const livingPlayers = ffaPlayers.filter(p => p.alive).map(p => ({ id: p.id, username: p.username }));
            socket.emit('ffa_spectate', { seed: ffaSeed, players: livingPlayers });
            ffaPlayers.push({ id: socket.id, username: socket.username, alive: false, socket: socket });
        }
    });

    socket.on('send_garbage', (data) => {
        if (ffaState === 'playing') {
            const targets = ffaPlayers.filter(p => p.alive && p.id !== socket.id);
            if (targets.length > 0) {
                let split = Math.floor(data.amount / targets.length);
                if (data.amount >= 4 && split === 0) split = 1; 
                if (split > 0) {
                    targets.forEach(t => io.to(t.id).emit('receive_garbage', split));
                }
            }
        }
    });

    socket.on('update_board', (grid) => {
        socket.to('ffa_room').emit('enemy_board_update', { id: socket.id, grid: grid });
    });

    socket.on('player_died', () => {
        const p = ffaPlayers.find(x => x.id === socket.id);
        if (p && ffaState === 'playing' && p.alive) {
            p.alive = false;
            io.to('ffa_room').emit('elimination', { username: p.username });
            checkFFAWin();
        }
    });

    socket.on('disconnect', () => {
        const pIndex = ffaPlayers.findIndex(x => x.id === socket.id);
        if (pIndex !== -1) {
            const p = ffaPlayers[pIndex];
            ffaPlayers.splice(pIndex, 1);
            if (ffaState === 'playing' && p.alive) {
                io.to('ffa_room').emit('elimination', { username: p.username });
                checkFFAWin();
            }
            io.to('ffa_room').emit('lobby_update', { count: ffaPlayers.length });
        }
    });
});

// --- HELPERS ---
function getLeaderboards() {
    // Generate lists dynamically from the accounts object
    // This ensures 1 entry per user (their current stats)
    
    const allUsers = Object.entries(accounts);

    // 1. Win Leaderboard
    const wins = allUsers
        .map(([name, data]) => ({ name: name, val: data.wins }))
        .sort((a, b) => b.val - a.val)
        .slice(0, 5);

    // 2. APM Leaderboard
    const apm = allUsers
        .map(([name, data]) => ({ name: name, score: data.bestAPM || 0 }))
        .filter(u => u.score > 0) // Only show people who have played APM test
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);
        
    return { wins: wins, apm: apm };
}

function checkFFAStart() {
    if (ffaState === 'waiting' && ffaPlayers.length >= 2) {
        startFFARound();
    }
}

function startFFARound() {
    ffaState = 'countdown';
    ffaSeed = Math.floor(Math.random() * 1000000);
    ffaPlayers.forEach(p => p.alive = true);
    
    io.to('ffa_room').emit('start_countdown', { duration: 3 });
    
    setTimeout(() => {
        ffaState = 'playing';
        io.to('ffa_room').emit('match_start', { 
            mode: 'ffa',
            seed: ffaSeed, 
            players: ffaPlayers.map(p => ({ id: p.id, username: p.username })) 
        });
    }, 3000);
}

function checkFFAWin() {
    const survivors = ffaPlayers.filter(p => p.alive);
    if (survivors.length <= 1) {
        ffaState = 'finished';
        let winnerName = "No One";
        
        if (survivors.length === 1) {
            winnerName = survivors[0].username;
            if (accounts[winnerName]) {
                accounts[winnerName].wins++;
                const winnerSocket = survivors[0].socket;
                if(winnerSocket) winnerSocket.emit('update_my_wins', accounts[winnerName].wins);
            }
            io.emit('leaderboard_update', getLeaderboards());
        }
        
        io.to('ffa_room').emit('round_over', { winner: winnerName });
        
        setTimeout(() => {
            if (ffaPlayers.length >= 2) {
                startFFARound();
            } else {
                ffaState = 'waiting';
                io.to('ffa_room').emit('lobby_reset');
            }
        }, 3000);
    }
}

http.listen(3000, () => { console.log('Server on 3000'); });

