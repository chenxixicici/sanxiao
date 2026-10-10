// server.js —— 猫咪三消 · 1v1 对战服务端
// 运行：npm start
// 依赖：ws

const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

// ============ 配置 ============
const CONFIG = {
  boardSize: 8,
  tileTypes: ['paw', 'fish', 'yarn', 'cookie', 'milk'],
  scoreTable: { 3: 30, 4: 45, 5: 60 },
  score6Base: 60, score6Extra: 10,
  chainBonusStep: 0.25, chainBonusMax: 0.75,
  foodPerScore: 90,
  troughCap: 24,
  roundTime: 90,
  catPhases: {
    walkingToFood: 1300,
    eating: 4500,
    cleaning: 4500,
    happy: 3000,       // ← 改成 3 秒
    walkingToHome: 1700
  },
  maxCatsPerPlayer: 8,
  totalCatCap: 32
};

// ============ 核心规则 ============
function randomTile() {
  return CONFIG.tileTypes[Math.floor(Math.random() * CONFIG.tileTypes.length)];
}
function swap(b, r1, c1, r2, c2) {
  const t = b[r1][c1]; b[r1][c1] = b[r2][c2]; b[r2][c2] = t;
}
function findMatches(b) {
  const groups = []; const size = CONFIG.boardSize;
  for (let r = 0; r < size; r++) {
    let c = 0;
    while (c < size) {
      const t = b[r][c]; let len = 1;
      while (c + len < size && b[r][c + len] === t) len++;
      if (len >= 3) {
        const cells = [];
        for (let i = 0; i < len; i++) cells.push([r, c + i]);
        groups.push({ cells, length: len });
      }
      c += len;
    }
  }
  for (let c = 0; c < size; c++) {
    let r = 0;
    while (r < size) {
      const t = b[r][c]; let len = 1;
      while (r + len < size && b[r + len][c] === t) len++;
      if (len >= 3) {
        const cells = [];
        for (let i = 0; i < len; i++) cells.push([r + i, c]);
        groups.push({ cells, length: len });
      }
      r += len;
    }
  }
  return groups;
}
function hasPossibleMove(b) {
  const size = CONFIG.boardSize;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (c < size - 1) {
        swap(b, r, c, r, c + 1);
        const ok = findMatches(b).length > 0;
        swap(b, r, c, r, c + 1);
        if (ok) return true;
      }
      if (r < size - 1) {
        swap(b, r, c, r + 1, c);
        const ok = findMatches(b).length > 0;
        swap(b, r, c, r + 1, c);
        if (ok) return true;
      }
    }
  }
  return false;
}
function generateBoard() {
  for (let attempt = 0; attempt < 200; attempt++) {
    const b = Array.from({ length: CONFIG.boardSize }, () =>
      Array(CONFIG.boardSize).fill(null));
    for (let r = 0; r < CONFIG.boardSize; r++) {
      for (let c = 0; c < CONFIG.boardSize; c++) {
        const forbid = new Set();
        if (c >= 2 && b[r][c - 1] === b[r][c - 2]) forbid.add(b[r][c - 1]);
        if (r >= 2 && b[r - 1][c] === b[r - 2][c]) forbid.add(b[r - 1][c]);
        const opts = CONFIG.tileTypes.filter(t => !forbid.has(t));
        b[r][c] = opts[Math.floor(Math.random() * opts.length)];
      }
    }
    if (hasPossibleMove(b)) return b;
  }
  return Array.from({ length: CONFIG.boardSize }, () =>
    Array.from({ length: CONFIG.boardSize }, () => randomTile()));
}
function applyGravity(board) {
  const size = CONFIG.boardSize;
  for (let c = 0; c < size; c++) {
    let write = size - 1;
    for (let r = size - 1; r >= 0; r--) {
      if (board[r][c] !== null) {
        board[write][c] = board[r][c];
        if (write !== r) board[r][c] = null;
        write--;
      }
    }
    while (write >= 0) { board[write][c] = randomTile(); write--; }
  }
}
function scoreForLength(len) {
  if (len === 3) return CONFIG.scoreTable[3];
  if (len === 4) return CONFIG.scoreTable[4];
  if (len === 5) return CONFIG.scoreTable[5];
  return CONFIG.score6Base + (len - 6) * CONFIG.score6Extra;
}

// ============ Player ============
class Player {
  constructor(id, ws, name, isBot = false) {
    this.id = id;
    this.ws = ws;
    this.name = name;
    this.isBot = isBot;
    this.board = generateBoard();
    this.score = 0;
    this.foodStock = 0;
    this.foodProgress = 0;
    this.returnedCats = 0;
    this.botTimer = null;
  }
  send(msg) {
    if (this.ws && this.ws.readyState === 1) {
      try { this.ws.send(JSON.stringify(msg)); } catch (e) {}
    }
  }
}

// ============ BattleRoom ============
class BattleRoom {
  constructor(id) {
    this.id = id;
    this.players = [];
    this.cats = [];           // 共享猫咪池
    this.catIdSeq = 1;
    this.started = false;
    this.ended = false;
    this.timeLeft = CONFIG.roundTime;
    this.startedAt = 0;
    this.timers = [];
  }

  addPlayer(p) {
    if (this.players.length >= 2) return false;
    this.players.push(p);
    return true;
  }
  isFull() { return this.players.length >= 2; }
  isEmpty() { return this.players.length === 0; }

  start() {
    if (this.started || this.ended) return;
    this.started = true;
    this.timeLeft = CONFIG.roundTime;
    this.startedAt = Date.now();

    for (const p of this.players) if (p.isBot) this.startBot(p);

    this.timers.push(setInterval(() => {
      if (this.ended) return;
      this.timeLeft -= 0.1;
      if (this.timeLeft <= 0) { this.timeLeft = 0; this.endRound(); }
    }, 100));

    this.timers.push(setInterval(() => this.tickCats(), 100));
    this.timers.push(setInterval(() => this.trySpawnCat(), 1800));
    this.timers.push(setInterval(() => this.broadcastState(), 250));

    console.log(`[开局] ${this.id} ${this.players.map(p => p.name).join(' vs ')}`);
  }

  startBot(bot) {
    bot.botTimer = setInterval(() => {
      if (!this.started || this.ended) return;
      this.botMove(bot);
    }, 1100 + Math.random() * 400);
  }

  botMove(bot) {
    const size = CONFIG.boardSize;
    const moves = [];
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (c < size - 1) {
          swap(bot.board, r, c, r, c + 1);
          if (findMatches(bot.board).length > 0) moves.push([r, c, r, c + 1]);
          swap(bot.board, r, c, r, c + 1);
        }
        if (r < size - 1) {
          swap(bot.board, r, c, r + 1, c);
          if (findMatches(bot.board).length > 0) moves.push([r, c, r + 1, c]);
          swap(bot.board, r, c, r + 1, c);
        }
      }
    }
    if (moves.length === 0) { bot.board = generateBoard(); return; }
    const [r1, c1, r2, c2] = moves[Math.floor(Math.random() * moves.length)];
    this.handleSwap(bot.id, r1, c1, r2, c2);
  }

  handleSwap(playerId, r1, c1, r2, c2) {
    const p = this.players.find(x => x.id === playerId);
    if (!p || this.ended || !this.started) return;
    if (Math.abs(r1 - r2) + Math.abs(c1 - c2) !== 1) {
      p.send({ type: 'event', kind: 'invalid', r1, c1, r2, c2 });
      return;
    }

    swap(p.board, r1, c1, r2, c2);
    const first = findMatches(p.board);
    if (first.length === 0) {
      swap(p.board, r1, c1, r2, c2);
      p.send({ type: 'event', kind: 'invalid', r1, c1, r2, c2 });
      return;
    }

    let chainLevel = 0;
    let current = first;
    let totalGain = 0;
    const events = [];

    while (current.length > 0) {
      const removeSet = new Set();
      let base = 0;
      for (const g of current) {
        base += scoreForLength(g.length);
        for (const [r, c] of g.cells) removeSet.add(`${r},${c}`);
      }
      const chainMul = 1 + Math.min(chainLevel * CONFIG.chainBonusStep, CONFIG.chainBonusMax);
      const gained = Math.round(base * chainMul);
      totalGain += gained;
      const cells = [...removeSet].map(k => k.split(',').map(Number));
      events.push({ kind: 'match', cells, gain: gained, chain: chainLevel, length: current[0].length });

      cells.forEach(([r, c]) => { p.board[r][c] = null; });
      applyGravity(p.board);

      current = findMatches(p.board);
      chainLevel++;
    }

    p.score += totalGain;
    p.foodProgress += totalGain;
    while (p.foodProgress >= CONFIG.foodPerScore && p.foodStock < CONFIG.troughCap) {
      p.foodStock++;
      p.foodProgress -= CONFIG.foodPerScore;
    }

    p.send({ type: 'event', kind: 'swap_result', events, board: p.board });
  }

  tickCats() {
    if (this.ended) return;
    const now = Date.now();
    for (const cat of this.cats) {
      const elapsed = now - cat.stateStart;
      switch (cat.state) {
        case 'walking_to_food':
          if (elapsed >= CONFIG.catPhases.walkingToFood) {
            cat.state = 'eating'; cat.stateStart = now;
          }
          break;
        case 'eating':
          if (elapsed >= CONFIG.catPhases.eating) {
            cat.state = 'cleaning'; cat.stateStart = now;
          }
          break;
        case 'cleaning':
          if (elapsed >= CONFIG.catPhases.cleaning) {
            cat.state = 'happy'; cat.stateStart = now;
          }
          break;
        case 'happy':
          if (elapsed >= CONFIG.catPhases.happy) {
            cat.state = 'walking_to_home'; cat.stateStart = now;
          }
          break;
        case 'walking_to_home':
          if (elapsed >= CONFIG.catPhases.walkingToHome) {
            cat.state = 'sleeping'; cat.stateStart = now;
            const owner = this.players.find(p => p.id === cat.ownerId);
            if (owner) owner.returnedCats++;
            this.broadcast({ type: 'cat_event', kind: 'return', catId: cat.id });
          }
          break;
      }
    }
    // 清理超过一定数量的猫
    if (this.cats.length > CONFIG.totalCatCap) {
      this.cats = this.cats.slice(-CONFIG.totalCatCap);
    }
  }

  trySpawnCat() {
    if (this.ended || !this.started) return;
    if (this.players.length < 2) return;

    const catCount = {};
    for (const p of this.players) catCount[p.id] = 0;
    for (const c of this.cats) if (catCount[c.ownerId] !== undefined) catCount[c.ownerId]++;

    const candidates = this.players.filter(p =>
      p.foodStock > 0 && catCount[p.id] < CONFIG.maxCatsPerPlayer
    );
    if (candidates.length === 0) return;

    const total = candidates.reduce((s, p) => s + p.foodStock, 0);
    if (total <= 0) return;
    let rnd = Math.random() * total;
    let target = candidates[0];
    for (const p of candidates) {
      rnd -= p.foodStock;
      if (rnd <= 0) { target = p; break; }
    }

    target.foodStock--;
    const cat = {
      id: this.catIdSeq++,
      ownerId: target.id,
      state: 'walking_to_food',
      stateStart: Date.now(),
      paletteIdx: Math.floor(Math.random() * 5),
      slot: catCount[target.id]
    };
    this.cats.push(cat);
    this.broadcast({
      type: 'cat_event',
      kind: 'spawn',
      cat: { id: cat.id, ownerId: cat.ownerId, paletteIdx: cat.paletteIdx, slot: cat.slot }
    });
  }

  broadcastState() {
    if (this.ended) return;
    for (const p of this.players) {
      if (p.isBot) continue;
      const opp = this.players.find(x => x.id !== p.id);
      p.send({
        type: 'state',
        started: this.started,
        timeLeft: this.timeLeft,
        myBoard: p.board,
        myScore: p.score,
        myFoodStock: p.foodStock,
        myFoodProgress: p.foodProgress,
        myReturnedCats: p.returnedCats,
        opponent: opp ? {
          id: opp.id, name: opp.name, score: opp.score,
          foodStock: opp.foodStock, returnedCats: opp.returnedCats, isBot: opp.isBot
        } : null,
        myCats: this.cats.filter(c => c.ownerId === p.id)
      });
    }
  }

  endRound() {
    if (this.ended) return;
    this.ended = true;
    this.started = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const p of this.players) if (p.botTimer) clearInterval(p.botTimer);

    const [p1, p2] = this.players;
    let winnerId = null;
    if (p1 && p2) {
      if (p1.returnedCats > p2.returnedCats) winnerId = p1.id;
      else if (p2.returnedCats > p1.returnedCats) winnerId = p2.id;
      else if (p1.score > p2.score) winnerId = p1.id;
      else if (p2.score > p1.score) winnerId = p2.id;
    }

    this.broadcast({
      type: 'round_end',
      results: this.players.map(p => ({
        id: p.id, name: p.name, score: p.score,
        returnedCats: p.returnedCats, isBot: p.isBot
      })),
      winnerId
    });
    console.log(`[结束] ${this.id} winner=${winnerId}`);
  }

  broadcast(msg) {
    const str = JSON.stringify(msg);
    for (const p of this.players) {
      if (!p.isBot && p.ws && p.ws.readyState === 1) {
        try { p.ws.send(str); } catch (e) {}
      }
    }
  }
}

// ============ 排行榜 ============
const leaderboard = [];  // { name, returnedCats, maxFoodStock, ts }
function getLeaderboardTop100() {
  return leaderboard
    .slice()
    .sort((a, b) => {
      if (b.returnedCats !== a.returnedCats) return b.returnedCats - a.returnedCats;
      if (b.maxFoodStock !== a.maxFoodStock) return b.maxFoodStock - a.maxFoodStock;
      return a.ts - b.ts;
    })
    .slice(0, 100);
}

// ============ 匹配系统 ============
const rooms = new Map();
const playerRoom = new Map();
let playerSeq = 1;
let roomSeq = 1;

function createRoom() {
  const id = 'room_' + (roomSeq++);
  const room = new BattleRoom(id);
  rooms.set(id, room);
  return room;
}

function leaveRoom(player) {
  const roomId = playerRoom.get(player.id);
  if (!roomId) return;
  const room = rooms.get(roomId);
  playerRoom.delete(player.id);
  if (!room) return;

  const idx = room.players.indexOf(player);
  if (idx >= 0) room.players.splice(idx, 1);

  for (const p of room.players) {
    p.send({ type: 'opponent_left' });
  }
  if (!room.ended && room.players.length < 2) room.endRound();
}

function attachBotToRoom(room, forPlayer) {
  if (room.players.length >= 2 || room.started || room.ended) return;
  const bot = new Player('bot_' + Date.now(), null, '电脑猫娘', true);
  room.addPlayer(bot);
  forPlayer.send({ type: 'matched', opponent: { name: bot.name, isBot: true } });
  room.start();
}

// 定期清理空房间
setInterval(() => {
  for (const [id, room] of rooms) {
    if (room.isEmpty() || (room.ended && Date.now() - room.startedAt > 60000)) {
      for (const t of room.timers) clearInterval(t);
      rooms.delete(id);
    }
  }
}, 15000);

// ============ WebSocket ============
wss.on('connection', (ws) => {
  const playerId = 'p' + (playerSeq++);
  const player = new Player(playerId, ws, '玩家' + playerSeq);
  let botTimeout = null;

  console.log(`[连接] ${playerId}`);
  player.send({ type: 'welcome', playerId, name: player.name });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch (e) { return; }

    switch (msg.type) {
      case 'set_name':
        player.name = (msg.name || '').slice(0, 16) || player.name;
        player.send({ type: 'name_set', name: player.name });
        break;

      case 'list_rooms': {
        const list = [];
        for (const [id, room] of rooms) {
          if (room.ended) continue;
          list.push({
            id,
            players: room.players.length,
            maxPlayers: 2,
            started: room.started,
            hostName: room.players[0] ? room.players[0].name : '',
            isBot: !!(room.players[0] && room.players[0].isBot)
          });
        }
        ws.send(JSON.stringify({ type: 'rooms', rooms: list }));
        break;
      }

      case 'create_room': {
        if (playerRoom.has(playerId)) return;
        const room = createRoom();
        room.addPlayer(player);
        playerRoom.set(playerId, room.id);
        player.send({ type: 'joined_room', roomId: room.id, role: 'host' });
        botTimeout = setTimeout(() => {
          if (room.players.length < 2 && !room.started && rooms.has(room.id)) {
            attachBotToRoom(room, player);
          }
        }, 3000);
        break;
      }

      case 'join_room': {
        if (playerRoom.has(playerId)) return;
        const room = rooms.get(msg.roomId);
        if (!room || room.isFull() || room.started || room.ended) {
          player.send({ type: 'error', msg: '房间不可加入' });
          return;
        }
        room.addPlayer(player);
        playerRoom.set(playerId, room.id);
        player.send({ type: 'joined_room', roomId: room.id, role: 'guest' });
        room.players[0].send({ type: 'matched', opponent: { name: player.name, isBot: false } });
        player.send({ type: 'matched', opponent: { name: room.players[0].name, isBot: room.players[0].isBot } });
        room.start();
        break;
      }

      case 'quick_match': {
        if (playerRoom.has(playerId)) return;
        let found = null;
        for (const [, room] of rooms) {
          if (!room.started && !room.ended && room.players.length === 1 && !room.players[0].isBot) {
            found = room;
            break;
          }
        }
        if (found) {
          found.addPlayer(player);
          playerRoom.set(playerId, found.id);
          player.send({ type: 'joined_room', roomId: found.id, role: 'guest' });
          found.players[0].send({ type: 'matched', opponent: { name: player.name, isBot: false } });
          player.send({ type: 'matched', opponent: { name: found.players[0].name, isBot: false } });
          found.start();
        } else {
          const room = createRoom();
          room.addPlayer(player);
          playerRoom.set(playerId, room.id);
          player.send({ type: 'joined_room', roomId: room.id, role: 'host' });
          botTimeout = setTimeout(() => {
            if (room.players.length < 2 && !room.started && rooms.has(room.id)) {
              attachBotToRoom(room, player);
            }
          }, 3000);
        }
        break;
      }

      case 'quick_match_human': {
        if (playerRoom.has(playerId)) return;
        // 只匹配真人，不补 AI
        let found = null;
        for (const [, room] of rooms) {
          if (!room.started && !room.ended && room.players.length === 1 && !room.players[0].isBot) {
            found = room;
            break;
          }
        }
        if (found) {
          found.addPlayer(player);
          playerRoom.set(playerId, found.id);
          player.send({ type: 'joined_room', roomId: found.id, role: 'guest' });
          found.players[0].send({ type: 'matched', opponent: { name: player.name, isBot: false } });
          player.send({ type: 'matched', opponent: { name: found.players[0].name, isBot: false } });
          found.start();
        } else {
          // 创建新房间等待，不补 AI
          const room = createRoom();
          room.addPlayer(player);
          playerRoom.set(playerId, room.id);
          player.send({ type: 'joined_room', roomId: room.id, role: 'host' });
        }
        break;
      }

      case 'leave_room':
        if (botTimeout) { clearTimeout(botTimeout); botTimeout = null; }
        leaveRoom(player);
        player.send({ type: 'left_room' });
        break;

      case 'swap': {
        const roomId = playerRoom.get(playerId);
        if (!roomId) return;
        const room = rooms.get(roomId);
        if (!room || !room.started || room.ended) return;
        room.handleSwap(playerId, msg.r1, msg.c1, msg.r2, msg.c2);
        break;
      }
      case 'get_leaderboard': {
        ws.send(JSON.stringify({ type: 'leaderboard', list: getLeaderboardTop100() }));
        break;
      }
      case 'submit_score': {
        const name = String(msg.name || '').slice(0, 16).trim();
        const returnedCats = Math.max(0, Math.floor(Number(msg.returnedCats) || 0));
        const maxFoodStock = Math.max(0, Math.floor(Number(msg.maxFoodStock) || 0));
        if (!name) {
          ws.send(JSON.stringify({ type: 'score_result', ok: false, msg: '名字不能为空' }));
          break;
        }
        const idx = leaderboard.findIndex(e => e.name === name);
        if (idx >= 0) {
          const old = leaderboard[idx];
          if (returnedCats > old.returnedCats ||
              (returnedCats === old.returnedCats && maxFoodStock > old.maxFoodStock)) {
            leaderboard[idx] = { name, returnedCats, maxFoodStock, ts: Date.now() };
          }
        } else {
          leaderboard.push({ name, returnedCats, maxFoodStock, ts: Date.now() });
        }
        const top = getLeaderboardTop100();
        const rank = top.findIndex(e => e.name === name) + 1;
        ws.send(JSON.stringify({
          type: 'score_result', ok: true,
          rank: rank > 0 ? rank : null, list: top
        }));
        console.log(`[排行榜] ${name}：回窝${returnedCats} 猫粮${maxFoodStock} 排名${rank}`);
        break;
      }
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong', t: msg.t }));
        break;
    }
  });

  ws.on('close', () => {
    console.log(`[断开] ${playerId}`);
    if (botTimeout) clearTimeout(botTimeout);
    leaveRoom(player);
  });
});

console.log(`🚀 猫咪三消对战服务端: ws://localhost:${PORT}`);