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

// --- DATA ---
const DATA_FILE = path.join(__dirname, 'accounts.json');
const BUGS_FILE = path.join(__dirname, 'bugs.json');
let accounts = {};
let bugReports = [];
function loadAccounts() { try { if (fs.existsSync(DATA_FILE)) accounts = JSON.parse(fs.readFileSync(DATA_FILE)); } catch(e) { accounts = {}; } }
function saveAccounts() { try { fs.writeFileSync(DATA_FILE, JSON.stringify(accounts, null, 2)); } catch(e) {} }
function loadBugs() { try { if (fs.existsSync(BUGS_FILE)) bugReports = JSON.parse(fs.readFileSync(BUGS_FILE)); } catch(e) { bugReports = []; } }
function saveBugs() { try { fs.writeFileSync(BUGS_FILE, JSON.stringify(bugReports, null, 2)); } catch(e) {} }
loadAccounts(); loadBugs();

// --- STATE ---
let onlinePlayers = {}; // sid -> {id, username, status, queueMode, queueTime}

// FFA
let ffaLobby = { players: [], state: 'waiting', seed: 0, matchStats: [], startTime: 0, timer: null };

// Queues
let ffaQueue = [];   // [sid, ...]
let duelQueue = [];  // [sid, ...]
let twovtwoQueue = []; // [{p1Id, p2Id, p1Name, p2Name}, ...]

// Active duels and 2v2s (isolated rooms)
let duels = {};      // duelId -> {id, p1Id, p2Id, p1Name, p2Name, scores, round, seed, active}
let twovtwos = {};   // gameId -> {id, t1:[{id,name},...], t2:[{id,name},...], scores:{t1:0,t2:0}, round, seed, active, deadThisRound:[]}

// Team invites
let teamInvites = {}; // senderId -> {targetId, targetName, senderName}

function bp() {
    const list = Object.values(onlinePlayers).map(p => ({ id: p.id, username: p.username, status: p.status }));
    io.emit('player_list_update', list);
}

function findDuel(sid) { for (const d of Object.values(duels)) { if (d.active && (d.p1Id === sid || d.p2Id === sid)) return d; } return null; }
function find2v2(sid) { for (const g of Object.values(twovtwos)) { if (g.active && [...g.t1, ...g.t2].some(p => p.id === sid)) return g; } return null; }

function leaveGame(sid, reason) {
    const duel = findDuel(sid);
    if (duel && duel.active) {
        duel.active = false;
        const wId = duel.p1Id === sid ? duel.p2Id : duel.p1Id;
        const wN = duel.p1Id === wId ? duel.p1Name : duel.p2Name;
        const lN = duel.p1Id === sid ? duel.p1Name : duel.p2Name;
        saveDuelResult(wN, lN, duel.scores[duel.p1Id]||0, duel.scores[duel.p2Id]||0);
        io.to(duel.id).emit('duel_end', { winnerName:wN, loserName:lN, finalScores:duel.scores, p1Id:duel.p1Id, p2Id:duel.p2Id, p1Name:duel.p1Name, p2Name:duel.p2Name, reason: reason||'Forfeit' });
        io.emit('leaderboard_update', getLeaderboards());
        [duel.p1Id,duel.p2Id].forEach(pid=>{ const s=io.sockets.sockets.get(pid); if(s) s.leave(duel.id); if(onlinePlayers[pid]) onlinePlayers[pid].status='idle'; });
        bp(); delete duels[duel.id];
    }
    const game = find2v2(sid);
    if (game && game.active) {
        game.active = false;
        const myTeam = game.t1.some(p=>p.id===sid) ? 't1' : 't2';
        const winTeam = myTeam === 't1' ? 't2' : 't1';
        const wNames = game[winTeam].map(p=>p.name).join(' & ');
        const lNames = game[myTeam === 't1' ? 't1' : 't2'].map(p=>p.name).join(' & ');
        io.to(game.id).emit('twovtwo_end', { winTeam, winNames: wNames, loseNames: lNames, scores: game.scores, reason: reason||'Forfeit' });
        [...game.t1,...game.t2].forEach(p=>{ const s=io.sockets.sockets.get(p.id); if(s) s.leave(game.id); if(onlinePlayers[p.id]) onlinePlayers[p.id].status='idle'; });
        bp(); delete twovtwos[game.id];
    }
}

function saveDuelResult(wN, lN, s1, s2) {
    const sc = `${s1}-${s2}`;
    if(accounts[wN]){accounts[wN].wins=(accounts[wN].wins||0)+1; if(!accounts[wN].history)accounts[wN].history=[]; accounts[wN].history.push({date:new Date().toISOString(),type:'duel',place:1,vs:lN,score:sc});}
    if(accounts[lN]){if(!accounts[lN].history)accounts[lN].history=[]; accounts[lN].history.push({date:new Date().toISOString(),type:'duel',place:2,vs:wN,score:sc});}
    saveAccounts();
}

// --- QUEUE PROCESSOR (runs every 1s) ---
setInterval(() => {
    // FFA: start when 2+ in queue
    if (ffaQueue.length >= 2 && ffaLobby.state === 'waiting') {
        // Pull everyone from queue into FFA lobby
        const players = [...ffaQueue];
        ffaQueue = [];
        players.forEach(sid => {
            const s = io.sockets.sockets.get(sid);
            if (!s || !s.username) return;
            s.join('lobby_ffa');
            ffaLobby.players.push({ id: sid, username: s.username, alive: true, damageLog: [], lastActivity: Date.now() });
            if(onlinePlayers[sid]) { onlinePlayers[sid].status = 'ffa'; onlinePlayers[sid].queueMode = null; }
            s.emit('queue_matched', { mode: 'ffa' });
        });
        bp();
        tryStartFFA();
    }

    // Duel: pair up 2
    while (duelQueue.length >= 2) {
        const p1Id = duelQueue.shift();
        const p2Id = duelQueue.shift();
        const p1S = io.sockets.sockets.get(p1Id);
        const p2S = io.sockets.sockets.get(p2Id);
        if (!p1S || !p1S.username) { if(p2S) duelQueue.unshift(p2Id); continue; }
        if (!p2S || !p2S.username) { duelQueue.unshift(p1Id); continue; }
        startDuel(p1Id, p1S.username, p2Id, p2S.username);
    }

    // 2v2: pair up 2 teams
    while (twovtwoQueue.length >= 2) {
        const team1 = twovtwoQueue.shift();
        const team2 = twovtwoQueue.shift();
        // Verify all 4 players still connected
        const allIds = [team1.p1Id, team1.p2Id, team2.p1Id, team2.p2Id];
        const allValid = allIds.every(id => io.sockets.sockets.get(id));
        if (!allValid) {
            // Put valid team back
            if(io.sockets.sockets.get(team1.p1Id) && io.sockets.sockets.get(team1.p2Id)) twovtwoQueue.unshift(team1);
            if(io.sockets.sockets.get(team2.p1Id) && io.sockets.sockets.get(team2.p2Id)) twovtwoQueue.unshift(team2);
            break;
        }
        start2v2(team1, team2);
    }

    // FFA watchdog
    if (ffaLobby.state === 'playing') {
        const now = Date.now();
        ffaLobby.players.filter(p => p.alive && (now - p.lastActivity > 15000)).forEach(p => {
            io.to(p.id).emit('force_disconnect', 'Kicked for inactivity.');
            handleFFADeath(p.id, { apm:0, sent:0 }, "AFK");
            removeFromFFA(p.id);
        });
    }
    if (ffaLobby.state !== 'waiting' && ffaLobby.players.length === 0) forceFFAReset();
    if (ffaLobby.state === 'playing' && ffaLobby.players.length === 1) checkFFAWin();
}, 1000);

function startDuel(p1Id, p1Name, p2Id, p2Name) {
    const duelId = 'duel_' + Date.now() + '_' + Math.random().toString(36).substr(2,4);
    const seed = Math.floor(Math.random()*1000000);
    duels[duelId] = { id:duelId, p1Id, p2Id, p1Name, p2Name, scores:{[p1Id]:0,[p2Id]:0}, round:1, seed, active:true };
    const p1S = io.sockets.sockets.get(p1Id);
    const p2S = io.sockets.sockets.get(p2Id);
    p1S.join(duelId); p2S.join(duelId);
    if(onlinePlayers[p1Id]){onlinePlayers[p1Id].status='duel';onlinePlayers[p1Id].queueMode=null;}
    if(onlinePlayers[p2Id]){onlinePlayers[p2Id].status='duel';onlinePlayers[p2Id].queueMode=null;}
    bp();
    const mk = (oppId, oppName) => ({mode:'duel',duelId,seed,opponent:{id:oppId,username:oppName},p1Id,p2Id,p1Name,p2Name});
    p1S.emit('queue_matched',{mode:'duel'}); p2S.emit('queue_matched',{mode:'duel'});
    p1S.emit('duel_start', mk(p2Id,p2Name)); p2S.emit('duel_start', mk(p1Id,p1Name));
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

// --- SOCKET ---
io.on('connection', (socket) => {

    socket.on('login_attempt', data => {
        const user = data.username.trim().substring(0,12);
        const pass = data.password.trim();
        if(!user||!pass) return socket.emit('login_response',{success:false,msg:"Enter user & pass."});
        if(!accounts[user]){accounts[user]={password:pass,wins:0,bestAPM:0,bestCombo:0,history:[]};saveAccounts();}
        else if(accounts[user].password!==pass) return socket.emit('login_response',{success:false,msg:"Incorrect Password!"});
        socket.username = user;
        onlinePlayers[socket.id] = {id:socket.id,username:user,status:'idle',queueMode:null,queueTime:0};
        bp();
        socket.emit('login_response',{success:true,username:user,wins:accounts[user].wins,bestAPM:accounts[user].bestAPM||0});
        io.emit('leaderboard_update', getLeaderboards());
    });

    socket.on('set_status', st => { if(onlinePlayers[socket.id]){onlinePlayers[socket.id].status=st; bp();} });

    // --- QUEUE ---
    socket.on('join_queue', mode => {
        if(!socket.username) return;
        // Leave any existing queue first
        leaveAllQueues(socket.id);
        if(mode === 'ffa') { ffaQueue.push(socket.id); }
        else if(mode === 'duel') { duelQueue.push(socket.id); }
        if(onlinePlayers[socket.id]){onlinePlayers[socket.id].queueMode=mode; onlinePlayers[socket.id].queueTime=Date.now(); onlinePlayers[socket.id].status='queuing';}
        bp();
        socket.emit('queue_joined', { mode, time: Date.now() });
    });

    socket.on('leave_queue', () => { leaveAllQueues(socket.id); });

    // --- 2v2 TEAM INVITE ---
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
        // Both enter 2v2 queue as a team
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

    // --- DUEL REPORT ---
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

    // --- 2v2 REPORT ---
    socket.on('twovtwo_report_loss', stats => {
        const game = find2v2(socket.id);
        if(!game||!game.active) return;
        if(game.deadThisRound.includes(socket.id)) return;
        game.deadThisRound.push(socket.id);
        const myTeam = game.t1.some(p=>p.id===socket.id) ? 't1' : 't2';
        const winTeamKey = myTeam==='t1'?'t2':'t1';
        // One death = round loss for that team
        game.scores[winTeamKey]++;
        const wS=game.scores[winTeamKey], lS=game.scores[myTeam];
        const wNames=game[winTeamKey].map(p=>p.name).join(' & ');
        const lNames=game[myTeam].map(p=>p.name).join(' & ');
        if(wS>=6&&(wS-lS)>=2){
            game.active=false;
            // Save results
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

    // --- BOARD UPDATES (isolated) ---
    socket.on('update_board', grid => {
        // FFA
        const fp = ffaLobby.players.find(x=>x.id===socket.id);
        if(fp) { fp.lastActivity=Date.now(); socket.to('lobby_ffa').emit('enemy_board_update',{id:socket.id,grid}); return; }
        // Duel
        const duel = findDuel(socket.id);
        if(duel) { const opId=duel.p1Id===socket.id?duel.p2Id:duel.p1Id; io.to(opId).emit('enemy_board_update',{id:socket.id,grid}); return; }
        // 2v2
        const game = find2v2(socket.id);
        if(game) { [...game.t1,...game.t2].filter(p=>p.id!==socket.id).forEach(p=>io.to(p.id).emit('enemy_board_update',{id:socket.id,grid})); return; }
    });

    // --- GARBAGE (isolated) ---
    socket.on('send_garbage', data => {
        if(data.mode==='duel'){const d=findDuel(socket.id);if(d&&d.active){const op=d.p1Id===socket.id?d.p2Id:d.p1Id;io.to(op).emit('receive_garbage',data.amount);}return;}
        if(data.mode==='2v2'){const g=find2v2(socket.id);if(g&&g.active){const myTeam=g.t1.some(p=>p.id===socket.id)?'t1':'t2';const enemies=myTeam==='t1'?g.t2:g.t1;if(enemies.length){const tgt=enemies[Math.floor(Math.random()*enemies.length)];io.to(tgt.id).emit('receive_garbage',data.amount);}}return;}
        // FFA
        if(ffaLobby.state==='playing'){
            const sender=ffaLobby.players.find(p=>p.id===socket.id);
            if(!sender||!sender.alive)return;
            sender.lastActivity=Date.now();
            const targets=ffaLobby.players.filter(p=>p.alive&&p.id!==socket.id);
            if(targets.length){let split=Math.floor(data.amount/targets.length);if(data.amount>=4&&split===0)split=1;if(split>0)targets.forEach(t=>{t.damageLog.push({attacker:sender.username,amount:split,time:Date.now()});io.to(t.id).emit('receive_garbage',split);});}
        }
    });

    // --- FFA ---
    socket.on('player_died', stats => { handleFFADeath(socket.id, stats, "Gravity"); });
    socket.on('match_won', stats => { if(ffaLobby.state==='playing'){recordFFAStat(socket.username,stats,true,Date.now()-ffaLobby.startTime);finishFFA(socket.username);} });
    socket.on('leave_lobby', () => { removeFromFFA(socket.id); });

    // --- CHAT ---
    socket.on('send_chat', msg => { io.emit('receive_chat',{user:socket.username||"Anon",text:msg.replace(/</g,"&lt;").substring(0,50)}); });

    // --- STATS ---
    socket.on('request_all_stats', () => { socket.emit('receive_all_stats', accounts); });

    // --- BUG REPORTS ---
    socket.on('submit_bug', data => {
        if(!socket.username) return;
        bugReports.push({ id: Date.now(), author: socket.username, topic: (data.topic||'').substring(0,50), body: (data.body||'').substring(0,500), date: new Date().toISOString() });
        saveBugs();
        socket.emit('receive_chat',{user:'[SYSTEM]',text:'Bug report submitted. Thank you!'});
        io.emit('bugs_update', bugReports);
    });
    socket.on('request_bugs', () => { socket.emit('bugs_update', bugReports); });

    // --- DISCONNECT ---
    socket.on('disconnect', () => {
        leaveAllQueues(socket.id);
        leaveGame(socket.id, 'Opponent Disconnected');
        removeFromFFA(socket.id);
        // Clean team invites
        if(teamInvites[socket.id]){clearTimeout(teamInvites[socket.id].timer);const t=teamInvites[socket.id].targetId;const ts=io.sockets.sockets.get(t);if(ts)ts.emit('team_invite_cancelled',{fromId:socket.id});delete teamInvites[socket.id];}
        for(const[cid,inv] of Object.entries(teamInvites)){if(inv.targetId===socket.id){clearTimeout(inv.timer);delete teamInvites[cid];}}
        delete onlinePlayers[socket.id];
        bp();
    });
});

// --- HELPERS ---
function leaveAllQueues(sid) {
    ffaQueue = ffaQueue.filter(id=>id!==sid);
    duelQueue = duelQueue.filter(id=>id!==sid);
    twovtwoQueue = twovtwoQueue.filter(t=>t.p1Id!==sid&&t.p2Id!==sid);
    // If teammate was in 2v2 queue, remove them too and notify
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

function removeFromFFA(sid) {
    const idx=ffaLobby.players.findIndex(p=>p.id===sid);
    if(idx!==-1){
        const p=ffaLobby.players[idx]; ffaLobby.players.splice(idx,1);
        const s=io.sockets.sockets.get(sid); if(s)s.leave('lobby_ffa');
        io.to('lobby_ffa').emit('lobby_update',{count:ffaLobby.players.length});
        if(ffaLobby.state==='playing'&&p.alive){io.to('lobby_ffa').emit('elimination',{username:p.username,killer:"Disconnect"});checkFFAWin();}
        if(ffaLobby.players.length<2){if(ffaLobby.state==='countdown'){clearTimeout(ffaLobby.timer);forceFFAReset();}else if(ffaLobby.state==='playing'&&ffaLobby.players.length===0)forceFFAReset();}
    }
    if(onlinePlayers[sid]&&onlinePlayers[sid].status==='ffa'){onlinePlayers[sid].status='idle';bp();}
}

function forceFFAReset(){ffaLobby.state='waiting';ffaLobby.matchStats=[];clearTimeout(ffaLobby.timer);io.to('lobby_ffa').emit('lobby_reset');}

function handleFFADeath(sid,stats,dk){
    const p=ffaLobby.players.find(x=>x.id===sid);
    if(p&&ffaLobby.state==='playing'&&p.alive){
        p.alive=false;let k=dk;
        const recent=p.damageLog.filter(l=>Date.now()-l.time<15000);
        if(recent.length){const m={};recent.forEach(l=>m[l.attacker]=(m[l.attacker]||0)+l.amount);k=Object.keys(m).reduce((a,b)=>m[a]>m[b]?a:b);}
        recordFFAStat(p.username,stats,false,Date.now()-ffaLobby.startTime);
        io.to('lobby_ffa').emit('elimination',{username:p.username,killer:k});checkFFAWin();
    }
}

function tryStartFFA(){
    if(ffaLobby.state==='waiting'&&ffaLobby.players.length>=2){
        ffaLobby.state='countdown';ffaLobby.seed=Math.floor(Math.random()*1000000);ffaLobby.matchStats=[];
        ffaLobby.players.forEach(p=>{p.alive=true;p.damageLog=[];p.lastActivity=Date.now();});
        io.to('lobby_ffa').emit('start_countdown',{targetTime:Date.now()+3000});
        ffaLobby.timer=setTimeout(()=>{ffaLobby.state='playing';ffaLobby.startTime=Date.now();io.to('lobby_ffa').emit('match_start',{mode:'ffa',seed:ffaLobby.seed,players:ffaLobby.players.map(p=>({id:p.id,username:p.username}))});},3000);
    }
}

function checkFFAWin(){const s=ffaLobby.players.filter(p=>p.alive);if(s.length<=1){if(s.length===1)io.to(s[0].id).emit('request_win_stats');else finishFFA(null);}}
function recordFFAStat(u,stats,w,t){if(ffaLobby.matchStats.find(s=>s.username===u))return;ffaLobby.matchStats.push({username:u,isWinner:w,...stats,survivalTime:t});}

function finishFFA(wn){
    if(ffaLobby.state==='finished')return;
    setTimeout(()=>{
        ffaLobby.state='finished';
        const wo=ffaLobby.matchStats.find(s=>s.isWinner);
        const ls=ffaLobby.matchStats.filter(s=>!s.isWinner).sort((a,b)=>b.survivalTime-a.survivalTime);
        const res=[];const fmt=ms=>`${Math.floor(ms/60000)}m ${Math.floor((ms%60000)/1000)}s`;
        if(wo)res.push({...wo,place:1,durationStr:fmt(wo.survivalTime)});
        ls.forEach((l,i)=>res.push({...l,place:(wo?2:1)+i,durationStr:fmt(l.survivalTime)}));
        res.forEach(r=>{if(accounts[r.username]){if(r.place===1)accounts[r.username].wins++;if((r.maxCombo||0)>(accounts[r.username].bestCombo||0))accounts[r.username].bestCombo=r.maxCombo;if((r.apm||0)>(accounts[r.username].bestAPM||0))accounts[r.username].bestAPM=r.apm;if(!accounts[r.username].history)accounts[r.username].history=[];accounts[r.username].history.push({date:new Date().toISOString(),...r});}});
        saveAccounts();
        if(wn&&accounts[wn]){const sk=ffaLobby.players.find(p=>p.username===wn);if(sk&&io.sockets.sockets.get(sk.id))io.to(sk.id).emit('update_my_wins',accounts[wn].wins);}
        io.emit('leaderboard_update',getLeaderboards());
        io.to('lobby_ffa').emit('match_summary',res);
        // Reset and move players back to idle
        setTimeout(()=>{
            ffaLobby.players.forEach(p=>{if(onlinePlayers[p.id])onlinePlayers[p.id].status='idle';const s=io.sockets.sockets.get(p.id);if(s)s.leave('lobby_ffa');});
            ffaLobby.players=[];
            forceFFAReset();bp();
        },5000);
    },500);
}

function getLeaderboards(){
    const all=Object.entries(accounts);
    return{wins:all.map(([n,d])=>({name:n,val:d.wins})).sort((a,b)=>b.val-a.val).slice(0,5),combos:all.map(([n,d])=>({name:n,val:d.bestCombo||0})).filter(u=>u.val>0).sort((a,b)=>b.val-a.val).slice(0,5)};
}

http.listen(PORT, () => console.log('SERVER RUNNING ON PORT ' + PORT));
