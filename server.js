const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const fs = require('fs');
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));
app.get('/', (req, res) => {
    const pub = path.join(__dirname, 'public', 'index.html');
    if (fs.existsSync(pub)) res.sendFile(pub);
    else res.sendFile(path.join(__dirname, 'index.html'));
});

const DATA_FILE = path.join(__dirname, 'accounts.json');
const BUGS_FILE = path.join(__dirname, 'bugs.json');
let accounts = {};
let bugReports = [];
function loadAccounts() { try { if (fs.existsSync(DATA_FILE)) accounts = JSON.parse(fs.readFileSync(DATA_FILE)); } catch(e) { accounts = {}; } }
function saveAccounts() { try { fs.writeFileSync(DATA_FILE, JSON.stringify(accounts, null, 2)); } catch(e) {} }
function loadBugs() { try { if (fs.existsSync(BUGS_FILE)) bugReports = JSON.parse(fs.readFileSync(BUGS_FILE)); } catch(e) { bugReports = []; } }
function saveBugs() { try { fs.writeFileSync(BUGS_FILE, JSON.stringify(bugReports, null, 2)); } catch(e) {} }
loadAccounts(); loadBugs();

// === STATE ===
let onlinePlayers = {};

// Regular FFA (direct join, no queue)
let ffaLobby = { players: [], state: 'waiting', seed: 0, matchStats: [], startTime: 0, timer: null };

// Mutator Madness FFA (direct join)
let mmLobby = { players: [], state: 'waiting', seed: 0, matchStats: [], startTime: 0, timer: null };

// Queues (duel and 2v2 only)
let duelQueue = [];
let twovtwoQueue = [];

// Active games
let duels = {};
let twovtwos = {};
let teamInvites = {};
let duelChallenges = {}; // challengerId -> {targetId, targetName, senderName, timer}
let timedOutPlayers = {}; // username -> expiry timestamp

// Garbage accumulation tracking: sid -> fractional garbage pending
let garbageAccum = {};

function bp() {
    const list = Object.values(onlinePlayers).map(p => ({ id: p.id, username: p.username, status: p.status }));
    io.emit('player_list_update', list);
}

function findDuel(sid) { for (const d of Object.values(duels)) { if (d.active && (d.p1Id === sid || d.p2Id === sid)) return d; } return null; }
function find2v2(sid) { for (const g of Object.values(twovtwos)) { if (g.active && [...g.t1, ...g.t2].some(p => p.id === sid)) return g; } return null; }

// === GARBAGE DISTRIBUTION (equal split with decimal accumulation) ===
function distributeGarbage(senderId, amount, lobby, lobbyRoom, mode) {
    const sender = lobby.players.find(p => p.id === senderId);
    if (!sender || !sender.alive) return;
    sender.lastActivity = Date.now();
    const targets = lobby.players.filter(p => p.alive && p.id !== senderId);
    if (!targets.length) return;
    const perPlayer = amount / targets.length;
    const rounded = Math.round(perPlayer * 100) / 100;
    targets.forEach(t => {
        t.damageLog.push({ attacker: sender.username, amount: rounded, time: Date.now() });
        if (!garbageAccum[t.id]) garbageAccum[t.id] = 0;
        garbageAccum[t.id] += rounded;
        const whole = Math.floor(garbageAccum[t.id]);
        if (whole >= 1) {
            const toSend = Math.min(whole, 10);
            garbageAccum[t.id] -= toSend;
            garbageAccum[t.id] = Math.round(garbageAccum[t.id] * 100) / 100;
            io.to(t.id).emit('receive_garbage', toSend);
        }
    });
}

function distribute2v2Garbage(senderId, amount, game) {
    const myTeam = game.t1.some(p => p.id === senderId) ? 't1' : 't2';
    const enemies = myTeam === 't1' ? game.t2 : game.t1;
    const alive = enemies.filter(p => !game.deadThisRound.includes(p.id));
    if (!alive.length) return;
    const perPlayer = amount / alive.length;
    const rounded = Math.round(perPlayer * 100) / 100;
    alive.forEach(t => {
        if (!garbageAccum[t.id]) garbageAccum[t.id] = 0;
        garbageAccum[t.id] += rounded;
        const whole = Math.floor(garbageAccum[t.id]);
        if (whole >= 1) {
            const toSend = Math.min(whole, 10);
            garbageAccum[t.id] -= toSend;
            garbageAccum[t.id] = Math.round(garbageAccum[t.id] * 100) / 100;
            io.to(t.id).emit('receive_garbage', toSend);
        }
    });
}

// === MUTATOR MADNESS: Targeted garbage ===
function sendToLeader(senderId, amount, lobby) {
    // Find player with most lines sent (leader)
    let leader = null, maxSent = -1;
    lobby.players.filter(p => p.alive && p.id !== senderId).forEach(p => {
        if ((p.linesSent || 0) > maxSent) { maxSent = p.linesSent || 0; leader = p; }
    });
    if (leader) {
        if (!garbageAccum[leader.id]) garbageAccum[leader.id] = 0;
        garbageAccum[leader.id] += amount;
        const whole = Math.floor(garbageAccum[leader.id]);
        if (whole >= 1) { const toSend = Math.min(whole, 10); garbageAccum[leader.id] -= toSend; io.to(leader.id).emit('receive_garbage', toSend); }
    }
}

function sendToHighestBoard(senderId, amount, lobby) {
    let target = null, maxH = -1;
    lobby.players.filter(p => p.alive && p.id !== senderId).forEach(p => {
        if ((p.boardHeight || 0) > maxH) { maxH = p.boardHeight || 0; target = p; }
    });
    if (target) {
        if (!garbageAccum[target.id]) garbageAccum[target.id] = 0;
        garbageAccum[target.id] += amount;
        const whole = Math.floor(garbageAccum[target.id]);
        if (whole >= 1) { const toSend = Math.min(whole, 10); garbageAccum[target.id] -= toSend; io.to(target.id).emit('receive_garbage', toSend); }
    }
}

// === LEAVE GAME (with proper cleanup) ===
function leaveGame(sid, reason) {
    const duel = findDuel(sid);
    if (duel && duel.active) {
        duel.active = false;
        const wId = duel.p1Id === sid ? duel.p2Id : duel.p1Id;
        const wS = io.sockets.sockets.get(wId);
        const wN = duel.p1Id === wId ? duel.p1Name : duel.p2Name;
        const lN = duel.p1Id === sid ? duel.p1Name : duel.p2Name;
        if (wS) {
            saveDuelResult(wN, lN, duel.scores[duel.p1Id]||0, duel.scores[duel.p2Id]||0);
            io.to(duel.id).emit('duel_end', { winnerName:wN, loserName:lN, finalScores:duel.scores, p1Id:duel.p1Id, p2Id:duel.p2Id, p1Name:duel.p1Name, p2Name:duel.p2Name, reason: reason||'Forfeit' });
        }
        io.emit('leaderboard_update', getLeaderboards());
        [duel.p1Id,duel.p2Id].forEach(pid => { const s=io.sockets.sockets.get(pid); if(s) s.leave(duel.id); if(onlinePlayers[pid]) onlinePlayers[pid].status='idle'; });
        bp(); delete duels[duel.id];
        return;
    }
    const game = find2v2(sid);
    if (game && game.active) {
        game.active = false;
        const myTeam = game.t1.some(p=>p.id===sid) ? 't1' : 't2';
        const winTeam = myTeam === 't1' ? 't2' : 't1';
        const wNames = game[winTeam].map(p=>p.name).join(' & ');
        const lNames = game[myTeam].map(p=>p.name).join(' & ');
        io.to(game.id).emit('twovtwo_end', { winTeam, winNames: wNames, loseNames: lNames, scores: game.scores, reason: reason||'Forfeit' });
        [...game.t1,...game.t2].forEach(p => { const s=io.sockets.sockets.get(p.id); if(s) s.leave(game.id); if(onlinePlayers[p.id]) onlinePlayers[p.id].status='idle'; });
        bp(); delete twovtwos[game.id];
    }
}

function saveDuelResult(wN, lN, s1, s2) {
    const sc = `${s1}-${s2}`;
    if(accounts[wN]){accounts[wN].wins=(accounts[wN].wins||0)+1; if(!accounts[wN].history)accounts[wN].history=[]; accounts[wN].history.push({date:new Date().toISOString(),type:'duel',place:1,vs:lN,score:sc});}
    if(accounts[lN]){if(!accounts[lN].history)accounts[lN].history=[]; accounts[lN].history.push({date:new Date().toISOString(),type:'duel',place:2,vs:wN,score:sc});}
    saveAccounts();
}

// === PERIODIC PROCESSOR ===
setInterval(() => {
    // Duel queue: pair up 2
    while (duelQueue.length >= 2) {
        const p1Id = duelQueue.shift();
        const p2Id = duelQueue.shift();
        const p1S = io.sockets.sockets.get(p1Id);
        const p2S = io.sockets.sockets.get(p2Id);
        if (!p1S || !p1S.username) { if(p2S) duelQueue.unshift(p2Id); continue; }
        if (!p2S || !p2S.username) { duelQueue.unshift(p1Id); continue; }
        startDuel(p1Id, p1S.username, p2Id, p2S.username);
    }

    // 2v2 queue: pair teams
    while (twovtwoQueue.length >= 2) {
        const t1 = twovtwoQueue.shift();
        const t2 = twovtwoQueue.shift();
        const allIds = [t1.p1Id, t1.p2Id, t2.p1Id, t2.p2Id];
        if (!allIds.every(id => io.sockets.sockets.get(id))) {
            if(io.sockets.sockets.get(t1.p1Id) && io.sockets.sockets.get(t1.p2Id)) twovtwoQueue.unshift(t1);
            if(io.sockets.sockets.get(t2.p1Id) && io.sockets.sockets.get(t2.p2Id)) twovtwoQueue.unshift(t2);
            break;
        }
        start2v2(t1, t2);
    }

    // FFA watchdog
    [ffaLobby, mmLobby].forEach((lobby, li) => {
        const room = li === 0 ? 'lobby_ffa' : 'lobby_mm';
        if (lobby.state === 'playing') {
            const now = Date.now();
            lobby.players.filter(p => p.alive && (now - p.lastActivity > 15000)).forEach(p => {
                io.to(p.id).emit('force_disconnect', 'Kicked for inactivity.');
                handleLobbyDeath(p.id, { apm:0, sent:0 }, "AFK", lobby, room);
                removeFromLobby(p.id, lobby, room);
            });
        }
        if (lobby.state !== 'waiting' && lobby.players.length === 0) forceLobbyReset(lobby, room);
        if (lobby.state === 'playing' && lobby.players.length === 1) checkLobbyWin(lobby, room);
    });

    // Clean stale duels where both players disconnected
    for (const [dId, d] of Object.entries(duels)) {
        if (!d.active) continue;
        const p1Online = io.sockets.sockets.get(d.p1Id);
        const p2Online = io.sockets.sockets.get(d.p2Id);
        if (!p1Online && !p2Online) {
            d.active = false;
            delete duels[dId];
        }
    }
    // Clean stale 2v2s
    for (const [gId, g] of Object.entries(twovtwos)) {
        if (!g.active) continue;
        const allGone = [...g.t1,...g.t2].every(p => !io.sockets.sockets.get(p.id));
        if (allGone) { g.active = false; delete twovtwos[gId]; }
    }
    // FFA stability: force reset if stuck
    [{ lobby: ffaLobby, room: 'lobby_ffa' }, { lobby: mmLobby, room: 'lobby_mm' }].forEach(({ lobby, room }) => {
        if (lobby.state === 'playing') {
            const connAlive = lobby.players.filter(p => p.alive && io.sockets.sockets.get(p.id));
            if (connAlive.length === 0) { lobby.state='waiting'; lobby.matchStats=[]; clearTimeout(lobby.timer); lobby.players=[]; io.to(room).emit('lobby_reset'); }
        }
        if (lobby.state === 'countdown' && lobby.players.filter(p => io.sockets.sockets.get(p.id)).length < 2) {
            clearTimeout(lobby.timer); lobby.state='waiting'; lobby.matchStats=[]; lobby.players=[]; io.to(room).emit('lobby_reset');
        }
        // Remove disconnected players from lobby
        lobby.players = lobby.players.filter(p => io.sockets.sockets.get(p.id));
    });
}, 1000);

// Flush accumulated garbage overflow every 500ms
setInterval(() => {
    for (const [sid, accum] of Object.entries(garbageAccum)) {
        const whole = Math.floor(accum);
        if (whole >= 1) {
            const toSend = Math.min(whole, 10);
            garbageAccum[sid] -= toSend;
            garbageAccum[sid] = Math.round(garbageAccum[sid] * 100) / 100;
            const s = io.sockets.sockets.get(sid);
            if (s) io.to(sid).emit('receive_garbage', toSend);
            else delete garbageAccum[sid];
        }
    }
}, 500);

function startDuel(p1Id, p1Name, p2Id, p2Name) {
    const duelId = 'duel_' + Date.now() + '_' + Math.random().toString(36).substr(2,4);
    const seed = Math.floor(Math.random()*1000000);
    duels[duelId] = { id:duelId, p1Id, p2Id, p1Name, p2Name, scores:{[p1Id]:0,[p2Id]:0}, round:1, seed, active:true };
    const p1S = io.sockets.sockets.get(p1Id);
    const p2S = io.sockets.sockets.get(p2Id);
    if(p1S) p1S.join(duelId);
    if(p2S) p2S.join(duelId);
    if(onlinePlayers[p1Id]){onlinePlayers[p1Id].status='duel';onlinePlayers[p1Id].queueMode=null;}
    if(onlinePlayers[p2Id]){onlinePlayers[p2Id].status='duel';onlinePlayers[p2Id].queueMode=null;}
    bp();
    const mk = (oppId, oppName) => ({mode:'duel',duelId,seed,opponent:{id:oppId,username:oppName},p1Id,p2Id,p1Name,p2Name});
    if(p1S){ p1S.emit('queue_matched',{mode:'duel'}); p1S.emit('duel_start', mk(p2Id,p2Name)); }
    if(p2S){ p2S.emit('queue_matched',{mode:'duel'}); p2S.emit('duel_start', mk(p1Id,p1Name)); }
}

function start2v2(team1, team2) {
    const gId = 'tvt_' + Date.now() + '_' + Math.random().toString(36).substr(2,4);
    const seed = Math.floor(Math.random()*1000000);
    const t1 = [{id:team1.p1Id,name:team1.p1Name},{id:team1.p2Id,name:team1.p2Name}];
    const t2 = [{id:team2.p1Id,name:team2.p1Name},{id:team2.p2Id,name:team2.p2Name}];
    twovtwos[gId] = { id:gId, t1, t2, scores:{t1:0,t2:0}, round:1, seed, active:true, deadThisRound:[] };
    [...t1,...t2].forEach(p => {
        const s = io.sockets.sockets.get(p.id);
        if(s) { s.join(gId); s.emit('queue_matched',{mode:'2v2'}); }
        if(onlinePlayers[p.id]){onlinePlayers[p.id].status='2v2';onlinePlayers[p.id].queueMode=null;}
    });
    bp();
    io.to(gId).emit('twovtwo_start', { gameId:gId, seed, t1, t2 });
}

// === SOCKET HANDLER ===
io.on('connection', (socket) => {

    socket.on('login_attempt', data => {
        const user = data.username.trim().substring(0,12);
        const pass = data.password.trim();
        if(!user||!pass) return socket.emit('login_response',{success:false,msg:"Enter user & pass."});
        // Check timeout
        if(timedOutPlayers[user]) {
            const remaining = timedOutPlayers[user] - Date.now();
            if(remaining > 0) {
                const mins = Math.ceil(remaining / 60000);
                return socket.emit('login_response',{success:false,msg:"You are timed out. " + mins + " minute(s) remaining."});
            } else { delete timedOutPlayers[user]; }
        }
        if(!accounts[user]){accounts[user]={password:pass,wins:0,bestAPM:0,bestCombo:0,history:[]};saveAccounts();}
        else if(accounts[user].password!==pass) return socket.emit('login_response',{success:false,msg:"Incorrect Password!"});
        socket.username = user;
        onlinePlayers[socket.id] = {id:socket.id,username:user,status:'idle',queueMode:null,queueTime:0};
        bp();
        socket.emit('login_response',{success:true,username:user,wins:accounts[user].wins,bestAPM:accounts[user].bestAPM||0});
        io.emit('leaderboard_update', getLeaderboards());
    });

    socket.on('set_status', st => { if(onlinePlayers[socket.id]){onlinePlayers[socket.id].status=st; bp();} });

    // === DIRECT JOIN FFA ===
    socket.on('join_ffa', () => {
        if(!socket.username) return;
        socket.join('lobby_ffa');
        if(!ffaLobby.players.find(p=>p.id===socket.id)){
            ffaLobby.players.push({ id:socket.id, username:socket.username, alive:true, damageLog:[], lastActivity:Date.now(), linesSent:0, boardHeight:0 });
        }
        if(onlinePlayers[socket.id]){onlinePlayers[socket.id].status='ffa';} bp();
        socket.emit('ffa_joined', { count: ffaLobby.players.length, state: ffaLobby.state });
        io.to('lobby_ffa').emit('lobby_update', { count: ffaLobby.players.length });
        if(ffaLobby.state === 'waiting') tryStartLobby(ffaLobby, 'lobby_ffa', 'ffa');
        else if(ffaLobby.state === 'playing') {
            socket.emit('ffa_spectate', { seed: ffaLobby.seed, players: ffaLobby.players.map(p=>({id:p.id,username:p.username})) });
        }
    });

    // === DIRECT JOIN MUTATOR MADNESS ===
    socket.on('join_mm', (classId) => { joinMutator(socket, classId); });
    socket.on('join_mutator_queue', (data) => { joinMutator(socket, data.className || data); });
    function joinMutator(sock, classId) {
        if(!sock.username) return;
        sock.mmClass = classId || 'high_roller';
        sock.join('lobby_mm');
        if(!mmLobby.players.find(p=>p.id===sock.id)){
            mmLobby.players.push({ id:sock.id, username:sock.username, alive:true, damageLog:[], lastActivity:Date.now(), linesSent:0, boardHeight:0, mmClass:classId });
        }
        if(onlinePlayers[sock.id]){onlinePlayers[sock.id].status='mutator';} bp();
        sock.emit('mm_joined', { count: mmLobby.players.length, state: mmLobby.state });
        io.to('lobby_mm').emit('lobby_update', { count: mmLobby.players.length });
        if(mmLobby.state === 'waiting') tryStartLobby(mmLobby, 'lobby_mm', 'mutator');
        else if(mmLobby.state === 'playing') {
            sock.emit('ffa_spectate', { seed: mmLobby.seed, players: mmLobby.players.map(p=>({id:p.id,username:p.username,className:p.mmClass})) });
        }
    }

    // === DUEL QUEUE ===
    socket.on('join_queue', mode => {
        if(!socket.username) return;
        leaveAllQueues(socket.id);
        if(mode === 'duel') duelQueue.push(socket.id);
        if(onlinePlayers[socket.id]){onlinePlayers[socket.id].queueMode=mode;onlinePlayers[socket.id].queueTime=Date.now();onlinePlayers[socket.id].status='queuing';}
        bp(); socket.emit('queue_joined', { mode, time: Date.now() });
    });
    socket.on('leave_queue', () => { leaveAllQueues(socket.id); });

    // === DUEL CHALLENGE (from players panel) ===
    socket.on('duel_challenge', targetId => {
        if(!socket.username) return;
        const target = onlinePlayers[targetId];
        if(!target) return;
        duelChallenges[socket.id] = { targetId, targetName:target.username, senderName:socket.username, timer:setTimeout(()=>{
            socket.emit('receive_chat',{user:'[SYSTEM]',text:'Duel challenge expired.'});
            const ts=io.sockets.sockets.get(targetId); if(ts) ts.emit('duel_challenge_cancelled',{fromId:socket.id});
            delete duelChallenges[socket.id];
        }, 60000)};
        socket.emit('receive_chat',{user:'[SYSTEM]',text:`Duel challenge sent to ${target.username}`});
        io.to(targetId).emit('receive_duel_challenge', {fromId:socket.id, fromName:socket.username});
    });
    socket.on('duel_challenge_accept', senderId => {
        const ch = duelChallenges[senderId];
        if(!ch || ch.targetId !== socket.id) return;
        clearTimeout(ch.timer); delete duelChallenges[senderId];
        leaveAllQueues(senderId); leaveAllQueues(socket.id);
        // Remove from FFA/MM if in lobby
        removeFromLobby(senderId, ffaLobby, 'lobby_ffa'); removeFromLobby(socket.id, ffaLobby, 'lobby_ffa');
        removeFromLobby(senderId, mmLobby, 'lobby_mm'); removeFromLobby(socket.id, mmLobby, 'lobby_mm');
        startDuel(senderId, ch.senderName, socket.id, socket.username);
    });
    socket.on('duel_challenge_decline', senderId => {
        const ch = duelChallenges[senderId];
        if(ch && ch.targetId === socket.id) { clearTimeout(ch.timer); const cs=io.sockets.sockets.get(senderId); if(cs) cs.emit('receive_chat',{user:'[SYSTEM]',text:socket.username+' declined duel.'}); delete duelChallenges[senderId]; }
    });

    // === TEAM INVITE ===
    socket.on('team_invite', targetId => {
        if(!socket.username) return;
        if(teamInvites[socket.id]) return socket.emit('receive_chat',{user:'[SYSTEM]',text:'You already have a pending invite.'});
        const target = onlinePlayers[targetId];
        if(!target) return;
        teamInvites[socket.id] = { targetId, targetName:target.username, senderName:socket.username, timer:setTimeout(()=>{
            socket.emit('receive_chat',{user:'[SYSTEM]',text:'Team invite expired.'});
            const ts=io.sockets.sockets.get(targetId); if(ts) ts.emit('team_invite_cancelled',{fromId:socket.id});
            delete teamInvites[socket.id];
        }, 60000)};
        socket.emit('receive_chat',{user:'[SYSTEM]',text:`Team invite sent to ${target.username}`});
        io.to(targetId).emit('receive_team_invite', {fromId:socket.id, fromName:socket.username});
    });
    socket.on('team_invite_accept', senderId => {
        const inv = teamInvites[senderId];
        if(!inv || inv.targetId !== socket.id) return socket.emit('receive_chat',{user:'[SYSTEM]',text:'Invite expired.'});
        clearTimeout(inv.timer); delete teamInvites[senderId];
        leaveAllQueues(senderId); leaveAllQueues(socket.id);
        const team = { p1Id:senderId, p2Id:socket.id, p1Name:inv.senderName, p2Name:socket.username };
        twovtwoQueue.push(team);
        [senderId,socket.id].forEach(pid => {
            if(onlinePlayers[pid]){onlinePlayers[pid].queueMode='2v2';onlinePlayers[pid].queueTime=Date.now();onlinePlayers[pid].status='queuing';}
            const s=io.sockets.sockets.get(pid); if(s) s.emit('queue_joined',{mode:'2v2',teammate:pid===senderId?socket.username:inv.senderName,time:Date.now()});
        });
        bp();
    });
    socket.on('team_invite_decline', senderId => {
        const inv = teamInvites[senderId];
        if(inv && inv.targetId === socket.id) { clearTimeout(inv.timer); const cs=io.sockets.sockets.get(senderId); if(cs) cs.emit('receive_chat',{user:'[SYSTEM]',text:socket.username+' declined team invite.'}); delete teamInvites[senderId]; }
    });

    // === DUEL REPORT ===
    socket.on('duel_report_loss', stats => {
        const duel = findDuel(socket.id);
        if(!duel||!duel.active) return;
        const wId = duel.p1Id===socket.id?duel.p2Id:duel.p1Id;
        duel.scores[wId] = (duel.scores[wId]||0)+1;
        const wS=duel.scores[wId], lS=duel.scores[socket.id]||0;
        const wN=duel.p1Id===wId?duel.p1Name:duel.p2Name;
        const lN=duel.p1Id===socket.id?duel.p1Name:duel.p2Name;
        if(wS>=6&&(wS-lS)>=2){
            duel.active=false;
            saveDuelResult(wN,lN,duel.scores[duel.p1Id]||0,duel.scores[duel.p2Id]||0);
            io.to(duel.id).emit('duel_end',{winnerName:wN,loserName:lN,finalScores:duel.scores,p1Id:duel.p1Id,p2Id:duel.p2Id,p1Name:duel.p1Name,p2Name:duel.p2Name,reason:null});
            io.emit('leaderboard_update',getLeaderboards());
            [duel.p1Id,duel.p2Id].forEach(pid=>{const s=io.sockets.sockets.get(pid);if(s)s.leave(duel.id);if(onlinePlayers[pid])onlinePlayers[pid].status='idle';});
            bp(); delete duels[duel.id];
        } else {
            duel.round++; const ns=Math.floor(Math.random()*1000000); duel.seed=ns;
            io.to(duel.id).emit('duel_round_result',{roundWinnerName:wN,scores:duel.scores,round:duel.round,newSeed:ns,p1Id:duel.p1Id,p2Id:duel.p2Id,p1Name:duel.p1Name,p2Name:duel.p2Name});
        }
    });

    // === 2v2 REPORT ===
    socket.on('twovtwo_report_loss', stats => {
        const game = find2v2(socket.id);
        if(!game||!game.active) return;
        if(game.deadThisRound.includes(socket.id)) return;
        game.deadThisRound.push(socket.id);
        const myTeam = game.t1.some(p=>p.id===socket.id) ? 't1' : 't2';
        const winTeamKey = myTeam==='t1'?'t2':'t1';
        game.scores[winTeamKey]++;
        const wS=game.scores[winTeamKey], lS=game.scores[myTeam];
        const wNames=game[winTeamKey].map(p=>p.name).join(' & ');
        const lNames=game[myTeam].map(p=>p.name).join(' & ');
        if(wS>=6&&(wS-lS)>=2){
            game.active=false;
            game[winTeamKey].forEach(p=>{if(accounts[p.name]){accounts[p.name].wins=(accounts[p.name].wins||0)+1;if(!accounts[p.name].history)accounts[p.name].history=[];accounts[p.name].history.push({date:new Date().toISOString(),type:'2v2',place:1,vs:lNames,score:`${game.scores.t1}-${game.scores.t2}`});}});
            game[myTeam].forEach(p=>{if(accounts[p.name]){if(!accounts[p.name].history)accounts[p.name].history=[];accounts[p.name].history.push({date:new Date().toISOString(),type:'2v2',place:2,vs:wNames,score:`${game.scores.t1}-${game.scores.t2}`});}});
            saveAccounts();
            io.to(game.id).emit('twovtwo_end',{winTeam:winTeamKey,winNames:wNames,loseNames:lNames,scores:game.scores,reason:null});
            io.emit('leaderboard_update',getLeaderboards());
            [...game.t1,...game.t2].forEach(p=>{const s=io.sockets.sockets.get(p.id);if(s)s.leave(game.id);if(onlinePlayers[p.id])onlinePlayers[p.id].status='idle';});
            bp(); delete twovtwos[game.id];
        } else {
            game.round++; game.deadThisRound=[]; const ns=Math.floor(Math.random()*1000000); game.seed=ns;
            io.to(game.id).emit('twovtwo_round_result',{roundWinnerTeam:winTeamKey,roundWinnerNames:wNames,scores:game.scores,round:game.round,newSeed:ns});
        }
    });

    // === BOARD UPDATES (isolated) ===
    socket.on('update_board', data => {
        const grid = data.grid || data;
        const height = data.height || 0;
        // FFA
        const fp = ffaLobby.players.find(x=>x.id===socket.id);
        if(fp) { fp.lastActivity=Date.now(); fp.boardHeight=height; socket.to('lobby_ffa').emit('enemy_board_update',{id:socket.id,grid}); return; }
        // MM
        const mp = mmLobby.players.find(x=>x.id===socket.id);
        if(mp) { mp.lastActivity=Date.now(); mp.boardHeight=height; socket.to('lobby_mm').emit('enemy_board_update',{id:socket.id,grid}); return; }
        // Duel
        const duel = findDuel(socket.id);
        if(duel) { const opId=duel.p1Id===socket.id?duel.p2Id:duel.p1Id; io.to(opId).emit('enemy_board_update',{id:socket.id,grid}); return; }
        // 2v2
        const game = find2v2(socket.id);
        if(game) { [...game.t1,...game.t2].filter(p=>p.id!==socket.id).forEach(p=>io.to(p.id).emit('enemy_board_update',{id:socket.id,grid})); return; }
    });

    // === GARBAGE (isolated, reworked) ===
    socket.on('send_garbage', data => {
        if(data.mode==='duel'){const d=findDuel(socket.id);if(d&&d.active){const op=d.p1Id===socket.id?d.p2Id:d.p1Id;io.to(op).emit('receive_garbage',data.amount);}return;}
        if(data.mode==='2v2'){const g=find2v2(socket.id);if(g&&g.active){distribute2v2Garbage(socket.id,data.amount,g);}return;}
        if(data.mode==='ffa'){distributeGarbage(socket.id,data.amount,ffaLobby,'lobby_ffa','ffa');return;}
        if(data.mode==='mm'||data.mode==='mutator'){
            // Direct target (sniper)
            if(data.targetId){
                const target=mmLobby.players.find(p=>p.id===data.targetId&&p.alive);
                if(target){io.to(target.id).emit('receive_garbage',data.amount);}
                else{distributeGarbage(socket.id,data.amount,mmLobby,'lobby_mm','mm');}
            }
            // Gravity well garbage - send with flag so targets get triple gravity
            else if(data.gravityWell){
                const sender=mmLobby.players.find(p=>p.id===socket.id);
                if(!sender||!sender.alive)return;
                const targets=mmLobby.players.filter(p=>p.alive&&p.id!==socket.id);
                if(!targets.length)return;
                const perPlayer=data.amount/targets.length;
                const rounded=Math.round(perPlayer*100)/100;
                targets.forEach(t=>{
                    if(!garbageAccum[t.id])garbageAccum[t.id]=0;
                    garbageAccum[t.id]+=rounded;
                    const whole=Math.floor(garbageAccum[t.id]);
                    if(whole>=1){const toSend=Math.min(whole,10);garbageAccum[t.id]-=toSend;
                        io.to(t.id).emit('receive_garbage',{amount:toSend,gravityWell:true});}
                });
            }
            else{distributeGarbage(socket.id,data.amount,mmLobby,'lobby_mm','mm');}
            // Track linesSent
            const mp=mmLobby.players.find(p=>p.id===socket.id);
            if(mp) mp.linesSent=(mp.linesSent||0)+data.amount;
            return;
        }
    });

    // Sniper: find player with highest board
    socket.on('request_highest_board', () => {
        const mp=mmLobby.players.find(p=>p.id===socket.id);
        if(!mp)return;
        let target=null,maxH=-1;
        mmLobby.players.filter(p=>p.alive&&p.id!==socket.id).forEach(p=>{
            if((p.boardHeight||0)>maxH){maxH=p.boardHeight||0;target=p;}
        });
        if(target)socket.emit('sniper_target',{id:target.id,username:target.username});
    });

    // Gravity Well: Wormhole - force 50% of each opponent's pending garbage onto their board
    socket.on('wormhole', () => {
        const mp=mmLobby.players.find(p=>p.id===socket.id);
        if(!mp||!mp.alive)return;
        mmLobby.players.filter(p=>p.alive&&p.id!==socket.id).forEach(p=>{
            io.to(p.id).emit('wormhole_hit');
        });
    });

    // Gravity Well: Black Hole - lock hold of opponent closest to death
    socket.on('black_hole', () => {
        const mp=mmLobby.players.find(p=>p.id===socket.id);
        if(!mp||!mp.alive)return;
        let target=null,maxH=-1;
        mmLobby.players.filter(p=>p.alive&&p.id!==socket.id).forEach(p=>{
            if((p.boardHeight||0)>maxH){maxH=p.boardHeight||0;target=p;}
        });
        if(target)io.to(target.id).emit('black_hole_hit');
    });

    // Diver: Flood Gates - flood all opponents with water level
    socket.on('flood_gates', data => {
        const mp=mmLobby.players.find(p=>p.id===socket.id);
        if(!mp||!mp.alive)return;
        const level=data.waterLevel||0;
        mmLobby.players.filter(p=>p.alive&&p.id!==socket.id).forEach(p=>{
            io.to(p.id).emit('flood_hit',{waterLevel:level});
        });
    });

    // Mutator events - broadcast to lobby feed + specific effects
    socket.on('mutator_event', data => {
        const mp=mmLobby.players.find(p=>p.id===socket.id);
        if(!mp||!mp.alive)return;
        const evt={type:data.type, username:socket.username};
        // For sniper: also notify the target with muzzle flash
        if(data.type==='sniper_shot'&&data.targetId){
            const target=mmLobby.players.find(p=>p.id===data.targetId);
            if(target){
                io.to(target.id).emit('sniper_shot_hit',{shooter:socket.username});
                evt.targetName=target.username;
            }
        }
        // Broadcast feed to all alive players
        mmLobby.players.filter(p=>p.alive).forEach(p=>{
            io.to(p.id).emit('mutator_feed',evt);
        });
    });

    // === GO HOME = ELIMINATE ===
    socket.on('go_home', () => {
        // Eliminate from whatever mode they're in
        removeFromLobby(socket.id, ffaLobby, 'lobby_ffa');
        removeFromLobby(socket.id, mmLobby, 'lobby_mm');
        leaveGame(socket.id, 'Forfeit');
        leaveAllQueues(socket.id);
        if(onlinePlayers[socket.id]) { onlinePlayers[socket.id].status='idle'; }
        bp();
    });

    socket.on('player_died', stats => {
        const fp = ffaLobby.players.find(x=>x.id===socket.id);
        if(fp) { handleLobbyDeath(socket.id, stats, "Gravity", ffaLobby, 'lobby_ffa'); return; }
        const mp = mmLobby.players.find(x=>x.id===socket.id);
        if(mp) { handleLobbyDeath(socket.id, stats, "Gravity", mmLobby, 'lobby_mm'); return; }
    });
    socket.on('match_won', stats => {
        const fp = ffaLobby.players.find(x=>x.id===socket.id);
        if(fp && ffaLobby.state==='playing') { recordLobbyStat(socket.username,stats,true,Date.now()-ffaLobby.startTime,ffaLobby); finishLobby(socket.username,ffaLobby,'lobby_ffa'); return; }
        const mp = mmLobby.players.find(x=>x.id===socket.id);
        if(mp && mmLobby.state==='playing') { recordLobbyStat(socket.username,stats,true,Date.now()-mmLobby.startTime,mmLobby); finishLobby(socket.username,mmLobby,'lobby_mm'); return; }
    });
    socket.on('leave_lobby', () => {
        removeFromLobby(socket.id, ffaLobby, 'lobby_ffa');
        removeFromLobby(socket.id, mmLobby, 'lobby_mm');
    });

    socket.on('send_chat', msg => { io.emit('receive_chat',{user:socket.username||"Anon",text:msg.replace(/</g,"&lt;").substring(0,50)}); });
    socket.on('request_all_stats', () => { socket.emit('receive_all_stats', accounts); });
    socket.on('submit_bug', data => {
        if(!socket.username) return;
        bugReports.push({ id: Date.now(), author: socket.username, topic: (data.topic||'').substring(0,50), body: (data.body||'').substring(0,500), date: new Date().toISOString() });
        saveBugs();
        socket.emit('receive_chat',{user:'[SYSTEM]',text:'Bug report submitted. Thank you!'});
        io.emit('bugs_update', bugReports);
    });
    socket.on('request_bugs', () => { socket.emit('bugs_update', bugReports); });

    // === ADMIN COMMANDS (John only) ===
    socket.on('admin_timeout', data => {
        if(socket.username !== 'John') return;
        const tid = data.targetId;
        const minutes = parseInt(data.minutes) || 5;
        const ts = io.sockets.sockets.get(tid);
        const targetName = ts ? ts.username : null;
        if(targetName) {
            timedOutPlayers[targetName] = Date.now() + minutes * 60 * 1000;
            ts.emit('force_disconnect', 'You have been timed out for ' + minutes + ' minutes by an admin.');
            ts.disconnect(true);
            io.emit('receive_chat', { user:'[SYSTEM]', text: targetName + ' has been timed out for ' + minutes + ' minutes.' });
        }
    });
    socket.on('admin_restart_ffa', () => {
        if(socket.username !== 'John') return;
        ffaLobby.players.forEach(p => { const s=io.sockets.sockets.get(p.id); if(s){s.leave('lobby_ffa');s.emit('force_disconnect','FFA lobby restarted by admin.');} if(onlinePlayers[p.id]) onlinePlayers[p.id].status='idle'; });
        ffaLobby.players=[]; forceLobbyReset(ffaLobby, 'lobby_ffa'); bp();
        socket.emit('receive_chat',{user:'[SYSTEM]',text:'FFA lobby restarted.'});
    });
    socket.on('admin_restart_mutator', () => {
        if(socket.username !== 'John') return;
        mmLobby.players.forEach(p => { const s=io.sockets.sockets.get(p.id); if(s){s.leave('lobby_mm');s.emit('force_disconnect','Mutator lobby restarted by admin.');} if(onlinePlayers[p.id]) onlinePlayers[p.id].status='idle'; });
        mmLobby.players=[]; forceLobbyReset(mmLobby, 'lobby_mm'); bp();
        socket.emit('receive_chat',{user:'[SYSTEM]',text:'Mutator lobby restarted.'});
    });
    socket.on('admin_restart_server', () => {
        if(socket.username !== 'John') return;
        io.emit('force_disconnect', 'Server is restarting...');
        setTimeout(() => process.exit(0), 1000);
    });

    socket.on('disconnect', () => {
        leaveAllQueues(socket.id);
        leaveGame(socket.id, 'Opponent Disconnected');
        removeFromLobby(socket.id, ffaLobby, 'lobby_ffa');
        removeFromLobby(socket.id, mmLobby, 'lobby_mm');
        if(teamInvites[socket.id]){clearTimeout(teamInvites[socket.id].timer);const t=teamInvites[socket.id].targetId;const ts=io.sockets.sockets.get(t);if(ts)ts.emit('team_invite_cancelled',{fromId:socket.id});delete teamInvites[socket.id];}
        for(const[cid,inv] of Object.entries(teamInvites)){if(inv.targetId===socket.id){clearTimeout(inv.timer);delete teamInvites[cid];}}
        if(duelChallenges[socket.id]){clearTimeout(duelChallenges[socket.id].timer);delete duelChallenges[socket.id];}
        for(const[cid,ch] of Object.entries(duelChallenges)){if(ch.targetId===socket.id){clearTimeout(ch.timer);delete duelChallenges[cid];}}
        delete garbageAccum[socket.id];
        delete onlinePlayers[socket.id];
        bp();
    });
});

// === HELPERS ===
function leaveAllQueues(sid) {
    duelQueue = duelQueue.filter(id=>id!==sid);
    twovtwoQueue = twovtwoQueue.filter(t=>t.p1Id!==sid&&t.p2Id!==sid);
    const removedTeam = twovtwoQueue.find(t=>t.p1Id===sid||t.p2Id===sid);
    if(removedTeam){
        const mateId = removedTeam.p1Id===sid?removedTeam.p2Id:removedTeam.p1Id;
        twovtwoQueue = twovtwoQueue.filter(t=>t!==removedTeam);
        if(onlinePlayers[mateId]){onlinePlayers[mateId].queueMode=null;onlinePlayers[mateId].status='idle';}
        const ms=io.sockets.sockets.get(mateId); if(ms) ms.emit('queue_cancelled',{reason:'Teammate left queue'});
    }
    if(onlinePlayers[sid]){onlinePlayers[sid].queueMode=null; if(onlinePlayers[sid].status==='queuing') onlinePlayers[sid].status='idle';}
    bp();
}

function removeFromLobby(sid, lobby, room) {
    const idx=lobby.players.findIndex(p=>p.id===sid);
    if(idx!==-1){
        const p=lobby.players[idx]; lobby.players.splice(idx,1);
        const s=io.sockets.sockets.get(sid); if(s) s.leave(room);
        io.to(room).emit('lobby_update',{count:lobby.players.length});
        if(lobby.state==='playing'&&p.alive){io.to(room).emit('elimination',{username:p.username,killer:"Disconnect"});checkLobbyWin(lobby,room);}
        if(lobby.players.length<2){if(lobby.state==='countdown'){clearTimeout(lobby.timer);forceLobbyReset(lobby,room);}else if(lobby.state==='playing'&&lobby.players.length===0)forceLobbyReset(lobby,room);}
    }
    delete garbageAccum[sid];
    if(onlinePlayers[sid]&&(onlinePlayers[sid].status==='ffa'||onlinePlayers[sid].status==='mm')){onlinePlayers[sid].status='idle';bp();}
}

function forceLobbyReset(lobby,room){lobby.state='waiting';lobby.matchStats=[];clearTimeout(lobby.timer);io.to(room).emit('lobby_reset');}

function handleLobbyDeath(sid,stats,dk,lobby,room){
    const p=lobby.players.find(x=>x.id===sid);
    if(p&&lobby.state==='playing'&&p.alive){
        p.alive=false;let k=dk;
        const recent=p.damageLog.filter(l=>Date.now()-l.time<15000);
        if(recent.length){const m={};recent.forEach(l=>m[l.attacker]=(m[l.attacker]||0)+l.amount);k=Object.keys(m).reduce((a,b)=>m[a]>m[b]?a:b);}
        recordLobbyStat(p.username,stats,false,Date.now()-lobby.startTime,lobby);
        io.to(room).emit('elimination',{username:p.username,killer:k});checkLobbyWin(lobby,room);
    }
}

function tryStartLobby(lobby,room,mode){
    if(lobby.state==='waiting'&&lobby.players.length>=2){
        lobby.state='countdown';lobby.seed=Math.floor(Math.random()*1000000);lobby.matchStats=[];
        lobby.players.forEach(p=>{p.alive=true;p.damageLog=[];p.lastActivity=Date.now();p.linesSent=0;p.boardHeight=0;});
        io.to(room).emit('start_countdown',{targetTime:Date.now()+3000});
        lobby.timer=setTimeout(()=>{
            lobby.state='playing';lobby.startTime=Date.now();
            const pList = lobby.players.map(p=>({id:p.id,username:p.username,className:p.mmClass||null}));
            io.to(room).emit('match_start',{mode,seed:lobby.seed,players:pList});
        },3000);
    }
}

function checkLobbyWin(lobby,room){const s=lobby.players.filter(p=>p.alive);if(s.length<=1){if(s.length===1)io.to(s[0].id).emit('request_win_stats');else finishLobby(null,lobby,room);}}
function recordLobbyStat(u,stats,w,t,lobby){if(lobby.matchStats.find(s=>s.username===u))return;lobby.matchStats.push({username:u,isWinner:w,...stats,survivalTime:t});}

function finishLobby(wn,lobby,room){
    if(lobby.state==='finished')return;
    setTimeout(()=>{
        lobby.state='finished';
        const wo=lobby.matchStats.find(s=>s.isWinner);
        const ls=lobby.matchStats.filter(s=>!s.isWinner).sort((a,b)=>b.survivalTime-a.survivalTime);
        const res=[];const fmt=ms=>`${Math.floor(ms/60000)}m ${Math.floor((ms%60000)/1000)}s`;
        if(wo)res.push({...wo,place:1,durationStr:fmt(wo.survivalTime)});
        ls.forEach((l,i)=>res.push({...l,place:(wo?2:1)+i,durationStr:fmt(l.survivalTime)}));
        res.forEach(r=>{if(accounts[r.username]){if(r.place===1)accounts[r.username].wins++;if((r.maxCombo||0)>(accounts[r.username].bestCombo||0))accounts[r.username].bestCombo=r.maxCombo;if((r.apm||0)>(accounts[r.username].bestAPM||0))accounts[r.username].bestAPM=r.apm;if(!accounts[r.username].history)accounts[r.username].history=[];accounts[r.username].history.push({date:new Date().toISOString(),...r});}});
        saveAccounts();
        if(wn&&accounts[wn]){const sk=lobby.players.find(p=>p.username===wn);if(sk&&io.sockets.sockets.get(sk.id))io.to(sk.id).emit('update_my_wins',accounts[wn].wins);}
        io.emit('leaderboard_update',getLeaderboards());
        io.to(room).emit('match_summary',res);
        setTimeout(()=>{
            // Emit lobby_reset to each player BEFORE removing from room
            lobby.players.forEach(p=>{const s=io.sockets.sockets.get(p.id);if(s)s.emit('lobby_reset');});
            lobby.players.forEach(p=>{if(onlinePlayers[p.id])onlinePlayers[p.id].status='idle';const s=io.sockets.sockets.get(p.id);if(s)s.leave(room);delete garbageAccum[p.id];});
            lobby.players=[];
            lobby.state='waiting';lobby.matchStats=[];clearTimeout(lobby.timer);
            bp();
        },5000);
    },500);
}

function getLeaderboards(){
    const all=Object.entries(accounts);
    return{wins:all.map(([n,d])=>({name:n,val:d.wins})).sort((a,b)=>b.val-a.val).slice(0,5),combos:all.map(([n,d])=>({name:n,val:d.bestCombo||0})).filter(u=>u.val>0).sort((a,b)=>b.val-a.val).slice(0,5)};
}

http.listen(PORT, () => console.log('SERVER RUNNING ON PORT ' + PORT));
