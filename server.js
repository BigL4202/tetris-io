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

// --- CONSTANTS (Shared with Client) ---
const COLS = 10;
const ROWS = 20;
const PIECES = [
    [[1,1,1,1]],                // I
    [[1,1],[1,1]],              // O
    [[0,1,0],[1,1,1]],          // T
    [[1,1,0],[0,1,1]],          // S
    [[0,1,1],[1,1,0]],          // Z
    [[1,0,0],[1,1,1]],          // J
    [[0,0,1],[1,1,1]]           // L
];
// SRS Offsets (Simplified for Server)
const OFFSETS_JLSTZ = [[[0,0],[0,0],[0,0],[0,0],[0,0]],[[0,0],[1,0],[1,-1],[0,2],[1,2]],[[0,0],[0,0],[0,0],[0,0],[0,0]],[[0,0],[-1,0],[-1,-1],[0,2],[-1,2]]];
const OFFSETS_I = [[[0,0],[-1,0],[2,0],[-1,0],[2,0]],[[0,-1],[0,-1],[0,-1],[0,1],[0,-2]],[[-1,0],[0,0],[0,0],[0,1],[0,-2]],[[0,1],[0,1],[0,1],[0,-1],[0,2]]];

// --- SERVER GAME ENGINE ---
class GameInstance {
    constructor(id, username) {
        this.id = id;
        this.username = username;
        this.grid = Array.from({length: ROWS}, () => Array(COLS).fill(0));
        this.bag = [];
        this.queue = [];
        this.holdId = null;
        this.canHold = true;
        this.active = null;
        this.score = 0;
        this.combo = -1;
        this.b2b = 0;
        this.garbageQueue = 0;
        this.alive = true;
        this.lastUpdate = Date.now();
        
        // Populate queue
        for(let i=0; i<4; i++) this.queue.push(this.pull());
        this.spawn();
    }

    pull() {
        if (this.bag.length === 0) {
            this.bag = [0,1,2,3,4,5,6];
            for (let i = this.bag.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [this.bag[i], this.bag[j]] = [this.bag[j], this.bag[i]];
            }
        }
        return this.bag.pop();
    }

    spawn() {
        const id = this.queue.shift();
        this.queue.push(this.pull());
        this.active = {
            id: id,
            matrix: PIECES[id],
            pos: {x: 3, y: -2}, // Spawn slightly higher
            rotation: 0
        };
        this.canHold = true;
        
        if (this.collide()) {
            this.alive = false; // Top out immediately
        }
    }

    collide(pos = this.active.pos, matrix = this.active.matrix) {
        for(let y=0; y<matrix.length; y++) {
            for(let x=0; x<matrix[y].length; x++) {
                if(matrix[y][x]) {
                    const gx = x + pos.x;
                    const gy = y + pos.y;
                    if (gx < 0 || gx >= COLS || gy >= ROWS) return true;
                    if (gy >= 0 && this.grid[gy][gx]) return true;
                }
            }
        }
        return false;
    }

    rotate(dir) {
        if (!this.active) return;
        const currentRot = this.active.rotation;
        const newRot = (currentRot + dir + 4) % 4;
        const newMatrix = this.active.matrix[0].map((_, i) => this.active.matrix.map(row => row[i]).reverse()); // Simple 90 deg rotation
        
        // Basic Wall Kick (Simplified)
        const kicks = (this.active.id === 0 ? OFFSETS_I : OFFSETS_JLSTZ)[currentRot]; // Simplified lookup
        if(!kicks) {
             // Fallback to basic rotation if no kick table match
             if(!this.collide(this.active.pos, newMatrix)) {
                 this.active.matrix = newMatrix;
                 this.active.rotation = newRot;
             }
             return;
        }

        // Try kicks
        for (let i = 0; i < kicks.length; i++) {
            const offset = kicks[i];
            const testPos = { x: this.active.pos.x + offset[0], y: this.active.pos.y - offset[1] };
            if (!this.collide(testPos, newMatrix)) {
                this.active.pos = testPos;
                this.active.matrix = newMatrix;
                this.active.rotation = newRot;
                return;
            }
        }
    }

    move(dir) {
        if (!this.active) return;
        this.active.pos.x += dir;
        if (this.collide()) this.active.pos.x -= dir;
    }

    softDrop() {
        if (!this.active) return false;
        this.active.pos.y++;
        if (this.collide()) {
            this.active.pos.y--;
            this.lock();
            return true; // Locked
        }
        return false;
    }

    hardDrop() {
        if (!this.active) return;
        while (!this.collide()) {
            this.active.pos.y++;
        }
        this.active.pos.y--;
        this.lock();
    }

    lock() {
        if (!this.active) return;
        // Commit to grid
        this.active.matrix.forEach((row, y) => {
            row.forEach((val, x) => {
                if (val) {
                    const gy = y + this.active.pos.y;
                    if (gy >= 0 && gy < ROWS) {
                        this.grid[gy][x + this.active.pos.x] = this.active.id + 1; // Store ID+1 (1-7)
                    } else {
                        this.alive = false; // Block locked above grid
                    }
                }
            });
        });

        if (!this.alive) return;

        // Clear Lines
        let lines = 0;
        for (let y = ROWS - 1; y >= 0; y--) {
            if (this.grid[y].every(cell => cell !== 0)) {
                this.grid.splice(y, 1);
                this.grid.unshift(Array(COLS).fill(0));
                lines++;
                y++;
            }
        }

        // Calculate Garbage / Combo
        if (lines > 0) {
            this.combo++;
            let atk = (lines === 4) ? 4 : (lines - 1); // Basic: Quad=4, Triple=2, Double=1
            if (this.combo > 0) atk += Math.floor(this.combo / 2);
            
            // Cancel incoming garbage
            if (this.garbageQueue > 0) {
                const cancelled = Math.min(this.garbageQueue, atk);
                this.garbageQueue -= cancelled;
                atk -= cancelled;
            }
            
            // Send remaining attack
            if (atk > 0) {
                io.to('lobby_ffa').emit('garbage_sent', { senderId: this.id, amount: atk });
            }
        } else {
            this.combo = -1;
            // Receive Garbage if no line clear
            if (this.garbageQueue > 0) {
                const amount = Math.min(this.garbageQueue, 8); // Cap per frame
                this.garbageQueue -= amount;
                for(let i=0; i<amount; i++) {
                    const hole = Math.floor(Math.random() * COLS);
                    const row = Array(COLS).fill(8); // 8 = Garbage Color
                    row[hole] = 0;
                    this.grid.shift();
                    this.grid.push(row);
                }
            }
        }

        this.spawn();
    }

    getState() {
        return {
            id: this.id,
            grid: this.grid,
            active: this.active,
            hold: this.holdId,
            queue: this.queue.slice(0, 3), // Show next 3
            alive: this.alive
        };
    }
}

// --- SERVER LOOP (60 TPS) ---
const TICK_RATE = 1000 / 60;
let games = {}; // Map socket.id -> GameInstance

setInterval(() => {
    Object.values(games).forEach(game => {
        if (game.alive) {
            // Gravity (Simple: 1 row every 0.5s)
            if (Date.now() - game.lastUpdate > 500) {
                game.softDrop();
                game.lastUpdate = Date.now();
            }
        }
    });
    
    // Broadcast State to Everyone
    const gameState = Object.values(games).map(g => g.getState());
    io.to('lobby_ffa').emit('game_update', gameState);

}, TICK_RATE);


// --- SOCKET HANDLERS ---
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('join_game', (username) => {
        socket.join('lobby_ffa');
        games[socket.id] = new GameInstance(socket.id, username || "Guest");
    });

    // INPUTS (Client sends intent, Server executes)
    socket.on('input', (action) => {
        const game = games[socket.id];
        if (!game || !game.alive) return;

        switch(action) {
            case 'left': game.move(-1); break;
            case 'right': game.move(1); break;
            case 'rotate': game.rotate(1); break;
            case 'soft': game.softDrop(); break;
            case 'hard': game.hardDrop(); break;
            case 'hold': 
                if (game.canHold) {
                    const cur = game.active.id;
                    if (game.holdId === null) {
                        game.holdId = cur;
                        game.spawn();
                    } else {
                        const temp = game.holdId;
                        game.holdId = cur;
                        game.active.id = temp;
                        game.active.matrix = PIECES[temp];
                        game.active.pos = {x:3, y:-2};
                    }
                    game.canHold = false;
                }
                break;
        }
    });

    // Receive Garbage from other players (Internal logic)
    socket.on('garbage_sent', (data) => {
        // Distribute to others
        Object.values(games).forEach(g => {
            if (g.id !== socket.id && g.alive) {
                g.garbageQueue += data.amount;
            }
        });
    });

    socket.on('disconnect', () => {
        delete games[socket.id];
    });
});

http.listen(3000, () => console.log('SERVER RUNNING - AUTHORITATIVE MODE'));
