const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

// --- GLOBAL STATE ---

// DUEL SYSTEM
let duelQueue = []; // Array of sockets waiting for 1v1

// FFA SYSTEM
let ffaPlayers = []; // { id, username, alive, socket }
let ffaState = 'waiting'; // 'waiting', 'countdown', 'playing', 'finished'
let ffaSeed = 12345;

io.on('connection', (socket) => {
    
    // --- DUEL MATCHMAKING ---
    socket.on('join_duel_queue', (username) => {
        socket.username = (username || "Player").substring(0,12);
        duelQueue.push(socket);
        
        // Check for match
        if (duelQueue.length >= 2) {
            const p1 = duelQueue.shift();
            const p2 = duelQueue.shift();
            
            const roomID = 'duel_' + p1.id + '_' + p2.id;
            const seed = Math.floor(Math.random() * 1000000);
            
            p1.join(roomID);
            p2.join(roomID);
            
            // 3s Countdown then start
            io.to(roomID).emit('start_countdown', { duration: 3 });
            
            setTimeout(() => {
                io.to(roomID).emit('match_start', { 
                    mode: 'duel',
                    seed: seed,
                    players: [
                        { id: p1.id, username: p1.username },
                        { id: p2.id, username: p2.username }
                    ]
                });
            }, 3000);
        }
    });

    // --- FFA SYSTEM ---
    socket.on('join_ffa', (username) => {
        socket.username = (username || "Player").substring(0,12);
        socket.join('ffa_room');
        
        // Determine state
        let isAlive = false;
        
        if (ffaState === 'waiting' || ffaState === 'finished') {
            isAlive = true;
            ffaPlayers.push({ id: socket.id, username: socket.username, alive: true, socket: socket });
            io.to('ffa_room').emit('lobby_update', { count: ffaPlayers.length });
            checkFFAStart();
        } else {
            // Join as spectator
            isAlive = false;
            // Send current game data to spectator
            const livingPlayers = ffaPlayers.filter(p => p.alive).map(p => ({ id: p.id, username: p.username }));
            socket.emit('ffa_spectate', { seed: ffaSeed, players: livingPlayers });
            ffaPlayers.push({ id: socket.id, username: socket.username, alive: false, socket: socket });
        }
    });

    // --- SHARED GAMEPLAY LOGIC ---
    socket.on('send_garbage', (data) => {
        // data: { mode, amount }
        if (data.mode === 'duel') {
            socket.broadcast.to(Array.from(socket.rooms)[1]).emit('receive_garbage', data.amount);
        } else if (data.mode === 'ffa' && ffaState === 'playing') {
            // Split Trash Logic
            const targets = ffaPlayers.filter(p => p.alive && p.id !== socket.id);
            if (targets.length > 0) {
                let split = Math.floor(data.amount / targets.length);
                if (data.amount >= 4 && split === 0) split = 1; // Pity trash
                if (split > 0) {
                    targets.forEach(t => io.to(t.id).emit('receive_garbage', split));
                }
            }
        }
    });

    socket.on('update_board', (grid) => {
        // Relay board to room (Duel opponent or FFA spectators/enemies)
        const room = Array.from(socket.rooms).find(r => r !== socket.id);
        if(room) socket.to(room).emit('enemy_board_update', { id: socket.id, grid: grid });
    });

    socket.on('player_died', () => {
        // Find player in FFA
        const p = ffaPlayers.find(x => x.id === socket.id);
        if (p && ffaState === 'playing' && p.alive) {
            p.alive = false;
            io.to('ffa_room').emit('elimination', { username: p.username });
            checkFFAWin();
        }
        
        // Handle Duel Death
        const rooms = Array.from(socket.rooms).filter(r => r.startsWith('duel_'));
        rooms.forEach(r => {
            socket.to(r).emit('duel_win', { winner: "Opponent" }); // Opponent wins if I die
        });
    });

    socket.on('disconnect', () => {
        // Remove from Duel Queue
        duelQueue = duelQueue.filter(s => s.id !== socket.id);
        
        // Remove from FFA
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

// --- FFA LOOP HELPERS ---
function checkFFAStart() {
    if (ffaState === 'waiting' && ffaPlayers.length >= 2) {
        startFFARound();
    }
}

function startFFARound() {
    ffaState = 'countdown';
    ffaSeed = Math.floor(Math.random() * 1000000);
    
    // Revive everyone
    ffaPlayers.forEach(p => p.alive = true);
    
    // 1. Countdown
    io.to('ffa_room').emit('start_countdown', { duration: 3 });
    
    // 2. Start
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
        let winner = survivors.length === 1 ? survivors[0].username : "No One";
        
        // 1. Show Winner (3s duration)
        io.to('ffa_room').emit('round_over', { winner: winner });
        
        // 2. Wait 3s, then check restart
        setTimeout(() => {
            if (ffaPlayers.length >= 2) {
                startFFARound(); // Loop back to countdown
            } else {
                ffaState = 'waiting';
                io.to('ffa_room').emit('lobby_reset'); // Go back to "Waiting for players"
            }
        }, 3000);
    }
}

http.listen(3000, () => { console.log('Server on 3000'); });