const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

// ROOMS: { id, name, pass, mode, players: [], state, scores: {} }
const rooms = new Map();

io.on('connection', (socket) => {
    
    // --- LOBBY BROWSING ---
    socket.on('get_rooms', () => {
        const list = Array.from(rooms.values())
            .filter(r => !r.pass)
            .map(r => ({ id: r.id, name: r.name, mode: r.mode, count: r.players.length, state: r.state }));
        socket.emit('room_list', list);
    });

    socket.on('create_room', (data) => {
        const id = Math.random().toString(36).substring(2, 8);
        const room = {
            id: id,
            name: data.name || "Room " + id,
            pass: data.pass || null,
            mode: data.mode, // 'duel' or 'ffa'
            players: [],
            state: 'waiting', // waiting, countdown, playing, finished
            scores: {} 
        };
        rooms.set(id, room);
        joinRoom(socket, id, data.username);
    });

    socket.on('join_room', (data) => {
        const room = rooms.get(data.id);
        if (!room) return socket.emit('err', "Room does not exist.");
        if (room.pass && room.pass !== data.pass) return socket.emit('err', "Wrong Password.");
        if (room.state !== 'waiting' && room.state !== 'finished') return socket.emit('err', "Match in progress.");
        if (room.mode === 'duel' && room.players.length >= 2) return socket.emit('err', "Room is full.");
        
        joinRoom(socket, data.id, data.username);
    });

    // --- GAMEPLAY ---
    socket.on('request_start', () => {
        const room = getRoom(socket.id);
        if (room && room.players.length >= 2 && room.state === 'waiting') {
            startCountdown(room);
        }
    });

    socket.on('send_garbage', (data) => {
        const room = getRoom(socket.id);
        if (!room || room.state !== 'playing') return;
        
        const targets = room.players.filter(p => p.alive && p.id !== socket.id);
        if (targets.length > 0) {
            let dmg = data.amount;
            // FFA Split Logic
            if (room.mode === 'ffa') {
                dmg = Math.floor(data.amount / targets.length);
                if (data.amount >= 4 && dmg === 0) dmg = 1;
            }
            if (dmg > 0) targets.forEach(t => io.to(t.id).emit('receive_garbage', dmg));
        }
    });

    socket.on('update_board', (grid) => {
        const room = getRoom(socket.id);
        if (room) socket.to(room.id).emit('enemy_board_update', { id: socket.id, grid: grid });
    });

    socket.on('player_died', () => {
        const room = getRoom(socket.id);
        if (!room || room.state !== 'playing') return;
        
        const p = room.players.find(x => x.id === socket.id);
        if (p && p.alive) {
            p.alive = false;
            io.to(room.id).emit('elimination', { username: p.username });
            checkWin(room);
        }
    });

    socket.on('disconnect', () => {
        const room = getRoom(socket.id);
        if (room) {
            const p = room.players.find(x => x.id === socket.id);
            room.players = room.players.filter(x => x.id !== socket.id);
            
            if (room.players.length === 0) {
                rooms.delete(room.id);
            } else {
                if (room.state === 'playing' && p.alive) {
                    io.to(room.id).emit('elimination', { username: p.username });
                    checkWin(room);
                }
                broadcastLobby(room);
            }
        }
    });
});

// --- LOGIC HELPERS ---
function joinRoom(socket, id, username) {
    const room = rooms.get(id);
    socket.join(id);
    const safeName = (username || "Player").substring(0, 12);
    
    // Init score if not exists
    if (!room.scores[safeName]) room.scores[safeName] = 0;
    
    room.players.push({ id: socket.id, username: safeName, alive: true });
    
    socket.emit('joined_room', { name: room.name, mode: room.mode });
    broadcastLobby(room);
}

function broadcastLobby(room) {
    const list = room.players.map(p => ({
        username: p.username,
        score: room.scores[p.username],
        isHost: (room.players[0].id === p.id)
    }));
    io.to(room.id).emit('lobby_update', { players: list, isHost: list[0] && list[0].isHost });
}

function startCountdown(room) {
    room.state = 'countdown';
    room.players.forEach(p => p.alive = true); // Revive all
    const seed = Math.floor(Math.random() * 1000000);
    
    io.to(room.id).emit('start_countdown', { duration: 3 });
    
    setTimeout(() => {
        if (!rooms.has(room.id)) return;
        if (room.players.length < 2) {
            room.state = 'waiting';
            io.to(room.id).emit('reset_to_lobby'); // Not enough players to start
            return;
        }
        room.state = 'playing';
        io.to(room.id).emit('match_start', { 
            seed: seed, 
            players: room.players.map(p => ({ id: p.id, username: p.username })) 
        });
    }, 3000);
}

function checkWin(room) {
    const survivors = room.players.filter(p => p.alive);
    
    // Win Condition: 1 survivor (or 0 if trade)
    if (survivors.length <= 1) {
        room.state = 'finished';
        let winner = "No One";
        
        if (survivors.length === 1) {
            winner = survivors[0].username;
            room.scores[winner]++;
        }
        
        // 1. Show Win Screen
        io.to(room.id).emit('round_over', { winner: winner, scores: room.scores });
        broadcastLobby(room); // Update scores in UI

        // 2. Wait 3s -> Start Countdown loop
        setTimeout(() => {
            if (rooms.has(room.id) && room.players.length >= 2) {
                startCountdown(room);
            } else {
                room.state = 'waiting';
                if(rooms.has(room.id)) io.to(room.id).emit('reset_to_lobby');
            }
        }, 3000);
    }
}

function getRoom(socketId) {
    for (const r of rooms.values()) {
        if (r.players.find(p => p.id === socketId)) return r;
    }
    return null;
}

http.listen(3000, () => { console.log('Server on 3000'); });