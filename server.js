const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

// ROOM MANAGER
// Room Structure: { id, name, pass, mode, players: [], state: 'waiting'|'countdown'|'playing'|'finished', scores: {} }
const rooms = new Map();

io.on('connection', (socket) => {
    
    // --- LOBBY MANAGEMENT ---

    socket.on('get_rooms', () => {
        // Send list of public rooms
        const publicRooms = Array.from(rooms.values())
            .filter(r => !r.pass) // Only show non-password rooms in browser
            .map(r => ({ id: r.id, name: r.name, mode: r.mode, count: r.players.length, state: r.state }));
        socket.emit('room_list', publicRooms);
    });

    socket.on('create_room', (data) => {
        // data: { name, pass, mode, username }
        const roomId = Math.random().toString(36).substring(2, 9);
        const newRoom = {
            id: roomId,
            name: data.name || "Untitled Room",
            pass: data.pass || null,
            mode: data.mode, // 'duel' or 'ffa'
            players: [],
            state: 'waiting',
            scores: {} // Map: username -> wins
        };
        rooms.set(roomId, newRoom);
        joinRoom(socket, roomId, data.username);
    });

    socket.on('join_room', (data) => {
        // data: { id, pass, username }
        const room = rooms.get(data.id);
        
        if (!room) { socket.emit('err', "Room not found."); return; }
        if (room.pass && room.pass !== data.pass) { socket.emit('err', "Incorrect Password."); return; }
        if (room.state !== 'waiting') { socket.emit('err', "Match in progress."); return; }
        if (room.mode === 'duel' && room.players.length >= 2) { socket.emit('err', "Room Full."); return; }

        joinRoom(socket, data.id, data.username);
    });

    // --- GAME FLOW ---

    socket.on('request_start', () => {
        const room = getRoomBySocket(socket.id);
        if (!room) return;
        // Only host (first player) can start, or auto-start logic could go here
        if (room.players[0].id !== socket.id) return;
        if (room.players.length < 2) return;

        startCountdown(room.id);
    });

    socket.on('send_garbage', (data) => {
        const room = getRoomBySocket(socket.id);
        if(!room || room.state !== 'playing') return;

        const targets = room.players.filter(p => p.alive && p.id !== socket.id);
        if (targets.length > 0) {
            let dmg = data.amount;
            if (room.mode === 'ffa') {
                dmg = Math.floor(data.amount / targets.length);
                if(data.amount >= 4 && dmg === 0) dmg = 1; 
            }
            if (dmg > 0) targets.forEach(t => io.to(t.id).emit('receive_garbage', dmg));
        }
    });

    socket.on('update_board', (grid) => {
        const room = getRoomBySocket(socket.id);
        if(room) socket.to(room.id).emit('enemy_board_update', { id: socket.id, grid: grid });
    });

    socket.on('player_died', () => {
        const room = getRoomBySocket(socket.id);
        if (!room || room.state !== 'playing') return;

        const player = room.players.find(p => p.id === socket.id);
        if (player && player.alive) {
            player.alive = false;
            io.to(room.id).emit('elimination', { username: player.username });
            checkWinCondition(room);
        }
    });

    socket.on('disconnect', () => {
        const room = getRoomBySocket(socket.id);
        if (room) {
            const p = room.players.find(x => x.id === socket.id);
            room.players = room.players.filter(p => p.id !== socket.id);
            
            // Cleanup empty rooms
            if (room.players.length === 0) {
                rooms.delete(room.id);
            } else {
                // If game was running and player died/left
                if(room.state === 'playing' && p.alive) {
                    io.to(room.id).emit('elimination', { username: p.username });
                    checkWinCondition(room);
                }
                io.to(room.id).emit('lobby_update', { 
                    players: room.players.map(p => ({ id: p.id, username: p.username, score: room.scores[p.username] || 0 })),
                    isHost: room.players[0].id 
                });
            }
        }
    });
});

// --- HELPERS ---

function joinRoom(socket, roomId, username) {
    const room = rooms.get(roomId);
    socket.join(roomId);
    
    // Add player
    room.players.push({ id: socket.id, username: username.substring(0,12), alive: true });
    
    // Init score if new
    if(room.scores[username] === undefined) room.scores[username] = 0;

    socket.emit('joined_room', { 
        roomName: room.name, 
        mode: room.mode,
        id: roomId
    });

    io.to(roomId).emit('lobby_update', { 
        players: room.players.map(p => ({ id: p.id, username: p.username, score: room.scores[p.username] || 0 })),
        isHost: room.players[0].id // Send ID of host so client knows if they can click start
    });
}

function startCountdown(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;

    room.state = 'countdown';
    room.players.forEach(p => p.alive = true); // Revive everyone
    
    // Generate Seed
    const seed = Math.floor(Math.random() * 1000000);

    // 1. Tell clients to show countdown overlay
    io.to(roomId).emit('start_countdown', { duration: 3 });

    // 2. Wait 3 seconds, then start
    setTimeout(() => {
        if(!rooms.has(roomId)) return;
        room.state = 'playing';
        io.to(roomId).emit('match_start', { 
            seed: seed,
            players: room.players.map(p => ({ id: p.id, username: p.username })) 
        });
    }, 3000);
}

function checkWinCondition(room) {
    const survivors = room.players.filter(p => p.alive);

    if (survivors.length <= 1) {
        room.state = 'finished';
        let winnerName = "No One";
        
        if (survivors.length === 1) {
            winnerName = survivors[0].username;
            // Update Score
            room.scores[winnerName] = (room.scores[winnerName] || 0) + 1;
        }

        // 1. Send Round Over (Show Winner Name)
        io.to(room.id).emit('round_over', { 
            winner: winnerName, 
            scores: room.scores 
        });

        // 2. Wait 3 Seconds (Display Winner), then Restart Countdown
        setTimeout(() => {
            if (rooms.has(room.id) && room.players.length >= 2) {
                startCountdown(room.id);
            } else {
                // Not enough players to restart, go back to waiting
                room.state = 'waiting';
                io.to(room.id).emit('lobby_reset'); // Tell clients to show "Waiting for players"
            }
        }, 3000);
    }
}

function getRoomBySocket(socketId) {
    for (const room of rooms.values()) {
        if (room.players.find(p => p.id === socketId)) return room;
    }
    return null;
}

http.listen(3000, () => {
    console.log('Server running on 3000');
});