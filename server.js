// --- IMPORTS & SETUP ---
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const fs = require('fs');

// Serve static files from the 'public' folder (where index.html lives)
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- DATA STORAGE ---
const DATA_FILE = path.join(__dirname, 'accounts.json');
let accounts = {};

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

function saveAccounts() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(accounts, null, 2));
    } catch (err) {
        console.error("Error saving accounts:", err);
    }
}
loadAccounts();

// --- GAME STATE ---
let ffaLobby = {
    players: [],
    state: 'waiting',
    seed: 12345,
    matchStats: [],
    startTime: 0,
    timer: null
};

// --- DUEL STATE ---
let duels = {};       // { duelId: { id, p1Id, p2Id, p1Name, p2Name, scores: {p1Id: 0, p2Id: 0}, round: 1, seed, active: true } }
let challenges = {};  // { challengerId: { targetId, targetName, senderName, timestamp, timer } }

// --- ONLINE PLAYER TRACKING ---
let onlinePlayers = {}; // { socketId: { id, username, status } }  status: 'idle'|'ffa'|'zen'|'apm_test'|'duel'

// ========================================================================
// SOCKET CONNECTION
// ========================================================================
io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    // Register in online players with default state
    onlinePlayers[socket.id] = { id: socket.id, username: null, status: 'idle' };

    // --- CHAT SYSTEM ---
    socket.on('send_chat', (msg) => {
        const cleanMsg = msg.replace(/</g, "&lt;").replace(/>/g, "&gt;").substring(0, 50);
        const name = socket.username || "Anon";

        if (socket.rooms.has('lobby_ffa')) {
            io.to('lobby_ffa').emit('receive_chat', { user: name, text: cleanMsg });
        } else {
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

        socket.username = user;
        onlinePlayers[socket.id].username = user;

        socket.emit('login_response', {
            success: true,
            username: user,
            wins: accounts[user].wins,
            bestAPM: accounts[user].bestAPM || 0
        });

        io.emit('leaderboard_update', getLeaderboards());
        broadcastPlayerList();
    });

    // --- STATS SYSTEM ---
    socket.on('request_all_stats', () => {
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

    async function leaveFFA() {
        const idx = ffaLobby.players.findIndex(p => p.id === socket.id);
        if (idx !== -1) {
            const p = ffaLobby.players[idx];
            ffaLobby.players.splice(idx, 1);
            await socket.leave('lobby_ffa');

            io.to('lobby_ffa').emit('lobby_update', { count: ffaLobby.players.length });

            if (ffaLobby.state === 'playing' && p.alive) {
                io.to('lobby_ffa').emit('elimination', { username: p.username, killer: "Disconnect" });
                checkWinCondition();
            }

            if (ffaLobby.players.length < 2 && ffaLobby.state === 'countdown') {
                ffaLobby.state = 'waiting';
                clearTimeout(ffaLobby.timer);
                io.to('lobby_ffa').emit('lobby_reset');
            }
        }
    }

    // --- STATUS TRACKING ---
    socket.on('set_status', (status) => {
        if (onlinePlayers[socket.id]) {
            onlinePlayers[socket.id].status = status;
            broadcastPlayerList();
        }
    });

    socket.on('leave_lobby', () => {
        leaveFFA();
        leaveDuel(socket.id, 'left');
        if (onlinePlayers[socket.id]) {
            onlinePlayers[socket.id].status = 'idle';
        }
        broadcastPlayerList();
    });

    socket.on('disconnect', () => {
        leaveFFA();
        leaveDuel(socket.id, 'disconnect');

        // Clean up any pending challenges
        if (challenges[socket.id]) {
            clearTimeout(challenges[socket.id].timer);
            delete challenges[socket.id];
        }
        // Clean up challenges targeting this player
        for (const [cId, ch] of Object.entries(challenges)) {
            if (ch.targetId === socket.id) {
                clearTimeout(ch.timer);
                delete challenges[cId];
                const challengerSocket = io.sockets.sockets.get(cId);
                if (challengerSocket) {
                    challengerSocket.emit('receive_chat', { user: '[SYSTEM]', text: `${socket.username || 'Player'} disconnected. Challenge cancelled.` });
                }
            }
        }

        delete onlinePlayers[socket.id];
        broadcastPlayerList();
    });

    // --- JOIN FFA ---
    socket.on('join_ffa', async () => {
        if (!socket.username) return;
        await leaveFFA();
        await socket.join('lobby_ffa');

        if (onlinePlayers[socket.id]) onlinePlayers[socket.id].status = 'ffa';
        broadcastPlayerList();

        const pData = {
            id: socket.id,
            username: socket.username,
            alive: true,
            damageLog: []
        };
        ffaLobby.players.push(pData);

        if (ffaLobby.state === 'waiting' || ffaLobby.state === 'finished') {
            io.to('lobby_ffa').emit('lobby_update', { count: ffaLobby.players.length });
            tryStartGame();
        } else {
            pData.alive = false;
            const livingPlayers = ffaLobby.players.filter(p => p.alive).map(p => ({ id: p.id, username: p.username }));
            socket.emit('ffa_spectate', { seed: ffaLobby.seed, players: livingPlayers });
        }
    });

    // --- GAMEPLAY EVENTS ---

    socket.on('update_board', (grid) => {
        // Relay to FFA opponents
        socket.to('lobby_ffa').emit('enemy_board_update', { id: socket.id, grid: grid });
        // Relay to duel opponent
        const duel = findDuelByPlayer(socket.id);
        if (duel && duel.active) {
            const oppId = duel.p1Id === socket.id ? duel.p2Id : duel.p1Id;
            io.to(oppId).emit('enemy_board_update', { id: socket.id, grid: grid });
        }
    });

    socket.on('send_garbage', (data) => {
        // FFA garbage
        if (ffaLobby.state === 'playing') {
            const sender = ffaLobby.players.find(p => p.id === socket.id);
            if (sender && sender.alive) {
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
        }

        // Duel garbage
        const duel = findDuelByPlayer(socket.id);
        if (duel && duel.active) {
            const oppId = duel.p1Id === socket.id ? duel.p2Id : duel.p1Id;
            io.to(oppId).emit('receive_garbage', data.amount);
        }
    });

    socket.on('player_died', (stats) => {
        // FFA death
        const p = ffaLobby.players.find(x => x.id === socket.id);
        if (p && ffaLobby.state === 'playing' && p.alive) {
            p.alive = false;

            let killer = "Gravity";
            const recentDamage = p.damageLog.filter(l => Date.now() - l.time < 15000);
            if (recentDamage.length > 0) {
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

    socket.on('match_won', (stats) => {
        if (ffaLobby.state === 'playing' || ffaLobby.state === 'finished') {
            const survivalTime = Date.now() - ffaLobby.startTime;
            recordMatchStat(socket.username, stats, true, survivalTime);
            finishGame(socket.username);
        }
    });

    // ====================================================================
    // DUEL SYSTEM
    // ====================================================================

    // 1. Send challenge (only 1 pending at a time)
    socket.on('duel_challenge', (targetId) => {
        if (!socket.username) return;

        // Check if already has pending challenge
        if (challenges[socket.id]) {
            return socket.emit('receive_chat', { user: '[SYSTEM]', text: 'You already have a pending challenge. Wait for it to expire.' });
        }

        const target = onlinePlayers[targetId];
        if (!target || !target.username) {
            return socket.emit('receive_chat', { user: '[SYSTEM]', text: 'Player not found or not logged in.' });
        }
        if (targetId === socket.id) {
            return socket.emit('receive_chat', { user: '[SYSTEM]', text: 'You cannot challenge yourself.' });
        }

        // Check if target is already in a duel
        if (target.status === 'duel') {
            return socket.emit('receive_chat', { user: '[SYSTEM]', text: `${target.username} is already in a duel.` });
        }

        // Register challenge with auto-expire timer
        const expireTimer = setTimeout(() => {
            if (challenges[socket.id]) {
                delete challenges[socket.id];
                socket.emit('receive_chat', { user: '[SYSTEM]', text: `Challenge to ${target.username} expired.` });
                socket.emit('challenge_expired');
            }
        }, 60000);

        challenges[socket.id] = {
            targetId: targetId,
            targetName: target.username,
            senderName: socket.username,
            timestamp: Date.now(),
            timer: expireTimer
        };

        // Notify the target
        io.to(targetId).emit('receive_challenge', {
            fromId: socket.id,
            fromName: socket.username
        });

        socket.emit('receive_chat', { user: '[SYSTEM]', text: `Challenge sent to ${target.username}. Waiting... (60s)` });
    });

    // 2. Cancel challenge
    socket.on('duel_cancel', () => {
        if (challenges[socket.id]) {
            clearTimeout(challenges[socket.id].timer);
            const targetId = challenges[socket.id].targetId;
            delete challenges[socket.id];
            socket.emit('receive_chat', { user: '[SYSTEM]', text: 'Challenge cancelled.' });
            io.to(targetId).emit('challenge_cancelled', { fromId: socket.id });
        }
    });

    // 3. Accept challenge
    socket.on('duel_accept', (challengerId) => {
        const ch = challenges[challengerId];
        if (!ch || ch.targetId !== socket.id) {
            return socket.emit('receive_chat', { user: '[SYSTEM]', text: 'Challenge expired or invalid.' });
        }

        // Clear the challenge
        clearTimeout(ch.timer);
        delete challenges[challengerId];

        const p1Socket = io.sockets.sockets.get(challengerId);
        if (!p1Socket) {
            return socket.emit('receive_chat', { user: '[SYSTEM]', text: 'Challenger disconnected.' });
        }

        // --- FORCE SWITCH: Remove both players from their current mode ---

        // If challenger is in FFA, announce disconnect elimination
        const p1FFA = ffaLobby.players.find(p => p.id === challengerId);
        if (p1FFA && p1FFA.alive && ffaLobby.state === 'playing') {
            p1FFA.alive = false;
            io.to('lobby_ffa').emit('elimination', { username: p1FFA.username, killer: "Disconnect (Duel)" });
            checkWinCondition();
        }
        // Remove challenger from FFA lobby
        const idx1 = ffaLobby.players.findIndex(p => p.id === challengerId);
        if (idx1 !== -1) {
            ffaLobby.players.splice(idx1, 1);
            p1Socket.leave('lobby_ffa');
        }

        // If acceptor is in FFA, announce disconnect elimination
        const p2FFA = ffaLobby.players.find(p => p.id === socket.id);
        if (p2FFA && p2FFA.alive && ffaLobby.state === 'playing') {
            p2FFA.alive = false;
            io.to('lobby_ffa').emit('elimination', { username: p2FFA.username, killer: "Disconnect (Duel)" });
            checkWinCondition();
        }
        // Remove acceptor from FFA lobby
        const idx2 = ffaLobby.players.findIndex(p => p.id === socket.id);
        if (idx2 !== -1) {
            ffaLobby.players.splice(idx2, 1);
            socket.leave('lobby_ffa');
        }

        // --- CREATE THE DUEL ---
        const duelId = `duel_${Date.now()}`;
        const seed = Math.floor(Math.random() * 1000000);

        duels[duelId] = {
            id: duelId,
            p1Id: challengerId,
            p2Id: socket.id,
            p1Name: ch.senderName,
            p2Name: socket.username,
            scores: {},
            round: 1,
            seed: seed,
            active: true
        };
        duels[duelId].scores[challengerId] = 0;
        duels[duelId].scores[socket.id] = 0;

        // Join duel room
        p1Socket.join(duelId);
        socket.join(duelId);

        // Update statuses
        if (onlinePlayers[challengerId]) onlinePlayers[challengerId].status = 'duel';
        if (onlinePlayers[socket.id]) onlinePlayers[socket.id].status = 'duel';
        broadcastPlayerList();

        // Notify both players to start the duel
        const duelData = {
            mode: 'duel',
            duelId: duelId,
            seed: seed,
            opponent: { id: socket.id, username: socket.username },
            scores: duels[duelId].scores,
            round: 1,
            p1Id: challengerId,
            p2Id: socket.id,
            p1Name: ch.senderName,
            p2Name: socket.username
        };

        // Challenger gets acceptor as opponent
        p1Socket.emit('duel_start', {
            ...duelData,
            opponent: { id: socket.id, username: socket.username }
        });

        // Acceptor gets challenger as opponent
        socket.emit('duel_start', {
            ...duelData,
            opponent: { id: challengerId, username: ch.senderName }
        });

        console.log(`Duel started: ${ch.senderName} vs ${socket.username} (${duelId})`);
    });

    // 4. Decline challenge
    socket.on('duel_decline', (challengerId) => {
        const ch = challenges[challengerId];
        if (ch && ch.targetId === socket.id) {
            clearTimeout(ch.timer);
            delete challenges[challengerId];
            io.to(challengerId).emit('receive_chat', { user: '[SYSTEM]', text: `${socket.username} declined your challenge.` });
            io.to(challengerId).emit('challenge_expired');
            socket.emit('receive_chat', { user: '[SYSTEM]', text: 'Challenge declined.' });
        }
    });

    // 5. Duel round loss report
    socket.on('duel_report_loss', (stats) => {
        const duel = findDuelByPlayer(socket.id);
        if (!duel || !duel.active) return;

        // The other player wins this round
        const winnerId = duel.p1Id === socket.id ? duel.p2Id : duel.p1Id;
        const winnerName = duel.p1Id === socket.id ? duel.p2Name : duel.p1Name;
        const loserName = duel.p1Id === socket.id ? duel.p1Name : duel.p2Name;

        duel.scores[winnerId]++;
        duel.round++;

        const s1 = duel.scores[duel.p1Id];
        const s2 = duel.scores[duel.p2Id];

        console.log(`Duel round: ${duel.p1Name} ${s1} - ${s2} ${duel.p2Name}`);

        // Check win condition: First to 6, Win by 2
        let matchOver = false;
        let matchWinnerId = null;
        let matchWinnerName = null;

        if (s1 >= 6 || s2 >= 6) {
            if (Math.abs(s1 - s2) >= 2) {
                matchOver = true;
                matchWinnerId = s1 > s2 ? duel.p1Id : duel.p2Id;
                matchWinnerName = s1 > s2 ? duel.p1Name : duel.p2Name;
            }
        }

        if (matchOver) {
            // --- DUEL FINISHED ---
            duel.active = false;

            // Record stats for both players
            const matchLoserName = matchWinnerName === duel.p1Name ? duel.p2Name : duel.p1Name;

            if (accounts[matchWinnerName]) {
                accounts[matchWinnerName].wins = (accounts[matchWinnerName].wins || 0) + 1;
                if (!accounts[matchWinnerName].history) accounts[matchWinnerName].history = [];
                accounts[matchWinnerName].history.push({
                    date: new Date().toISOString(),
                    place: 1,
                    apm: stats.apm || 0,
                    pps: stats.pps || 0,
                    sent: stats.sent || 0,
                    received: stats.recv || 0,
                    maxCombo: stats.maxCombo || 0,
                    type: 'duel',
                    vs: matchLoserName,
                    score: `${s1}-${s2}`
                });
                saveAccounts();
            }
            if (accounts[matchLoserName]) {
                if (!accounts[matchLoserName].history) accounts[matchLoserName].history = [];
                accounts[matchLoserName].history.push({
                    date: new Date().toISOString(),
                    place: 2,
                    apm: 0,
                    pps: 0,
                    sent: 0,
                    received: 0,
                    maxCombo: 0,
                    type: 'duel',
                    vs: matchWinnerName,
                    score: `${s1}-${s2}`
                });
                saveAccounts();
            }

            // Update winner's wins display
            const winSocket = io.sockets.sockets.get(matchWinnerId);
            if (winSocket && accounts[matchWinnerName]) {
                winSocket.emit('update_my_wins', accounts[matchWinnerName].wins);
            }

            io.emit('leaderboard_update', getLeaderboards());

            // Send duel_end to both players
            io.to(duel.id).emit('duel_end', {
                winnerName: matchWinnerName,
                loserName: matchLoserName,
                finalScores: duel.scores,
                p1Name: duel.p1Name,
                p2Name: duel.p2Name,
                p1Id: duel.p1Id,
                p2Id: duel.p2Id
            });

            // Clean up room after delay
            setTimeout(() => {
                const s1 = io.sockets.sockets.get(duel.p1Id);
                const s2 = io.sockets.sockets.get(duel.p2Id);
                if (s1) { s1.leave(duel.id); if (onlinePlayers[duel.p1Id]) onlinePlayers[duel.p1Id].status = 'idle'; }
                if (s2) { s2.leave(duel.id); if (onlinePlayers[duel.p2Id]) onlinePlayers[duel.p2Id].status = 'idle'; }
                delete duels[duel.id];
                broadcastPlayerList();
            }, 5000);

        } else {
            // --- NEXT ROUND ---
            const newSeed = Math.floor(Math.random() * 1000000);
            duel.seed = newSeed;

            io.to(duel.id).emit('duel_round_result', {
                roundWinnerName: winnerName,
                roundLoserName: loserName,
                scores: duel.scores,
                round: duel.round,
                newSeed: newSeed,
                p1Id: duel.p1Id,
                p2Id: duel.p2Id
            });
        }
    });
});

// ========================================================================
// HELPER FUNCTIONS
// ========================================================================

function findDuelByPlayer(socketId) {
    for (const d of Object.values(duels)) {
        if (d.p1Id === socketId || d.p2Id === socketId) return d;
    }
    return null;
}

function leaveDuel(socketId, reason) {
    const duel = findDuelByPlayer(socketId);
    if (!duel || !duel.active) return;

    duel.active = false;
    const oppId = duel.p1Id === socketId ? duel.p2Id : duel.p1Id;
    const oppName = duel.p1Id === socketId ? duel.p2Name : duel.p1Name;
    const leaverName = duel.p1Id === socketId ? duel.p1Name : duel.p2Name;

    // Award win to opponent
    io.to(oppId).emit('duel_end', {
        winnerName: oppName,
        loserName: leaverName,
        finalScores: duel.scores,
        p1Name: duel.p1Name,
        p2Name: duel.p2Name,
        p1Id: duel.p1Id,
        p2Id: duel.p2Id,
        reason: reason === 'disconnect' ? `${leaverName} disconnected` : `${leaverName} left`
    });

    const oppSocket = io.sockets.sockets.get(oppId);
    if (oppSocket) {
        oppSocket.leave(duel.id);
        if (onlinePlayers[oppId]) onlinePlayers[oppId].status = 'idle';
    }
    const leaverSocket = io.sockets.sockets.get(socketId);
    if (leaverSocket) leaverSocket.leave(duel.id);

    delete duels[duel.id];
    broadcastPlayerList();
}

function broadcastPlayerList() {
    const list = [];
    for (const [id, p] of Object.entries(onlinePlayers)) {
        if (p.username) {
            list.push({ id: id, username: p.username, status: p.status });
        }
    }
    io.emit('player_list_update', list);
}

function tryStartGame() {
    if (ffaLobby.state === 'waiting' && ffaLobby.players.length >= 2) {
        startFFARound();
    }
}

function startFFARound() {
    ffaLobby.state = 'countdown';
    ffaLobby.seed = Math.floor(Math.random() * 1000000);
    ffaLobby.matchStats = [];

    ffaLobby.players.forEach(p => {
        p.alive = true;
        p.damageLog = [];
    });

    console.log(`Starting FFA game with ${ffaLobby.players.length} players.`);

    // Send targetTime so client can sync countdown
    const targetTime = Date.now() + 3000;
    io.to('lobby_ffa').emit('start_countdown', { duration: 3, targetTime: targetTime });

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
            io.to(survivors[0].id).emit('request_win_stats');
        } else {
            finishGame(null);
        }
    }
}

function recordMatchStat(username, stats, isWinner, sTime) {
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

    // Update persistent accounts
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
                maxCombo: res.maxCombo,
                type: 'ffa'
            });
        }
    });
    saveAccounts();

    if (winnerName && accounts[winnerName]) {
        const winnerSocket = ffaLobby.players.find(p => p.username === winnerName);
        if (winnerSocket && io.sockets.sockets.get(winnerSocket.id)) {
            io.to(winnerSocket.id).emit('update_my_wins', accounts[winnerName].wins);
        }
    }

    io.emit('leaderboard_update', getLeaderboards());
    io.to('lobby_ffa').emit('match_summary', results);

    setTimeout(() => {
        if (ffaLobby.players.length >= 2) {
            startFFARound();
        } else {
            ffaLobby.state = 'waiting';
            io.to('lobby_ffa').emit('lobby_reset');
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

// --- START SERVER ---
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`SERVER RUNNING ON PORT ${PORT}`);
});
