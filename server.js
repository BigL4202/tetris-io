const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

let waitingPlayer = null;

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    socket.on('join_game', () => {
        if (waitingPlayer) {
            // Match found!
            const room = waitingPlayer.id + '#' + socket.id;
            socket.join(room);
            waitingPlayer.join(room);

            // Tell players who they are
            io.to(waitingPlayer.id).emit('match_start', { role: 'p1', room: room });
            io.to(socket.id).emit('match_start', { role: 'p2', room: room });
            
            waitingPlayer = null;
        } else {
            // Wait for opponent
            waitingPlayer = socket;
            socket.emit('waiting');
        }
    });

    // Relay Garbage Attacks
    socket.on('send_garbage', (data) => {
        socket.to(data.room).emit('receive_garbage', data.amount);
    });

    // Relay Board State (So you can see the enemy)
    socket.on('update_board', (data) => {
        socket.to(data.room).emit('enemy_board', data.grid);
    });

    // Handle Game Over
    socket.on('player_lost', (room) => {
        socket.to(room).emit('game_won');
    });

    socket.on('disconnect', () => {
        if (waitingPlayer === socket) waitingPlayer = null;
    });
});

http.listen(3000, () => {
    console.log('Server running on http://localhost:3000');
});