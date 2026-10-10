// server.js —— 猫咪三消 · 权威服务端
// 运行方式：node server.js
// 依赖：npm install ws

const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

// ============ 核心规则（与客户端共享） ============
const CONFIG = {
  boardSize: 8,
  tileTypes: ['paw', 'fish', 'yarn', 'cookie', 'milk'],
  scoreTable: { 3: 30, 4: 45, 5: 60 },
  score6Base: 60, score6Extra: 10,
  chainBonusStep: 0.25, chainBonusMax: 0.75,
  foodPerScore: 90,
  troughCap: 24,
  roundTime: 90,
  maxPlayersPerRoom: 4
};

function randomTile() {
  return CONFIG.tileTypes[Math.floor(Math.random() * CONFIG.tileTypes.length)];
}

function swap(b, r1, c1, r2, c2) {
  const t = b[r1][c1]; b[r1][c1] = b[r2][c2]; b[r2][c2] = t;
}

function findMatches(b) {
  const groups = [];
  const size = CONFIG.boardSize;
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

// ============ 房间 ============
const rooms = new Map();

class Room {
  constructor(id) {
    this.id = id;
    this.players = new Map();
    this.board = generateBoard();
    this.timeLeft = CONFIG.roundTime;
    this.started = false;
    this.timer = null;
    this.cats = [];
    this.catIdSeq = 1;
  }

  join(playerId, ws, name) {
    if (this.players.size >= CONFIG.maxPlayersPerRoom) return false;
    this.players.set(playerId, {
      ws, name,
      score: 0, foodStock: 0, foodProgress: 0, returnedCats: 0,
      ready: false
    });
    return true;
  }

  leave(playerId) {
    this.players.delete(playerId);
    if (this.players.size === 0) {
      if (this.timer) clearInterval(this.timer);
      rooms.delete(this.id);
    }
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.timeLeft = CONFIG.roundTime;
    this.timer = setInterval(() => {
      this.timeLeft -= 0.1;
      if (this.timeLeft <= 0) {
        this.timeLeft = 0;
        this.endRound();
      }
      if (Math.floor(this.timeLeft * 10) % 10 === 0) {
        this.broadcastState();
      }
    }, 100);
  }

  handleSwap(playerId, r1, c1, r2, c2, seq) {
    const player = this.players.get(playerId);
    if (!player) return;
    if (Math.abs(r1 - r2) + Math.abs(c1 - c2) !== 1) return;

    swap(this.board, r1, c1, r2, c2);
    const first = findMatches(this.board);

    if (first.length === 0) {
      swap(this.board, r1, c1, r2, c2);
      this.send(player.ws, { type: 'event', kind: 'invalid', r1, c1, r2, c2 });
      return;
    }

    let chainLevel = 0;
    let current = first;
    let totalGain = 0;
    const allEvents = [];

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
      allEvents.push({ kind: 'match', cells, gain: gained, chain: chainLevel, by: playerId });

      cells.forEach(([r, c]) => { this.board[r][c] = null; });
      applyGravity(this.board);

      current = findMatches(this.board);
      chainLevel++;
    }

    player.score += totalGain;
    player.foodProgress += totalGain;
    while (player.foodProgress >= CONFIG.foodPerScore && player.foodStock < CONFIG.troughCap) {
      player.foodStock++;
      player.foodProgress -= CONFIG.foodPerScore;
    }

    this.broadcastState();
    this.broadcast({ type: 'event', kind: 'swap_result', events: allEvents, board: this.board });
  }

  broadcastState() {
    const players = {};
    for (const [id, p] of this.players) {
      players[id] = {
        name: p.name,
        score: p.score,
        foodStock: p.foodStock,
        returnedCats: p.returnedCats
      };
    }
    this.broadcast({
      type: 'state',
      board: this.board,
      timeLeft: this.timeLeft,
      players,
      cats: this.cats
    });
  }

  broadcast(msg) {
    const str = JSON.stringify(msg);
    for (const p of this.players.values()) {
      if (p.ws.readyState === 1) p.ws.send(str);
    }
  }

  send(ws, msg) {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  endRound() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const results = {};
    for (const [id, p] of this.players) {
      results[id] = { score: p.score, returns: p.returnedCats, foodStock: p.foodStock };
    }
    this.broadcast({ type: 'round_end', results });
    this.started = false;
    this.board = generateBoard();
    for (const p of this.players.values()) {
      p.score = 0; p.foodStock = 0; p.foodProgress = 0; p.returnedCats = 0;
      p.ready = false;
    }
  }
}

// ============ WebSocket ============
let playerSeq = 1;

wss.on('connection', (ws) => {
  const playerId = 'p' + (playerSeq++);
  let currentRoomId = null;

  console.log(`[连接] ${playerId}`);

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    switch (msg.type) {
      case 'join': {
        const roomId = msg.room || 'default';
        let room = rooms.get(roomId);
        if (!room) {
          room = new Room(roomId);
          rooms.set(roomId, room);
        }
        if (!room.join(playerId, ws, msg.name || playerId)) {
          ws.send(JSON.stringify({ type: 'error', msg: '房间已满' }));
          return;
        }
        currentRoomId = roomId;
        room.send(ws, { type: 'joined', playerId, room: roomId, players: [...room.players.keys()] });
        room.broadcastState();
        console.log(`[加入] ${playerId} → ${roomId}`);
        break;
      }
      case 'ready': {
        const room = rooms.get(currentRoomId);
        if (!room) return;
        const p = room.players.get(playerId);
        if (p) p.ready = true;
        if ([...room.players.values()].every(x => x.ready)) {
          room.start();
        }
        break;
      }
      case 'swap': {
        const room = rooms.get(currentRoomId);
        if (!room || !room.started) return;
        room.handleSwap(playerId, msg.r1, msg.c1, msg.r2, msg.c2, msg.seq);
        break;
      }
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong', t: msg.t }));
        break;
    }
  });

  ws.on('close', () => {
    console.log(`[断开] ${playerId}`);
    if (currentRoomId) {
      const room = rooms.get(currentRoomId);
      if (room) room.leave(playerId);
    }
  });
});

console.log(`🚀 猫咪三消权威服务端已启动: ws://localhost:${PORT}`);