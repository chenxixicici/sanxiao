// server.js —— 猫咪三消 · 1v1 对战服务端
// 运行：npm start
// 依赖：ws

const WebSocket = require('ws');
const https = require('https');

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

// ============ 排行榜云端存储（JSONBin） ============
const JSONBIN_BIN_ID = '6aca08c0ffd5d160535e967d';
const JSONBIN_API_KEY = '$2a$10$.crbh1ykHy/zWYPRZYw6LexAKMKGIcGwvYP3Cu/HG6pmdlTbCsUye';

let leaderboardCache = [];  // 内存缓存
let jsonbinDirty = false;   // 是否有未同步的修改

function jsonbinRequest(method, data, path, callback) {
  const body = data ? JSON.stringify(data) : '';
  const options = {
    hostname: 'api.jsonbin.io',
    port: 443,
    path: path || `/v3/b/${JSONBIN_BIN_ID}`,
    method: method,
    headers: {
      'Content-Type': 'application/json',
      'X-Master-Key': JSONBIN_API_KEY
    }
  };
  if (body) options.headers['Content-Length'] = Buffer.byteLength(body);

  const req = https.request(options, (res) => {
    let raw = '';
    res.on('data', (chunk) => raw += chunk);
    res.on('end', () => {
      try {
        const json = JSON.parse(raw);
        callback(null, json);
      } catch (e) {
        callback(e, null);
      }
    });
  });
  req.on('error', (e) => callback(e, null));
  if (body) req.write(body);
  req.end();
}

function loadLeaderboardFromCloud() {
  jsonbinRequest('GET', null, `/v3/b/${JSONBIN_BIN_ID}/latest`, (err, res) => {
    if (err) {
      console.warn('[排行榜] 云端读取失败:', err.message);
      return;
    }
    // JSONBin /latest 返回 { record: {...}, metadata: {...} }
    let record = res && res.record ? res.record : res;
    if (record && Array.isArray(record.scores)) {
      leaderboardCache = record.scores;
      console.log(`[排行榜] 从云端加载 ${leaderboardCache.length} 条记录`);
    } else {
      console.log('[排行榜] 云端数据格式不正确，重置为空');
      leaderboardCache = [];
    }
  });
}

function saveLeaderboardToCloud() {
  jsonbinRequest('PUT', { scores: leaderboardCache }, null, (err, res) => {
    if (err) {
      console.warn('[排行榜] 云端写入失败:', err.message);
      jsonbinDirty = true;
    } else {
      jsonbinDirty = false;
      console.log(`[排行榜] 云端已保存 ${leaderboardCache.length} 条记录`);
    }
  });
}

function getLeaderboardTop100() {
  const scoreOf = (e) => {
    if (typeof e.score === 'number') return e.score;
    if (typeof e.maxFoodStock === 'number') return e.maxFoodStock;  // 旧数据兼容
    return 0;
  };
  return leaderboardCache
    .slice()
    .sort((a, b) => {
      if (b.returnedCats !== a.returnedCats) return b.returnedCats - a.returnedCats;
      if (scoreOf(b) !== scoreOf(a)) return scoreOf(b) - scoreOf(a);
      return a.ts - b.ts;
    })
    .slice(0, 100);
}

// 启动时加载
loadLeaderboardFromCloud();
// 每 20 秒同步一次未保存的修改（防止高频写云端）
setInterval(() => {
  if (jsonbinDirty) saveLeaderboardToCloud();
}, 20000);

// ============ 配置 ============
const CONFIG = {
  boardRows: 7,
  boardCols: 8,
  tileTypes: ['paw', 'fish', 'yarn', 'cookie', 'milk'],
  scoreTable: { 3: 20, 4: 30, 5: 40 },
  score6Base: 40, score6Extra: 8,
  chainBonusStep: 0.25, chainBonusMax: 0.75,
  foodPerScore: 90,
  troughCap: 6,
  roundTime: 90,
  catPhases: {
    walkingToFood: 1300,
    eating: 4500,
    cleaning: 4500,
    happy: 3000,
    walkingToHome: 1700
  },
  maxCatsPerPlayer: 6,
  poolSize: 10,
  totalCatCap: 64
};

// ============ 核心规则 ============
function randomTile() {
  return CONFIG.tileTypes[Math.floor(Math.random() * CONFIG.tileTypes.length)];
}
function swap(b, r1, c1, r2, c2) {
  const t = b[r1][c1]; b[r1][c1] = b[r2][c2]; b[r2][c2] = t;
}
function findMatches(b) {
  const groups = []; const rows = CONFIG.boardRows, cols = CONFIG.boardCols;
  for (let r = 0; r < rows; r++) {
    let c = 0;
    while (c < cols) {
      const t = b[r][c]; let len = 1;
      while (c + len < cols && b[r][c + len] === t) len++;
      if (len >= 3) {
        const cells = [];
        for (let i = 0; i < len; i++) cells.push([r, c + i]);
        groups.push({ cells, length: len });
      }
      c += len;
    }
  }
  for (let c = 0; c < cols; c++) {
    let r = 0;
    while (r < rows) {
      const t = b[r][c]; let len = 1;
      while (r + len < rows && b[r + len][c] === t) len++;
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
  const rows = CONFIG.boardRows, cols = CONFIG.boardCols;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (c < cols - 1) {
        swap(b, r, c, r, c + 1);
        const ok = findMatches(b).length > 0;
        swap(b, r, c, r, c + 1);
        if (ok) return true;
      }
      if (r < rows - 1) {
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
    const b = Array.from({ length: CONFIG.boardRows }, () =>
      Array(CONFIG.boardCols).fill(null));
    for (let r = 0; r < CONFIG.boardRows; r++) {
      for (let c = 0; c < CONFIG.boardCols; c++) {
        const forbid = new Set();
        if (c >= 2 && b[r][c - 1] === b[r][c - 2]) forbid.add(b[r][c - 1]);
        if (r >= 2 && b[r - 1][c] === b[r - 2][c]) forbid.add(b[r - 1][c]);
        const opts = CONFIG.tileTypes.filter(t => !forbid.has(t));
        b[r][c] = opts[Math.floor(Math.random() * opts.length)];
      }
    }
    if (hasPossibleMove(b)) return b;
  }
  return Array.from({ length: CONFIG.boardRows }, () =>
    Array.from({ length: CONFIG.boardCols }, () => randomTile()));
}
function applyGravity(board) {
  const rows = CONFIG.boardRows, cols = CONFIG.boardCols;
  for (let c = 0; c < cols; c++) {
    let write = rows - 1;
    for (let r = rows - 1; r >= 0; r--) {
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

function maxConcurrentByFood(stock) {
  if (stock <= 0) return 0;
  return Math.min(stock, 6);
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
    this.bowls = Array.from({ length: 6 }, () => ({ filled: false, eaten: 0, eaterCatId: null }));
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
    this.cats = [];
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
    this.timers.push(setInterval(() => this.trySpawnWaitingCat(), 2500));
    this.timers.push(setInterval(() => this.trySendCatToEat(), 100));
    this.timers.push(setInterval(() => this.broadcastState(), 150));

    console.log(`[开局] ${this.id} ${this.players.map(p => p.name).join(' vs ')}`);
  }

  startBot(bot) {
    bot.botTimer = setInterval(() => {
      if (!this.started || this.ended) return;
      this.botMove(bot);
    }, 4500 + Math.random() * 1000);
  }

  botMove(bot) {
    const rows = CONFIG.boardRows, cols = CONFIG.boardCols;
    const moves = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (c < cols - 1) {
          swap(bot.board, r, c, r, c + 1);
          if (findMatches(bot.board).length > 0) moves.push([r, c, r, c + 1]);
          swap(bot.board, r, c, r, c + 1);
        }
        if (r < rows - 1) {
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
    if (!p) return;
    if (this.ended || !this.started) {
      p.send({ type: 'event', kind: 'invalid' });
      return;
    }
    if (![r1, c1, r2, c2].every(Number.isInteger) ||
        r1 < 0 || r1 >= CONFIG.boardRows || r2 < 0 || r2 >= CONFIG.boardRows ||
        c1 < 0 || c1 >= CONFIG.boardCols || c2 < 0 || c2 >= CONFIG.boardCols) {
      p.send({ type: 'event', kind: 'invalid' });
      return;
    }
    if (Math.abs(r1 - r2) + Math.abs(c1 - c2) !== 1) {
      p.send({ type: 'event', kind: 'invalid' });
      return;
    }

    swap(p.board, r1, c1, r2, c2);
    const first = findMatches(p.board);
    if (first.length === 0) {
      swap(p.board, r1, c1, r2, c2);
      p.send({ type: 'event', kind: 'invalid' });
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

      cells.forEach(([r, c]) => { p.board[r][c] = null; });
      applyGravity(p.board);

      events.push({
        kind: 'match',
        cells,
        gain: gained,
        chain: chainLevel,
        length: current[0].length,
        boardAfter: p.board.map(row => row.slice())   // 深拷贝快照
      });

      current = findMatches(p.board);
      chainLevel++;
    }

    p.score += totalGain;
    p.foodProgress += totalGain;
    while (p.foodProgress >= CONFIG.foodPerScore && p.foodStock < CONFIG.troughCap) {
      const b = p.bowls.find(b => !b.filled && !b.eaterCatId);
      if (!b) break;
      p.foodStock++;
      p.foodProgress -= CONFIG.foodPerScore;
      b.filled = true;
      b.eaten = 0;
      b.eaterCatId = null;
    }

    p.send({ type: 'event', kind: 'swap_result', swap: { r1, c1, r2, c2 }, events, board: p.board });
  }

  tickCats() {
    if (this.ended) return;
    const now = Date.now();
    for (const cat of this.cats) {
      const elapsed = now - cat.stateStart;
      let nextState = null;
      switch (cat.state) {
        case 'entering':
          if (elapsed >= 680) nextState = 'waiting';
          break;
        case 'walking_to_food':
          if (elapsed >= CONFIG.catPhases.walkingToFood) nextState = 'eating';
          break;
        case 'eating': {
          const total = CONFIG.catPhases.eating;
          const prog = Math.min(2, Math.floor((elapsed / total) * 3));
          if (cat.eatSlot >= 0) {
            const owner = this.players.find(p => p.id === cat.ownerId);
            if (owner && owner.bowls[cat.eatSlot]) {
              owner.bowls[cat.eatSlot].eaten = prog;
            }
          }
          if (elapsed >= total) {
            // 吃完：碗里粮没了，但 eaterCatId 保留（猫还占着碗）
            if (cat.eatSlot >= 0) {
              const owner = this.players.find(p => p.id === cat.ownerId);
              if (owner && owner.bowls[cat.eatSlot]) {
                owner.bowls[cat.eatSlot].filled = false;
                owner.bowls[cat.eatSlot].eaten = 0;
              }
            }
            nextState = 'cleaning';
          }
          break;
        }
        case 'cleaning':
          if (elapsed >= CONFIG.catPhases.cleaning) nextState = 'happy';
          break;
        case 'happy':
          if (elapsed >= CONFIG.catPhases.happy) {
            // 猫离开进食位：释放它占的碗
            if (cat.eatSlot >= 0) {
              const owner = this.players.find(p => p.id === cat.ownerId);
              if (owner && owner.bowls[cat.eatSlot]) {
                owner.bowls[cat.eatSlot].eaterCatId = null;
              }
              cat.eatSlot = -1;
            }
            nextState = 'walking_to_home';
          }
          break;
        case 'walking_to_home':
          if (elapsed >= CONFIG.catPhases.walkingToHome) nextState = 'sleeping';
          break;
      }
      if (nextState) {
        cat.state = nextState;
        cat.stateStart = now;
        if (nextState === 'sleeping') {
          const owner = this.players.find(p => p.id === cat.ownerId);
          if (owner) owner.returnedCats++;
        }
        this.broadcast({ type: 'cat_event', kind: 'state', catId: cat.id, state: nextState });
      }
    }
    // sleeping cats are intentionally retained for the entire round.
    // totalCatCap only stops additional spawns; never evict cats that have returned home.
  }

  // 往等待区补一只中立猫（不扣粮）
  trySpawnWaitingCat() {
    if (this.ended || !this.started) return;
    const waitingCats = this.cats.filter(c => !c.ownerId && (c.state === 'entering' || c.state === 'waiting'));
    if (waitingCats.length >= CONFIG.poolSize) return;
    if (this.cats.length >= CONFIG.totalCatCap) return;

    const cat = {
      id: this.catIdSeq++,
      ownerId: null,
      state: 'entering',
      stateStart: Date.now(),
      paletteIdx: Math.floor(Math.random() * 5),
      slot: waitingCats.length,
      eatSlot: -1
    };
    this.cats.push(cat);
    this.broadcast({
      type: 'cat_event',
      kind: 'spawn',
      cat: { id: cat.id, paletteIdx: cat.paletteIdx, slot: cat.slot }
    });
  }

  // 有粮且有等待猫 → 派一只去吃
  trySendCatToEat() {
    if (this.ended || !this.started) return;
    if (this.players.length < 2) return;

    const waiter = this.cats.find(c => !c.ownerId && c.state === 'waiting');
    if (!waiter) return;

    const usingCount = {};
    for (const p of this.players) usingCount[p.id] = 0;
    for (const c of this.cats) {
      if (c.ownerId &&
          ['walking_to_food', 'eating', 'cleaning', 'happy'].includes(c.state)) {
        if (usingCount[c.ownerId] !== undefined) usingCount[c.ownerId]++;
      }
    }

    // 候选玩家：有粮 + 有可用空碗 + 未达并发上限
    const candidates = this.players.filter(p => {
      if (p.foodStock <= 0) return false;
      if (usingCount[p.id] >= maxConcurrentByFood(p.foodStock + usingCount[p.id])) return false;
      if (usingCount[p.id] >= CONFIG.maxCatsPerPlayer) return false;
      const hasFreeBowl = p.bowls.some(b => b.filled && !b.eaterCatId);
      if (!hasFreeBowl) return false;
      return true;
    });
    if (candidates.length === 0) return;

    // 加权随机
    const total = candidates.reduce((s, p) => s + p.foodStock, 0);
    if (total <= 0) return;
    let rnd = Math.random() * total;
    let target = candidates[0];
    for (const p of candidates) {
      rnd -= p.foodStock;
      if (rnd <= 0) { target = p; break; }
    }

    // 找这个玩家第一个"有粮且未被占"的碗
    let bowlIdx = -1;
    for (let i = 0; i < 6; i++) {
      const b = target.bowls[i];
      if (b.filled && !b.eaterCatId) { bowlIdx = i; break; }
    }
    if (bowlIdx < 0) return;

    target.foodStock--;
    target.bowls[bowlIdx].eaterCatId = waiter.id;
    waiter.ownerId = target.id;
    waiter.eatSlot = bowlIdx;
    waiter.state = 'walking_to_food';
    waiter.stateStart = Date.now();

    this.broadcast({
      type: 'cat_event',
      kind: 'go_eat',
      catId: waiter.id,
      ownerId: waiter.ownerId,
      eatSlot: bowlIdx
    });
    this.broadcastState();
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
        myScore: p.score,
        myFoodStock: p.foodStock,
        myFoodProgress: p.foodProgress,
        myReturnedCats: p.returnedCats,
        myBowls: p.bowls.map(b => ({ filled: b.filled, eaten: b.eaten })),
        opponent: opp ? {
          id: opp.id, name: opp.name, score: opp.score,
          foodStock: opp.foodStock, returnedCats: opp.returnedCats, isBot: opp.isBot,
          bowls: opp.bowls.map(b => ({ filled: b.filled, eaten: b.eaten }))
        } : null
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

      // ============ 排行榜 ============
      case 'get_leaderboard': {
        ws.send(JSON.stringify({ type: 'leaderboard', list: getLeaderboardTop100() }));
        break;
      }
      case 'submit_score': {
        const name = String(msg.name || '').slice(0, 16).trim();
        const returnedCats = Math.max(0, Math.floor(Number(msg.returnedCats) || 0));
        const score = Math.max(0, Math.floor(Number(msg.score) || 0));
        if (!name) {
          ws.send(JSON.stringify({ type: 'score_result', ok: false, msg: '名字不能为空' }));
          break;
        }
        const scoreOf = (e) => {
          if (typeof e.score === 'number') return e.score;
          if (typeof e.maxFoodStock === 'number') return e.maxFoodStock;
          return 0;
        };
        const idx = leaderboardCache.findIndex(e => e.name === name);
        if (idx >= 0) {
          const old = leaderboardCache[idx];
          if (returnedCats > old.returnedCats ||
              (returnedCats === old.returnedCats && score > scoreOf(old))) {
            leaderboardCache[idx] = { name, returnedCats, score, ts: Date.now() };
            jsonbinDirty = true;
          }
        } else {
          leaderboardCache.push({ name, returnedCats, score, ts: Date.now() });
          jsonbinDirty = true;
        }
        saveLeaderboardToCloud();
        const top = getLeaderboardTop100();
        const rank = top.findIndex(e => e.name === name) + 1;
        ws.send(JSON.stringify({
          type: 'score_result', ok: true,
          rank: rank > 0 ? rank : null, list: top
        }));
        console.log(`[排行榜] ${name}：回窝${returnedCats} 积分${score} 排名${rank}`);
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
console.log(`📊 排行榜已连接 JSONBin: ${JSONBIN_BIN_ID}`);