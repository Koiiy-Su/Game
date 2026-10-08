
## 文件 4：`friend.js`（完整代码）

```javascript
'use strict';
/*
 * 欢乐小游戏 · 多人在线小游戏平台
 * - 用户注册 / 登录
 * - 跳一跳 / 贪吃蛇 / 你画我猜
 * - 排行榜 + SSE 实时
 * - 纯 Node 内置模块，零依赖
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const url = require('url');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SECRET = process.env.SESSION_SECRET || 'bestie-games-v1-secret';

fs.mkdirSync(DATA_DIR, { recursive: true });

/* ============ 数据库 ============ */
function loadDB() {
  try {
    const d = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    return { users: d.users || {}, scores: d.scores || {} };
  } catch (e) {
    return { users: {}, scores: {} };
  }
}
const db = loadDB();
let saveTimer = null;
function saveDB() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DB_FILE + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, DB_FILE);
    } catch (e) { console.error('saveDB', e); }
  }, 100);
}

/* ============ 认证 ============ */
function hashPassword(pw, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 32).toString('hex');
  return salt + ':' + hash;
}
function verifyPassword(pw, stored) {
  if (!stored) return false;
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(pw, salt, 32).toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(test, 'hex'));
  } catch (e) { return false; }
}
function sign(payload) {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
}
function makeToken(username) {
  const exp = Date.now() + 1000 * 60 * 60 * 24 * 30;
  const payload = username + '.' + exp;
  return payload + '.' + sign(payload);
}
function validToken(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [username, expStr, sig] = parts;
  if (!/^\d+$/.test(expStr) || Number(expStr) < Date.now()) return null;
  const s = sign(username + '.' + expStr);
  if (s.length !== sig.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(s), Buffer.from(sig))) return null;
  } catch (e) { return null; }
  return username;
}
function parseCookies(req) {
  const h = req.headers.cookie || '';
  const o = {};
  h.split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return o;
}
function currentUser(req) {
  return validToken(parseCookies(req)['gid']);
}

/* ============ 工具 ============ */
function sendJSON(res, code, obj, headers) {
  res.writeHead(code, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  }, headers || {}));
  res.end(JSON.stringify(obj));
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('内容过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function recordScore(game, username, score) {
  if (!db.scores[game]) db.scores[game] = {};
  const cur = db.scores[game][username] || 0;
  if (score > cur) {
    db.scores[game][username] = score;
    saveDB();
    return true;
  }
  return false;
}
function getLeaderboard(game, limit) {
  const m = db.scores[game] || {};
  return Object.keys(m)
    .map(u => ({ username: u, score: m[u] }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit || 20);
}

/* ============ 房间系统 ============ */
const rooms = new Map();

function newRoomId() {
  let id;
  do { id = crypto.randomBytes(3).toString('hex'); } while (rooms.has(id));
  return id;
}
function createRoom(game, host) {
  const room = {
    id: newRoomId(),
    game,
    host,
    players: new Map(),
    state: null,
    timer: null,
    clients: new Set(),
    createdAt: Date.now()
  };
  rooms.set(room.id, room);
  return room;
}
function roomBroadcast(room, event, data) {
  const payload = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  for (const res of room.clients) {
    try { res.write(payload); } catch (e) {}
  }
}
function joinRoom(room, username) {
  if (!room.players.has(username)) {
    room.players.set(username, { name: username, alive: true, score: 0 });
  }
  return room.players.get(username);
}
function leaveRoom(room, username) {
  room.players.delete(username);
  if (room.players.size === 0) {
    if (room.timer) { clearInterval(room.timer); room.timer = null; }
    rooms.delete(room.id);
  }
}
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (room.players.size === 0 && now - room.createdAt > 30 * 60 * 1000) {
      if (room.timer) clearInterval(room.timer);
      rooms.delete(id);
    }
  }
}, 60 * 1000);

/* ============ 贪吃蛇 ============ */
const SNAKE_W = 28, SNAKE_H = 20;
const DIRS = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
const SNAKE_COLORS = ['#e06f92', '#6f9ce0', '#7bb87b', '#e0a56f'];

function startSnake(room) {
  if (room.timer) return;
  const usernames = [...room.players.keys()].slice(0, 4);
  if (usernames.length < 1) return;

  const startPos = [
    { x: 3, y: 3, d: 'right' },
    { x: SNAKE_W - 4, y: SNAKE_H - 4, d: 'left' },
    { x: 3, y: SNAKE_H - 4, d: 'right' },
    { x: SNAKE_W - 4, y: 3, d: 'left' }
  ];
  const snakes = {};
  usernames.forEach((u, i) => {
    const p = startPos[i];
    snakes[u] = {
      name: u,
      color: SNAKE_COLORS[i],
      body: [{ x: p.x, y: p.y }, { x: p.x, y: p.y }, { x: p.x, y: p.y }],
      dir: p.d, nextDir: p.d, alive: true, score: 0
    };
  });
  room.state = { w: SNAKE_W, h: SNAKE_H, snakes, food: [], running: true };

  const randFood = () => {
    for (let t = 0; t < 100; t++) {
      const x = Math.floor(Math.random() * SNAKE_W);
      const y = Math.floor(Math.random() * SNAKE_H);
      let ok = true;
      for (const u in snakes) {
        if (snakes[u].body.some(s => s.x === x && s.y === y)) { ok = false; break; }
      }
      if (ok && !room.state.food.some(f => f.x === x && f.y === y)) return { x, y };
    }
    return { x: 0, y: 0 };
  };
  for (let i = 0; i < 3; i++) room.state.food.push(randFood());

  room.timer = setInterval(() => {
    const s = room.state;
    if (!s || !s.running) return;

    const occupied = new Set();
    for (const u in s.snakes) {
      const sn = s.snakes[u];
      if (!sn.alive) continue;
      for (const b of sn.body) occupied.add(b.x + ',' + b.y);
    }

    const newHeads = {};
    for (const u in s.snakes) {
      const sn = s.snakes[u];
      if (!sn.alive) continue;
      const cur = DIRS[sn.dir], nxt = DIRS[sn.nextDir];
      if (!(cur.x + nxt.x === 0 && cur.y + nxt.y === 0)) sn.dir = sn.nextDir;
      const d = DIRS[sn.dir];
      const head = sn.body[0];
      const nh = { x: head.x + d.x, y: head.y + d.y };
      if (nh.x < 0 || nh.x >= SNAKE_W || nh.y < 0 || nh.y >= SNAKE_H) {
        sn.alive = false; continue;
      }
      newHeads[u] = nh;
    }

    for (const u in newHeads) {
      const nh = newHeads[u];
      if (occupied.has(nh.x + ',' + nh.y)) {
        const sn = s.snakes[u];
        const tail = sn.body[sn.body.length - 1];
        if (!(tail.x === nh.x && tail.y === nh.y)) {
          sn.alive = false; delete newHeads[u];
        }
      }
    }

    for (const u in newHeads) {
      const sn = s.snakes[u];
      sn.body.unshift(newHeads[u]);
      const fi = s.food.findIndex(f => f.x === newHeads[u].x && f.y === newHeads[u].y);
      if (fi >= 0) {
        s.food.splice(fi, 1);
        s.food.push(randFood());
        sn.score += 10;
      } else {
        sn.body.pop();
      }
    }

    const aliveCount = Object.values(s.snakes).filter(x => x.alive).length;
    if (aliveCount <= 1) {
      s.running = false;
      if (room.timer) { clearInterval(room.timer); room.timer = null; }
      for (const u in s.snakes) {
        if (s.snakes[u].score > 0) recordScore('snake', u, s.snakes[u].score);
      }
      roomBroadcast(room, 'snake-end', { state: s });
      return;
    }

    roomBroadcast(room, 'snake-state', { state: s });
  }, 150);

  roomBroadcast(room, 'snake-start', { state: room.state });
}

/* ============ 你画我猜 ============ */
const DRAW_WORDS = [
  '太阳', '月亮', '苹果', '香蕉', '房子', '大树', '小狗', '小猫',
  '汽车', '飞机', '电脑', '雨伞', '眼镜', '蛋糕', '雪人', '彩虹',
  '星星', '足球', '铅笔', '花朵', '时钟', '小鸟', '冰淇淋', '气球'
];
const DRAW_ROUND_TIME = 60;
const DRAW_ROUNDS = 3;

function startDrawGame(room) {
  if (room.timer) return;
  const usernames = [...room.players.keys()];
  if (usernames.length < 2) return;
  room.state = {
    phase: 'drawing', round: 1, maxRounds: DRAW_ROUNDS,
    drawerIdx: 0, drawer: usernames[0], word: '',
    revealed: '', strokes: [], guesses: [], correctGuessers: [],
    timeLeft: DRAW_ROUND_TIME, scores: {}, usernames
  };
  usernames.forEach(u => room.state.scores[u] = 0);
  beginDrawRound(room);
}

function beginDrawRound(room) {
  const s = room.state;
  s.drawer = s.usernames[s.drawerIdx % s.usernames.length];
  s.word = DRAW_WORDS[Math.floor(Math.random() * DRAW_WORDS.length)];
  s.revealed = '_ '.repeat(s.word.length).trim();
  s.strokes = [];
  s.guesses = [];
  s.correctGuessers = [];
  s.timeLeft = DRAW_ROUND_TIME;
  s.phase = 'drawing';

  roomBroadcast(room, 'draw-start', {
    round: s.round, maxRounds: s.maxRounds, drawer: s.drawer,
    wordLength: s.word.length, revealed: s.revealed,
    scores: s.scores, timeLeft: s.timeLeft
  });
  roomBroadcast(room, 'draw-word', { drawer: s.drawer, word: s.word });

  if (room.timer) clearInterval(room.timer);
  room.timer = setInterval(() => {
    s.timeLeft--;
    if (s.timeLeft <= 0) {
      clearInterval(room.timer);
      room.timer = null;
      endDrawRound(room);
    } else {
      roomBroadcast(room, 'draw-tick', { timeLeft: s.timeLeft });
    }
  }, 1000);
}

function endDrawRound(room) {
  const s = room.state;
  if (!s) return;
  s.phase = 'reveal';
  roomBroadcast(room, 'draw-reveal', { word: s.word, scores: s.scores });
  setTimeout(() => {
    if (!rooms.has(room.id)) return;
    s.drawerIdx++;
    if (s.drawerIdx >= s.usernames.length * s.maxRounds) {
      s.phase = 'ended';
      for (const u in s.scores) recordScore('draw', u, s.scores[u]);
      roomBroadcast(room, 'draw-end', { scores: s.scores });
    } else {
      s.round = Math.floor(s.drawerIdx / s.usernames.length) + 1;
      beginDrawRound(room);
    }
  }, 4000);
}

/* ============ HTTP 服务 ============ */
const server = http.createServer(async (req, res) => {
  const u = url.parse(req.url, true);
  const p = u.pathname;
  const method = req.method;

  try {
    if (p === '/' || p === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(INDEX_HTML);
    }

    if (method === 'POST' && p === '/api/register') {
      const body = JSON.parse((await readBody(req, 1e5)).toString() || '{}');
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      if (!/^[\u4e00-\u9fa5a-zA-Z0-9_]{2,16}$/.test(username)) {
        return sendJSON(res, 400, { error: '用户名需 2-16 位中文/字母/数字' });
      }
      if (password.length < 4) return sendJSON(res, 400, { error: '密码至少 4 位' });
      if (db.users[username]) return sendJSON(res, 400, { error: '用户名已被注册' });
      db.users[username] = { password: hashPassword(password), createdAt: Date.now() };
      saveDB();
      res.writeHead(200, {
        'Set-Cookie': 'gid=' + makeToken(username) + '; HttpOnly; Path=/; Max-Age=' + (60 * 60 * 24 * 30) + '; SameSite=Lax',
        'Content-Type': 'application/json'
      });
      return res.end(JSON.stringify({ ok: true, username }));
    }

    if (method === 'POST' && p === '/api/login') {
      const body = JSON.parse((await readBody(req, 1e5)).toString() || '{}');
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      const user = db.users[username];
      if (!user || !verifyPassword(password, user.password)) {
        return sendJSON(res, 401, { error: '用户名或密码错误' });
      }
      res.writeHead(200, {
        'Set-Cookie': 'gid=' + makeToken(username) + '; HttpOnly; Path=/; Max-Age=' + (60 * 60 * 24 * 30) + '; SameSite=Lax',
        'Content-Type': 'application/json'
      });
      return res.end(JSON.stringify({ ok: true, username }));
    }

    if (method === 'POST' && p === '/api/logout') {
      res.writeHead(200, {
        'Set-Cookie': 'gid=; HttpOnly; Path=/; Max-Age=0',
        'Content-Type': 'application/json'
      });
      return res.end(JSON.stringify({ ok: true }));
    }

    if (p === '/api/me') {
      const user = currentUser(req);
      return sendJSON(res, 200, { authed: !!user, username: user });
    }

    if (p.indexOf('/api/') === 0) {
      const me = currentUser(req);
      if (!me) return sendJSON(res, 401, { error: '请先登录' });

      if (method === 'GET' && p === '/api/leaderboard') {
        const game = u.query.game || 'jump';
        return sendJSON(res, 200, { game, list: getLeaderboard(game, 20) });
      }

      if (method === 'POST' && p === '/api/score') {
        const body = JSON.parse((await readBody(req, 1e4)).toString() || '{}');
        const game = String(body.game || '');
        const score = Math.max(0, Math.floor(Number(body.score) || 0));
        if (game !== 'jump') return sendJSON(res, 400, { error: '不支持的游戏' });
        recordScore(game, me, score);
        return sendJSON(res, 200, { ok: true, list: getLeaderboard(game, 20) });
      }

      if (method === 'POST' && p === '/api/room/create') {
        const body = JSON.parse((await readBody(req, 1e4)).toString() || '{}');
        const game = String(body.game || '');
        if (!['snake', 'draw'].includes(game)) return sendJSON(res, 400, { error: '不支持的游戏' });
        const room = createRoom(game, me);
        joinRoom(room, me);
        return sendJSON(res, 200, { ok: true, roomId: room.id, game });
      }

      if (method === 'POST' && p === '/api/room/join') {
        const body = JSON.parse((await readBody(req, 1e4)).toString() || '{}');
        const roomId = String(body.roomId || '').trim().toLowerCase();
        const room = rooms.get(roomId);
        if (!room) return sendJSON(res, 404, { error: '房间不存在或已关闭' });
        joinRoom(room, me);
        roomBroadcast(room, 'players', { players: [...room.players.keys()], host: room.host });
        return sendJSON(res, 200, { ok: true, roomId: room.id, game: room.game });
      }

      if (method === 'POST' && p === '/api/room/leave') {
        const body = JSON.parse((await readBody(req, 1e4)).toString() || '{}');
        const room = rooms.get(String(body.roomId || ''));
        if (room) {
          leaveRoom(room, me);
          roomBroadcast(room, 'players', { players: [...room.players.keys()], host: room.host });
        }
        return sendJSON(res, 200, { ok: true });
      }

      if (method === 'GET' && p === '/api/room/events') {
        const roomId = u.query.room;
        const room = rooms.get(roomId);
        if (!room) return sendJSON(res, 404, { error: '房间不存在' });
        joinRoom(room, me);

        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no'
        });
        res.write('retry: 3000\n\n');
        room.clients.add(res);

        res.write('event: init\ndata: ' + JSON.stringify({
          roomId: room.id, game: room.game, host: room.host,
          players: [...room.players.keys()], me
        }) + '\n\n');

        if (room.state) {
          if (room.game === 'snake') {
            res.write('event: snake-state\ndata: ' + JSON.stringify({ state: room.state }) + '\n\n');
          } else if (room.game === 'draw') {
            res.write('event: draw-sync\ndata: ' + JSON.stringify({
              phase: room.state.phase, round: room.state.round,
              maxRounds: room.state.maxRounds, drawer: room.state.drawer,
              wordLength: room.state.word ? room.state.word.length : 0,
              revealed: room.state.revealed, scores: room.state.scores,
              timeLeft: room.state.timeLeft, strokes: room.state.strokes,
              guesses: room.state.guesses
            }) + '\n\n');
          }
        }

        roomBroadcast(room, 'players', { players: [...room.players.keys()], host: room.host });

        const hb = setInterval(() => {
          try { res.write(': ping\n\n'); } catch (e) {}
        }, 25000);

        req.on('close', () => {
          clearInterval(hb);
          room.clients.delete(res);
          setTimeout(() => {
            if (!rooms.has(room.id)) return;
            if (room.clients.size === 0) {
              leaveRoom(room, me);
              roomBroadcast(room, 'players', { players: [...room.players.keys()], host: room.host });
            }
          }, 3000);
        });
        return;
      }

      if (method === 'POST' && p === '/api/room/action') {
        const body = JSON.parse((await readBody(req, 2e5)).toString() || '{}');
        const room = rooms.get(String(body.roomId || ''));
        if (!room) return sendJSON(res, 404, { error: '房间不存在' });
        const act = String(body.action || '');

        if (act === 'start') {
          if (room.host !== me) return sendJSON(res, 403, { error: '只有房主可以开始' });
          if (room.game === 'snake') {
            if (room.players.size < 1) return sendJSON(res, 400, { error: '至少需要 1 人' });
            startSnake(room);
          } else if (room.game === 'draw') {
            if (room.players.size < 2) return sendJSON(res, 400, { error: '至少需要 2 人' });
            startDrawGame(room);
          }
          return sendJSON(res, 200, { ok: true });
        }

        if (room.game === 'snake') {
          if (act === 'dir' && room.state && room.state.running) {
            const sn = room.state.snakes[me];
            if (sn && sn.alive) {
              const d = String(body.dir || '');
              if (DIRS[d]) sn.nextDir = d;
            }
            return sendJSON(res, 200, { ok: true });
          }
        }

        if (room.game === 'draw') {
          const s = room.state;
          if (!s) return sendJSON(res, 400, { error: '游戏未开始' });

          if (act === 'stroke' && s.phase === 'drawing' && s.drawer === me) {
            const st = {
              x1: Math.max(0, Math.min(1, Number(body.x1))),
              y1: Math.max(0, Math.min(1, Number(body.y1))),
              x2: Math.max(0, Math.min(1, Number(body.x2))),
              y2: Math.max(0, Math.min(1, Number(body.y2))),
              color: String(body.color || '#1a1a1a').slice(0, 16),
              w: Math.max(1, Math.min(20, Number(body.w) || 3))
            };
            s.strokes.push(st);
            if (s.strokes.length > 3000) s.strokes.splice(0, 500);
            roomBroadcast(room, 'draw-stroke', st);
            return sendJSON(res, 200, { ok: true });
          }

          if (act === 'clear' && s.phase === 'drawing' && s.drawer === me) {
            s.strokes = [];
            roomBroadcast(room, 'draw-clear', {});
            return sendJSON(res, 200, { ok: true });
          }

          if (act === 'guess' && s.phase === 'drawing' && s.drawer !== me) {
            const text = String(body.text || '').trim().slice(0, 20);
            if (!text) return sendJSON(res, 400, { error: '内容为空' });
            if (s.correctGuessers.includes(me)) return sendJSON(res, 400, { error: '你已经猜对啦' });
            const isCorrect = text === s.word;
            const g = { name: me, text, correct: isCorrect, ts: Date.now() };
            s.guesses.push(g);
            if (s.guesses.length > 200) s.guesses.splice(0, 50);

            if (isCorrect) {
              s.correctGuessers.push(me);
              s.scores[me] = (s.scores[me] || 0) + 10;
              if (s.scores[s.drawer] !== undefined) s.scores[s.drawer] += 5;
              const revealCount = s.correctGuessers.length * Math.ceil(s.word.length / Math.max(1, s.usernames.length - 1));
              s.revealed = s.word.split('').map((c, i) => i < revealCount ? c : '_').join(' ');
              roomBroadcast(room, 'draw-guess', { guess: g, scores: s.scores, revealed: s.revealed });
              if (s.correctGuessers.length >= s.usernames.length - 1) {
                if (room.timer) { clearInterval(room.timer); room.timer = null; }
                endDrawRound(room);
              }
            } else {
              roomBroadcast(room, 'draw-guess', { guess: g });
            }
            return sendJSON(res, 200, { ok: true, correct: isCorrect });
          }
        }

        return sendJSON(res, 400, { error: '无效操作' });
      }

      return sendJSON(res, 404, { error: '接口不存在' });
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  } catch (e) {
    console.error('[error]', e);
    if (!res.headersSent) sendJSON(res, 500, { error: (e && e.message) || '服务器错误' });
  }
});

/* ============ 前端页面 ============ */
const INDEX_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0f1117">
<title>欢乐小游戏 · 多人在线</title>
<link href="https://cdn.jsdelivr.net/npm/@fontsource-variable/noto-sans-sc@5.2.10/index.css" rel="stylesheet">
<style>
:root{
  --bg:#0f1117;--panel:#171a24;--panel-2:#1e2231;--panel-3:#252a3d;
  --fg:#e8ecf5;--muted:#8b93a7;--border:#2a3046;
  --accent:#7c5cff;--accent-2:#9d7dff;--accent-soft:rgba(124,92,255,.15);
  --pink:#e06f92;--green:#5fd28f;--yellow:#f5c96b;--red:#f56565;
  --radius:14px;--radius-lg:20px;
  --shadow:0 20px 50px -25px rgba(0,0,0,.6);
  --font:"Noto Sans SC Variable","PingFang SC","Microsoft YaHei",system-ui,sans-serif;
}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;color:var(--fg);font-family:var(--font);font-size:15px;line-height:1.6;
  -webkit-font-smoothing:antialiased;overflow-x:hidden;min-height:100vh;
  background:radial-gradient(900px 500px at 85% -10%, rgba(124,92,255,.18), transparent 60%),
    radial-gradient(700px 500px at -10% 20%, rgba(224,111,146,.12), transparent 60%),var(--bg);
  padding-left:env(safe-area-inset-left);padding-right:env(safe-area-inset-right)}
button{font:inherit;cursor:pointer;color:inherit}
input,textarea{font:inherit;color:inherit}
.hidden{display:none !important}
.wrap{max-width:1100px;margin-inline:auto;padding:0 20px}

.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;
  padding:11px 20px;border-radius:12px;border:1px solid transparent;
  font-size:14.5px;font-weight:600;white-space:nowrap;min-height:44px;
  transition:transform .06s,background .16s,border-color .16s,box-shadow .16s;text-decoration:none}
.btn:active{transform:translateY(1px)}
.btn-primary{background:var(--accent);color:#fff;box-shadow:0 12px 30px -12px rgba(124,92,255,.7)}
.btn-primary:hover{background:var(--accent-2)}
.btn-secondary{background:var(--panel-2);color:var(--fg);border-color:var(--border)}
.btn-secondary:hover{border-color:var(--accent);color:var(--accent)}
.btn-ghost{background:transparent;color:var(--muted)}
.btn-ghost:hover{color:var(--accent);background:var(--panel-2)}
.btn[disabled]{opacity:.5;cursor:not-allowed}
.btn-sm{padding:8px 14px;min-height:36px;font-size:13.5px;border-radius:10px}

.input{width:100%;padding:12px 16px;border:1px solid var(--border);border-radius:12px;
  background:var(--panel-2);color:var(--fg);font-size:15px;transition:border-color .2s,background .2s}
.input:focus{outline:none;border-color:var(--accent);background:var(--panel-3)}
.input::placeholder{color:var(--muted)}

.login-view{min-height:100vh;display:grid;place-items:center;padding:24px}
.login-card{width:100%;max-width:420px;background:var(--panel);border:1px solid var(--border);
  border-radius:24px;box-shadow:var(--shadow);padding:clamp(28px,6vw,44px)}
.login-logo{width:72px;height:72px;margin:0 auto 20px;border-radius:20px;
  display:grid;place-items:center;background:var(--accent-soft);color:var(--accent)}
.login-logo svg{width:36px;height:36px}
.login-card h1{margin:0 0 6px;font-size:26px;text-align:center;letter-spacing:-.02em;font-weight:700}
.login-card .sub{color:var(--muted);font-size:14px;margin:0 0 26px;text-align:center}
.login-tabs{display:flex;gap:6px;background:var(--panel-2);padding:4px;border-radius:12px;margin-bottom:18px}
.login-tabs button{flex:1;border:0;background:transparent;color:var(--muted);padding:9px;
  border-radius:9px;font-weight:600;font-size:14px;transition:all .2s}
.login-tabs button.on{background:var(--accent);color:#fff}
.field{margin-bottom:14px}
.field label{display:block;font-size:13px;font-weight:600;color:var(--muted);margin-bottom:6px}
.msg{min-height:20px;font-size:13px;color:var(--red);margin:4px 0 14px;text-align:center}
.login-card .btn{width:100%}

.topnav{position:sticky;top:0;z-index:40;
  background:rgba(15,17,23,.85);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
  border-bottom:1px solid var(--border);padding-top:env(safe-area-inset-top)}
.topnav-inner{display:flex;align-items:center;justify-content:space-between;padding:14px 0;gap:14px}
.brand{display:flex;align-items:center;gap:10px;font-size:17px;font-weight:700}
.brand .mark{width:34px;height:34px;border-radius:11px;display:grid;place-items:center;
  background:linear-gradient(135deg,var(--accent),var(--pink));color:#fff}
.brand .mark svg{width:19px;height:19px}
.nav-right{display:flex;align-items:center;gap:12px}
.user-chip{display:flex;align-items:center;gap:8px;background:var(--panel-2);
  border:1px solid var(--border);padding:6px 14px 6px 6px;border-radius:999px;font-size:13.5px;font-weight:600}
.user-chip .ava{width:28px;height:28px;border-radius:50%;display:grid;place-items:center;
  background:linear-gradient(135deg,var(--accent),var(--pink));color:#fff;font-weight:700;font-size:13px}

.section{padding:36px 0}
.section h2{font-size:24px;font-weight:700;margin:0 0 6px;letter-spacing:-.02em}
.section .sub{color:var(--muted);margin:0 0 26px;font-size:14.5px}
.game-grid{display:grid;gap:18px;grid-template-columns:repeat(auto-fill,minmax(280px,1fr))}
.game-card{position:relative;background:var(--panel);border:1px solid var(--border);
  border-radius:var(--radius-lg);padding:24px;cursor:pointer;overflow:hidden;
  transition:transform .35s cubic-bezier(.2,.7,.3,1),border-color .35s,box-shadow .35s}
.game-card::before{content:'';position:absolute;inset:0;border-radius:inherit;pointer-events:none;
  background:radial-gradient(400px 200px at 100% 0%, var(--accent-soft), transparent 60%);
  opacity:0;transition:opacity .35s}
.game-card:hover{transform:translateY(-4px);border-color:rgba(124,92,255,.5);
  box-shadow:0 30px 60px -30px rgba(124,92,255,.4)}
.game-card:hover::before{opacity:1}
.game-icon{width:56px;height:56px;border-radius:16px;display:grid;place-items:center;
  font-size:28px;margin-bottom:16px;position:relative;z-index:1}
.game-icon.purple{background:rgba(124,92,255,.15);color:var(--accent)}
.game-icon.green{background:rgba(95,210,143,.15);color:var(--green)}
.game-icon.pink{background:rgba(224,111,146,.15);color:var(--pink)}
.game-card h3{font-size:18px;margin:0 0 6px;position:relative;z-index:1}
.game-card p{color:var(--muted);font-size:13.5px;margin:0 0 14px;position:relative;z-index:1;min-height:40px}
.game-tags{display:flex;gap:6px;flex-wrap:wrap;position:relative;z-index:1}
.tag{font-size:11.5px;font-weight:600;padding:3px 9px;border-radius:6px;background:var(--panel-3);color:var(--muted)}
.tag.accent{background:var(--accent-soft);color:var(--accent)}

.lb-panel{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius-lg);padding:20px;margin-top:20px}
.lb-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;gap:12px;flex-wrap:wrap}
.lb-head h3{font-size:16px;margin:0;font-weight:700}
.lb-tabs{display:flex;gap:6px;background:var(--panel-2);padding:3px;border-radius:10px}
.lb-tabs button{border:0;background:transparent;color:var(--muted);padding:6px 12px;
  border-radius:7px;font-size:12.5px;font-weight:600;transition:all .2s}
.lb-tabs button.on{background:var(--panel-3);color:var(--accent)}
.lb-list{display:flex;flex-direction:column;gap:2px}
.lb-row{display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:10px;font-size:14px;transition:background .2s}
.lb-row:hover{background:var(--panel-2)}
.lb-row.me{background:var(--accent-soft);color:var(--accent)}
.lb-rank{width:26px;height:26px;border-radius:8px;display:grid;place-items:center;
  font-weight:700;font-size:12.5px;flex:none;background:var(--panel-3);color:var(--muted)}
.lb-rank.r1{background:linear-gradient(135deg,#f5c96b,#e6a637);color:#3a2a00}
.lb-rank.r2{background:linear-gradient(135deg,#c8d2e0,#95a2b6);color:#2a3342}
.lb-rank.r3{background:linear-gradient(135deg,#e0a574,#c47f4b);color:#3a1f00}
.lb-name{flex:1;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lb-score{font-weight:700;font-variant-numeric:tabular-nums}
.lb-empty{color:var(--muted);text-align:center;padding:24px;font-size:14px}

.game-view{padding:24px 0 60px}
.game-head{display:flex;align-items:center;gap:14px;margin-bottom:20px;flex-wrap:wrap}
.game-head h1{font-size:22px;margin:0;font-weight:700;letter-spacing:-.02em}
.game-head .spacer{flex:1}
.back-btn{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;
  background:var(--panel-2);border:1px solid var(--border);color:var(--muted);transition:all .2s}
.back-btn:hover{border-color:var(--accent);color:var(--accent)}
.back-btn svg{width:18px;height:18px}

.jump-stage{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius-lg);
  padding:18px;box-shadow:var(--shadow)}
.jump-hud{display:flex;align-items:center;gap:16px;margin-bottom:14px;flex-wrap:wrap}
.hud-item{background:var(--panel-2);border:1px solid var(--border);border-radius:10px;
  padding:8px 14px;font-size:13px;font-weight:600}
.hud-item .val{color:var(--accent);font-size:17px;font-weight:700;margin-left:6px;font-variant-numeric:tabular-nums}
.jump-canvas{width:100%;height:auto;display:block;border-radius:12px;
  background:linear-gradient(180deg,#1a1d2b 0%,#131625 100%);touch-action:none;cursor:pointer}
.jump-tip{text-align:center;color:var(--muted);font-size:13px;margin-top:12px}

.room-panel{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius-lg);
  padding:22px;box-shadow:var(--shadow)}
.room-id{display:inline-flex;align-items:center;gap:8px;background:var(--accent-soft);color:var(--accent);
  padding:8px 16px;border-radius:10px;font-weight:700;letter-spacing:2px;
  font-family:ui-monospace,monospace;font-size:15px}
.room-players{margin:18px 0;display:flex;flex-wrap:wrap;gap:8px}
.player-chip{display:inline-flex;align-items:center;gap:8px;background:var(--panel-2);
  border:1px solid var(--border);padding:7px 14px 7px 7px;border-radius:999px;font-size:13.5px;font-weight:600}
.player-chip .ava{width:26px;height:26px;border-radius:50%;display:grid;place-items:center;
  background:linear-gradient(135deg,var(--accent),var(--pink));color:#fff;font-size:12px;font-weight:700}
.player-chip.host{border-color:var(--accent)}
.room-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:8px}
.room-wait{text-align:center;color:var(--muted);font-size:14px;padding:30px 20px}
.room-wait .dots::after{content:'';display:inline-block;width:1em;text-align:left;
  animation:dots 1.4s steps(4,end) infinite}
@keyframes dots{0%,20%{content:''}40%{content:'.'}60%{content:'..'}80%,100%{content:'...'}}

.snake-wrap{display:grid;gap:18px;grid-template-columns:1fr 240px}
@media(max-width:800px){.snake-wrap{grid-template-columns:1fr}}
.snake-canvas-box{background:var(--panel);border:1px solid var(--border);
  border-radius:var(--radius-lg);padding:14px;box-shadow:var(--shadow)}
.snake-canvas{width:100%;height:auto;display:block;border-radius:10px;background:#0d0f18}
.snake-side{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius-lg);padding:16px}
.snake-side h4{font-size:13px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);margin:0 0 10px;font-weight:600}
.snake-scores{display:flex;flex-direction:column;gap:8px;margin-bottom:16px}
.snake-score-row{display:flex;align-items:center;gap:10px;font-size:13.5px}
.snake-score-row .dot{width:12px;height:12px;border-radius:3px;flex:none}
.snake-score-row .name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.snake-score-row .score{font-weight:700;font-variant-numeric:tabular-nums}
.snake-score-row.dead{opacity:.4}
.snake-ctrl{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;max-width:180px;margin:0 auto}
.snake-ctrl button{aspect-ratio:1;border:1px solid var(--border);background:var(--panel-2);
  border-radius:10px;display:grid;place-items:center;font-size:18px;transition:all .15s;
  user-select:none;-webkit-user-select:none}
.snake-ctrl button:hover{border-color:var(--accent);color:var(--accent)}
.snake-ctrl button:active{background:var(--accent);color:#fff}
.snake-ctrl .empty{background:transparent;border:0;pointer-events:none}

.draw-wrap{display:grid;gap:18px;grid-template-columns:1fr 300px}
@media(max-width:900px){.draw-wrap{grid-template-columns:1fr}}
.draw-main{background:var(--panel);border:1px solid var(--border);
  border-radius:var(--radius-lg);padding:14px;box-shadow:var(--shadow)}
.draw-info{display:flex;align-items:center;justify-content:space-between;gap:12px;
  flex-wrap:wrap;margin-bottom:12px}
.draw-word{display:inline-flex;align-items:center;gap:8px;font-size:14px;font-weight:600}
.draw-word .hint{font-family:ui-monospace,monospace;letter-spacing:4px;font-size:18px;
  font-weight:700;color:var(--accent);padding:4px 12px;background:var(--accent-soft);border-radius:8px}
.draw-timer{display:inline-flex;align-items:center;gap:6px;font-weight:700;
  font-size:16px;color:var(--pink);font-variant-numeric:tabular-nums}
.draw-timer svg{width:16px;height:16px}
.draw-canvas{width:100%;height:auto;display:block;border-radius:10px;background:#fff;
  touch-action:none;cursor:crosshair}
.draw-tools{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;align-items:center}
.color-btn{width:26px;height:26px;border-radius:50%;border:2px solid transparent;padding:0;transition:transform .15s}
.color-btn.on{border-color:var(--fg);transform:scale(1.15)}
.draw-side{background:var(--panel);border:1px solid var(--border);
  border-radius:var(--radius-lg);padding:16px;display:flex;flex-direction:column;min-height:400px}
.draw-side h4{font-size:13px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);margin:0 0 12px;font-weight:600}
.guess-list{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:6px;
  margin-bottom:12px;padding-right:4px;max-height:420px}
.guess-item{background:var(--panel-2);border-radius:9px;padding:8px 12px;font-size:13.5px;line-height:1.45}
.guess-item .who{font-weight:700;color:var(--accent);margin-right:6px}
.guess-item.correct{background:rgba(95,210,143,.14);color:var(--green)}
.guess-item.correct .who{color:var(--green)}
.guess-item.sys{background:transparent;color:var(--muted);text-align:center;font-size:12.5px;padding:4px}
.guess-form{display:flex;gap:8px}
.guess-form input{flex:1;min-width:0}

.overlay{position:fixed;inset:0;z-index:100;display:none;place-items:center;padding:24px;
  background:rgba(8,10,16,.82);backdrop-filter:blur(8px)}
.overlay.on{display:grid}
.overlay-card{background:var(--panel);border:1px solid var(--border);border-radius:24px;
  padding:32px;max-width:400px;width:100%;text-align:center;
  box-shadow:0 40px 80px -30px rgba(0,0,0,.8)}
.overlay-card h2{font-size:24px;margin:0 0 8px;font-weight:700}
.overlay-card p{color:var(--muted);margin:0 0 22px;font-size:14.5px}
.overlay-card .big-score{font-size:56px;font-weight:800;letter-spacing:-.03em;
  color:var(--accent);line-height:1;margin:12px 0;font-variant-numeric:tabular-nums}
.overlay-card .row{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}

.toast{position:fixed;left:50%;bottom:calc(24px + env(safe-area-inset-bottom));
  transform:translateX(-50%) translateY(20px);background:var(--panel-3);color:var(--fg);
  border:1px solid var(--border);padding:11px 22px;border-radius:12px;font-size:14px;
  font-weight:600;opacity:0;pointer-events:none;transition:opacity .25s,transform .25s;
  z-index:200;max-width:90vw;text-align:center;box-shadow:var(--shadow)}
.toast.on{opacity:1;transform:translateX(-50%) translateY(0)}

@media(max-width:600px){
  .brand span.t{display:none}
  .user-chip .name{display:none}
  .section{padding:26px 0}
  .game-grid{grid-template-columns:1fr}
}
</style>
</head>
<body>

<div class="login-view" id="loginView">
  <div class="login-card">
    <div class="login-logo">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <rect x="2" y="6" width="20" height="12" rx="2"/>
        <path d="M6 12h4M8 10v4M15 12h.01M18 10h.01"/>
      </svg>
    </div>
    <h1 id="authTitle">欢迎回来</h1>
    <p class="sub" id="authSub">登录你的账号，开始游戏之旅</p>
    <div class="login-tabs">
      <button type="button" class="on" data-tab="login">登录</button>
      <button type="button" data-tab="register">注册</button>
    </div>
    <form id="authForm" autocomplete="on">
      <div class="field">
        <label for="username">用户名</label>
        <input class="input" type="text" id="username" placeholder="2-16 位中文、字母或数字" autocomplete="username" required>
      </div>
      <div class="field">
        <label for="password">密码</label>
        <input class="input" type="password" id="password" placeholder="至少 4 位" autocomplete="current-password" required>
      </div>
      <p class="msg" id="authMsg"></p>
      <button class="btn btn-primary" type="submit" id="authBtn">登录</button>
    </form>
  </div>
</div>

<div id="appView" class="hidden">
  <header class="topnav">
    <div class="wrap topnav-inner">
      <div class="brand">
        <span class="mark">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
            <rect x="2" y="6" width="20" height="12" rx="2"/>
            <path d="M6 12h4M8 10v4M15 12h.01M18 10h.01"/>
          </svg>
        </span>
        <span class="t">欢乐小游戏</span>
      </div>
      <div class="nav-right">
        <div class="user-chip">
          <span class="ava" id="userAva">?</span>
          <span class="name" id="userName">...</span>
        </div>
        <button class="btn btn-ghost btn-sm" id="logoutBtn" type="button">退出</button>
      </div>
    </div>
  </header>
  <main id="main"></main>
</div>

<div class="overlay" id="overlay">
  <div class="overlay-card" id="overlayCard"></div>
</div>
<div class="toast" id="toast"></div>

<script>
(function(){
  "use strict";
  var $ = function(id){ return document.getElementById(id); };
  var state = {
    username: null, view: 'lobby', room: null, es: null,
    lbGame: 'jump', jump: null, snake: null, draw: null
  };

  function toast(msg){
    var t = $('toast'); t.textContent = msg; t.classList.add('on');
    clearTimeout(t._t); t._t = setTimeout(function(){ t.classList.remove('on'); }, 2400);
  }
  function esc(s){
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }
  function api(method, path, body){
    return fetch(path, {
      method: method,
      headers: body ? {'Content-Type':'application/json'} : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin'
    }).then(function(r){
      return r.json().catch(function(){ return {}; }).then(function(j){
        if (!r.ok) throw Object.assign(new Error(j.error || '请求失败'), { status: r.status });
        return j;
      });
    });
  }
  function avatarChar(name){ return (name || '?').slice(0,1).toUpperCase(); }
  function showOverlay(html){
    $('overlayCard').innerHTML = html;
    $('overlay').classList.add('on');
  }
  function hideOverlay(){
    $('overlay').classList.remove('on');
  }
  $('overlay').addEventListener('click', function(e){
    if (e.target === $('overlay')) hideOverlay();
  });

  /* ---------- 登录注册 ---------- */
  var authMode = 'login';
  document.querySelectorAll('.login-tabs button').forEach(function(b){
    b.addEventListener('click', function(){
      authMode = b.getAttribute('data-tab');
      document.querySelectorAll('.login-tabs button').forEach(function(x){
        x.classList.toggle('on', x === b);
      });
      $('authTitle').textContent = authMode === 'login' ? '欢迎回来' : '创建账号';
      $('authSub').textContent = authMode === 'login' ? '登录你的账号，开始游戏之旅' : '注册一个专属账号，和好友一起玩';
      $('authBtn').textContent = authMode === 'login' ? '登录' : '注册并登录';
      $('authMsg').textContent = '';
    });
  });
  $('authForm').addEventListener('submit', function(e){
    e.preventDefault();
    var username = $('username').value.trim();
    var password = $('password').value;
    if (!username || !password) { $('authMsg').textContent = '请填写完整'; return; }
    $('authBtn').disabled = true;
    $('authMsg').textContent = authMode === 'login' ? '登录中…' : '注册中…';
    var url = authMode === 'login' ? '/api/login' : '/api/register';
    api('POST', url, { username: username, password: password })
      .then(function(r){
        state.username = r.username;
        $('password').value = '';
        $('authMsg').textContent = '';
        enterApp();
      })
      .catch(function(err){
        $('authMsg').textContent = err.message || '出错了';
      })
      .then(function(){ $('authBtn').disabled = false; });
  });
  $('logoutBtn').addEventListener('click', function(){
    if (state.es) { state.es.close(); state.es = null; }
    api('POST', '/api/logout').catch(function(){}).then(function(){ location.reload(); });
  });

  function enterApp(){
    $('loginView').classList.add('hidden');
    $('appView').classList.remove('hidden');
    $('userAva').textContent = avatarChar(state.username);
    $('userName').textContent = state.username;
    go('lobby');
  }

  /* ---------- 路由 ---------- */
  function go(view){
    if (state.jump && state.jump.destroy) state.jump.destroy();
    state.jump = null;
    if (state.es) { state.es.close(); state.es = null; }
    state.room = null;
    state.view = view;
    if (view === 'lobby') showLobby();
    else if (view === 'jump') showJump();
    else if (view === 'snake') showSnakeLobby();
    else if (view === 'draw') showDrawLobby();
  }

  /* ---------- 大厅 ---------- */
  function showLobby(){
    var main = $('main');
    main.innerHTML =
      '<div class="wrap section">' +
        '<h2>选择一个小游戏</h2>' +
        '<p class="sub">单人挑战或和好友开房间联机，一起玩才更开心</p>' +
        '<div class="game-grid">' +
          '<div class="game-card" data-game="jump">' +
            '<div class="game-icon purple">🎯</div>' +
            '<h3>跳一跳</h3>' +
            '<p>按住蓄力，松开跳跃，落到下一个方块上得一分。考验节奏感的小挑战。</p>' +
            '<div class="game-tags"><span class="tag accent">单人</span><span class="tag">排行榜</span></div>' +
          '</div>' +
          '<div class="game-card" data-game="snake">' +
            '<div class="game-icon green">🐍</div>' +
            '<h3>贪吃蛇对战</h3>' +
            '<p>最多 4 人同房间实时对战，吃到食物变长、得分，小心撞墙和撞蛇。</p>' +
            '<div class="game-tags"><span class="tag accent">联机</span><span class="tag">2-4 人</span></div>' +
          '</div>' +
          '<div class="game-card" data-game="draw">' +
            '<div class="game-icon pink">🎨</div>' +
            '<h3>你画我猜</h3>' +
            '<p>轮流当画手，把看到的词画出来让其他人猜。猜对越多，得分越高。</p>' +
            '<div class="game-tags"><span class="tag accent">联机</span><span class="tag">2+ 人</span></div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="wrap">' +
        '<div class="lb-panel">' +
          '<div class="lb-head">' +
            '<h3>🏆 排行榜</h3>' +
            '<div class="lb-tabs" id="lbTabs">' +
              '<button data-game="jump" class="on">跳一跳</button>' +
              '<button data-game="snake">贪吃蛇</button>' +
              '<button data-game="draw">你画我猜</button>' +
            '</div>' +
          '</div>' +
          '<div class="lb-list" id="lbList"><div class="lb-empty">加载中…</div></div>' +
        '</div>' +
      '</div>';

    main.querySelectorAll('.game-card').forEach(function(card){
      card.addEventListener('click', function(){
        go(card.getAttribute('data-game'));
      });
    });
    main.querySelectorAll('#lbTabs button').forEach(function(b){
      b.addEventListener('click', function(){
        main.querySelectorAll('#lbTabs button').forEach(function(x){
          x.classList.toggle('on', x === b);
        });
        state.lbGame = b.getAttribute('data-game');
        loadLeaderboard();
      });
    });
    state.lbGame = 'jump';
    loadLeaderboard();
  }

  function loadLeaderboard(){
    var list = $('lbList');
    if (!list) return;
    api('GET', '/api/leaderboard?game=' + encodeURIComponent(state.lbGame))
      .then(function(r){
        if (!r.list || !r.list.length){
          list.innerHTML = '<div class="lb-empty">还没有记录，快来抢占第一名 🥇</div>';
          return;
        }
        list.innerHTML = r.list.map(function(x, i){
          var cls = 'lb-rank' + (i < 3 ? ' r' + (i+1) : '');
          var me = x.username === state.username ? ' me' : '';
          return '<div class="lb-row'+me+'">' +
            '<span class="'+cls+'">'+(i+1)+'</span>' +
            '<span class="lb-name">'+esc(x.username)+'</span>' +
            '<span class="lb-score">'+x.score+'</span>' +
          '</div>';
        }).join('');
      })
      .catch(function(){ list.innerHTML = '<div class="lb-empty">加载失败</div>'; });
  }

  function gameHeader(title, extraHTML){
    return '<div class="wrap game-view">' +
      '<div class="game-head">' +
        '<button class="back-btn" id="backBtn" type="button" aria-label="返回">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>' +
        '</button>' +
        '<h1>' + title + '</h1>' +
        '<div class="spacer"></div>' +
        (extraHTML || '') +
      '</div>';
  }

  /* ===================== 跳一跳 ===================== */
  function showJump(){
    var main = $('main');
    main.innerHTML = gameHeader('🎯 跳一跳') +
      '<div class="jump-stage">' +
        '<div class="jump-hud">' +
          '<div class="hud-item">得分<span class="val" id="jumpScore">0</span></div>' +
          '<div class="hud-item">最高<span class="val" id="jumpBest">0</span></div>' +
          '<div style="flex:1"></div>' +
          '<button class="btn btn-secondary btn-sm" id="jumpRestart" type="button">重新开始</button>' +
        '</div>' +
        '<canvas class="jump-canvas" id="jumpCanvas" width="900" height="500"></canvas>' +
        '<p class="jump-tip">按住屏幕或空格键蓄力，松开跳跃 · 落到方块上得 1 分</p>' +
      '</div>' +
    '</div>';

    $('backBtn').addEventListener('click', function(){ go('lobby'); });

    var canvas = $('jumpCanvas');
    var ctx = canvas.getContext('2d');
    var W = canvas.width, H = canvas.height;

    var game = {
      blocks: [], player: null, camX: 0, score: 0,
      power: 0, charging: false, state: 'idle',
      destroyed: false
    };

    function reset(){
      var groundY = H - 100;
      game.blocks = [
        { x: 0, y: groundY, w: 120, h: 100 },
        { x: 300, y: groundY, w: 120, h: 100 }
      ];
      game.player = { x: 60, y: groundY - 34, w: 34, h: 34 };
      game.camX = 0;
      game.score = 0;
      game.state = 'idle';
      game.power = 0;
      game.charging = false;
      $('jumpScore').textContent = '0';
      draw();
    }

    function roundRect(c, x, y, w, h, r){
      c.beginPath();
      c.moveTo(x + r, y);
      c.arcTo(x + w, y, x + w, y + h, r);
      c.arcTo(x + w, y + h, x, y + h, r);
      c.arcTo(x, y + h, x, y, r);
      c.arcTo(x, y, x + w, y, r);
      c.closePath();
    }

    function draw(){
      ctx.clearRect(0, 0, W, H);
      var grd = ctx.createLinearGradient(0, 0, 0, H);
      grd.addColorStop(0, '#1a1d2b');
      grd.addColorStop(1, '#131625');
      ctx.fillStyle = grd;
      ctx.fillRect(0, 0, W, H);

      ctx.fillStyle = 'rgba(124,92,255,.08)';
      for (var i = 0; i < 6; i++){
        var xx = (i * 200 - game.camX * 0.3) % (W + 200);
        if (xx < -100) xx += W + 200;
        ctx.fillRect(xx, H - 220, 100, 220);
      }

      game.blocks.forEach(function(b){
        var bx = b.x - game.camX;
        if (bx + b.w < -20 || bx > W + 20) return;
        var g = ctx.createLinearGradient(bx, b.y, bx, b.y + b.h);
        g.addColorStop(0, '#2d3450');
        g.addColorStop(1, '#1d2338');
        ctx.fillStyle = g;
        roundRect(ctx, bx, b.y, b.w, b.h, 8);
        ctx.fill();
        ctx.strokeStyle = 'rgba(124,92,255,.35)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.fillStyle = 'rgba(124,92,255,.5)';
        ctx.fillRect(bx + 6, b.y + 3, b.w - 12, 2);
      });

      var px = game.player.x - game.camX;
      var py = game.player.y;
      var pg = ctx.createLinearGradient(px, py, px, py + game.player.h);
      pg.addColorStop(0, '#9d7dff');
      pg.addColorStop(1, '#7c5cff');
      ctx.fillStyle = pg;
      ctx.shadowColor = 'rgba(124,92,255,.7)';
      ctx.shadowBlur = 18;
      roundRect(ctx, px, py, game.player.w, game.player.h, 8);
      ctx.fill();
      ctx.shadowBlur = 0;

      if (game.charging){
        var barW = 200;
        var bx2 = W / 2 - barW / 2;
        var by = 40;
        ctx.fillStyle = 'rgba(255,255,255,.1)';
        roundRect(ctx, bx2, by, barW, 10, 5);
        ctx.fill();
        var pct = Math.min(1, game.power);
        var grad2 = ctx.createLinearGradient(bx2, 0, bx2 + barW, 0);
        grad2.addColorStop(0, '#7c5cff');
        grad2.addColorStop(1, '#e06f92');
        ctx.fillStyle = grad2;
        roundRect(ctx, bx2, by, barW * pct, 10, 5);
        ctx.fill();
      }
    }

    var chargeRAF = null;
    function chargeLoop(){
      if (game.destroyed) return;
      if (game.charging){
        game.power = Math.min(1, game.power + 0.018);
        draw();
        chargeRAF = requestAnimationFrame(chargeLoop);
      }
    }

    function startCharge(){
      if (game.state !== 'idle') return;
      game.state = 'charging';
      game.charging = true;
      game.power = 0;
      cancelAnimationFrame(chargeRAF);
      chargeLoop();
    }

    function releaseCharge(){
      if (game.state !== 'charging') return;
      game.state = 'jumping';
      game.charging = false;
      cancelAnimationFrame(chargeRAF);

      var distance = 80 + game.power * 360;
      var startX = game.player.x;
      var startY = game.player.y;
      var newX = startX + distance;
      var landBlock = game.blocks.find(function(b){
        return newX >= b.x && newX <= b.x + b.w - game.player.w;
      });
      var duration = 320;
      var t0 = performance.now();
      var arcH = 90 + game.power * 60;

      function step(now){
        if (game.destroyed) return;
        var t = Math.min(1, (now - t0) / duration);
        game.player.x = startX + (newX - startX) * t;
        game.player.y = startY - Math.sin(Math.PI * t) * arcH;
        draw();
        if (t < 1){
          requestAnimationFrame(step);
        } else {
          if (landBlock){
            game.score++;
            $('jumpScore').textContent = game.score;
            var last = game.blocks[game.blocks.length - 1];
            var nextX = last.x + last.w + 90 + Math.random() * 120;
            var nextW = 80 + Math.random() * 70;
            game.blocks.push({ x: nextX, y: H - 100, w: nextW, h: 100 });
            if (game.blocks.length > 5) game.blocks.shift();
            game.player.y = H - 100 - game.player.h;
            game.player.x = landBlock.x + landBlock.w / 2 - game.player.w / 2;
            game.state = 'idle';
            var targetCam = game.player.x - W * 0.35;
            animateCam(targetCam);
          } else {
            game.state = 'falling';
            var fallStart = game.player.y;
            var fallT = performance.now();
            var fallStep = function(now2){
              if (game.destroyed) return;
              var ft = Math.min(1, (now2 - fallT) / 500);
              game.player.y = fallStart + ft * 300;
              game.player.x += 1.5;
              draw();
              if (ft < 1){
                requestAnimationFrame(fallStep);
              } else {
                gameOver();
              }
            };
            requestAnimationFrame(fallStep);
          }
        }
      }
      requestAnimationFrame(step);
    }

    function animateCam(targetCam){
      var start = game.camX;
      var t0 = performance.now();
      function step(now){
        if (game.destroyed) return;
        var t = Math.min(1, (now - t0) / 300);
        game.camX = start + (targetCam - start) * (1 - Math.pow(1 - t, 3));
        draw();
        if (t < 1) requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    }

    function gameOver(){
      if (game.destroyed) return;
      api('POST', '/api/score', { game: 'jump', score: game.score }).catch(function(){});
      var best = parseInt($('jumpBest').textContent, 10) || 0;
      if (game.score > best) $('jumpBest').textContent = game.score;

      showOverlay(
        '<h2>游戏结束</h2>' +
        '<p>再来一次，挑战更高分！</p>' +
        '<div class="big-score">' + game.score + '</div>' +
        '<div class="row">' +
          '<button class="btn btn-primary" id="ovRestart">再来一次</button>' +
          '<button class="btn btn-secondary" id="ovLobby">回大厅</button>' +
        '</div>'
      );
      setTimeout(function(){
        var b = document.getElementById('ovRestart');
        if (b) b.addEventListener('click', function(){ hideOverlay(); reset(); });
        var l = document.getElementById('ovLobby');
        if (l) l.addEventListener('click', function(){ hideOverlay(); go('lobby'); });
      }, 0);
    }

    var onPointerDown = function(e){
      if (e.type === 'mousedown' && e.button !== 0) return;
      e.preventDefault();
      startCharge();
    };
    var onPointerUp = function(e){
      if (game.state === 'charging'){
        e.preventDefault();
        releaseCharge();
      }
    };
    canvas.addEventListener('mousedown', onPointerDown);
    canvas.addEventListener('touchstart', onPointerDown, { passive: false });
    window.addEventListener('mouseup', onPointerUp);
    window.addEventListener('touchend', onPointerUp);

    var onKey = function(e){
      if (e.code === 'Space'){
        e.preventDefault();
        if (!e.repeat) startCharge();
      }
    };
    var onKeyUp = function(e){
      if (e.code === 'Space'){ e.preventDefault(); releaseCharge(); }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);

    $('jumpRestart').addEventListener('click', function(){ reset(); });

    reset();
    api('GET', '/api/leaderboard?game=jump').then(function(r){
      if (r.list && r.list.length){
        var mine = r.list.find(function(x){ return x.username === state.username; });
        if (mine) $('jumpBest').textContent = mine.score;
      }
    }).catch(function(){});

    state.jump = {
      destroy: function(){
        game.destroyed = true;
        cancelAnimationFrame(chargeRAF);
        window.removeEventListener('mouseup', onPointerUp);
        window.removeEventListener('touchend', onPointerUp);
        window.removeEventListener('keydown', onKey);
        window.removeEventListener('keyup', onKeyUp);
      }
    };
  }

  /* ===================== 贪吃蛇 ===================== */
  function showSnakeLobby(){
    var main = $('main');
    main.innerHTML = gameHeader('🐍 贪吃蛇对战') +
      '<div class="room-panel">' +
        '<div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;justify-content:space-between">' +
          '<div>' +
            '<div style="font-size:13px;color:var(--muted);margin-bottom:6px;font-weight:600">创建房间，把房间号发给好友</div>' +
            '<button class="btn btn-primary" id="createRoomBtn" type="button">创建新房间</button>' +
          '</div>' +
          '<div style="text-align:right">' +
            '<div style="font-size:13px;color:var(--muted);margin-bottom:6px;font-weight:600">或输入房间号加入</div>' +
            '<div style="display:flex;gap:8px">' +
              '<input class="input" id="joinCode" placeholder="6 位房间号" maxlength="6" style="width:130px;text-transform:lowercase">' +
              '<button class="btn btn-secondary" id="joinRoomBtn" type="button">加入</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';

    $('backBtn').addEventListener('click', function(){ go('lobby'); });
    $('createRoomBtn').addEventListener('click', function(){
      $('createRoomBtn').disabled = true;
      api('POST', '/api/room/create', { game: 'snake' })
        .then(function(r){
          state.room = { id: r.roomId, game: r.game };
          enterSnakeRoom();
        })
        .catch(function(err){ toast(err.message); $('createRoomBtn').disabled = false; });
    });
    $('joinRoomBtn').addEventListener('click', function(){
      var code = ($('joinCode').value || '').trim().toLowerCase();
      if (!code) { toast('请输入房间号'); return; }
      api('POST', '/api/room/join', { roomId: code })
        .then(function(r){
          state.room = { id: r.roomId, game: r.game };
          enterSnakeRoom();
        })
        .catch(function(err){ toast(err.message); });
    });
    $('joinCode').addEventListener('keydown', function(e){
      if (e.key === 'Enter') $('joinRoomBtn').click();
    });
  }

  function enterSnakeRoom(){
    var main = $('main');
    main.innerHTML = gameHeader('🐍 贪吃蛇对战',
      '<span class="room-id" id="roomIdChip">----</span>' +
      '<button class="btn btn-secondary btn-sm" id="leaveRoomBtn" type="button">离开房间</button>'
    ) +
      '<div class="room-panel" id="snakePreGame">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:16px">' +
          '<div style="font-size:14px;font-weight:600">房间号：<span id="roomIdText" style="color:var(--accent);letter-spacing:2px;font-family:ui-monospace,monospace"></span></div>' +
          '<div style="font-size:13px;color:var(--muted)">最多 4 人 · 房主可开始游戏</div>' +
        '</div>' +
        '<div style="font-size:13px;color:var(--muted);font-weight:600;margin-bottom:8px">当前玩家</div>' +
        '<div class="room-players" id="snakePlayers"></div>' +
        '<div class="room-wait" id="snakeWait">等待房主开始游戏<span class="dots"></span></div>' +
        '<div class="room-actions">' +
          '<button class="btn btn-primary" id="snakeStartBtn" type="button" style="display:none">开始游戏</button>' +
        '</div>' +
      '</div>' +
      '<div class="snake-wrap hidden" id="snakeGame">' +
        '<div class="snake-canvas-box">' +
          '<canvas class="snake-canvas" id="snakeCanvas" width="840" height="600"></canvas>' +
        '</div>' +
        '<div class="snake-side">' +
          '<h4>玩家分数</h4>' +
          '<div class="snake-scores" id="snakeScores"></div>' +
          '<h4 style="margin-top:16px">方向控制</h4>' +
          '<div class="snake-ctrl">' +
            '<button class="empty"></button><button data-dir="up">↑</button><button class="empty"></button>' +
            '<button data-dir="left">←</button><button data-dir="down">↓</button><button data-dir="right">→</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';

    $('backBtn').addEventListener('click', function(){
      api('POST', '/api/room/leave', { roomId: state.room.id }).catch(function(){});
      go('lobby');
    });
    $('leaveRoomBtn').addEventListener('click', function(){
      api('POST', '/api/room/leave', { roomId: state.room.id }).catch(function(){});
      go('lobby');
    });

    $('snakeStartBtn').addEventListener('click', function(){
      api('POST', '/api/room/action', { roomId: state.room.id, action: 'start' })
        .catch(function(err){ toast(err.message); });
    });

    connectSnakeRoom();
  }

  function renderSnakePlayers(players, host){
    var el = $('snakePlayers');
    if (!el) return;
    el.innerHTML = players.map(function(p){
      var isHost = p === host ? ' host' : '';
      return '<span class="player-chip'+isHost+'"><span class="ava">'+esc(avatarChar(p))+'</span>'+esc(p)+(p===state.username?' (我)':'')+'</span>';
    }).join('');
    var startBtn = $('snakeStartBtn');
    if (startBtn){
      startBtn.style.display = (host === state.username && players.length >= 1) ? '' : 'none';
    }
  }

  function connectSnakeRoom(){
    if (state.es) state.es.close();
    var es = new EventSource('/api/room/events?room=' + encodeURIComponent(state.room.id));
    state.es = es;

    es.addEventListener('init', function(e){
      var d = JSON.parse(e.data);
      state.room.game = d.game;
      state.room.host = d.host;
      state.room.players = d.players;
      var chip = $('roomIdChip');
      if (chip) chip.textContent = '#' + d.roomId.toUpperCase();
      var rt = $('roomIdText');
      if (rt) rt.textContent = d.roomId.toUpperCase();
      renderSnakePlayers(d.players, d.host);
    });
    es.addEventListener('players', function(e){
      var d = JSON.parse(e.data);
      state.room.players = d.players;
      state.room.host = d.host;
      renderSnakePlayers(d.players, d.host);
    });
    es.addEventListener('snake-start', function(e){
      var d = JSON.parse(e.data);
      var pg = $('snakePreGame'), sg = $('snakeGame');
      if (pg) pg.classList.add('hidden');
      if (sg) sg.classList.remove('hidden');
      initSnakeControls();
      renderSnakeState(d.state);
    });
    es.addEventListener('snake-state', function(e){
      renderSnakeState(JSON.parse(e.data).state);
    });
    es.addEventListener('snake-end', function(e){
      var d = JSON.parse(e.data);
      renderSnakeState(d.state);
      var my = d.state.snakes[state.username];
      var myScore = my ? my.score : 0;
      showOverlay(
        '<h2>游戏结束</h2>' +
        '<p>你的得分</p>' +
        '<div class="big-score">' + myScore + '</div>' +
        '<div class="row">' +
          '<button class="btn btn-primary" id="ovAgain">再来一局</button>' +
          '<button class="btn btn-secondary" id="ovLobby2">回大厅</button>' +
        '</div>'
      );
      setTimeout(function(){
        var b = document.getElementById('ovAgain');
        if (b) b.addEventListener('click', function(){
          hideOverlay();
          var pg = $('snakePreGame'), sg = $('snakeGame');
          if (pg) pg.classList.remove('hidden');
          if (sg) sg.classList.add('hidden');
        });
        var l = document.getElementById('ovLobby2');
        if (l) l.addEventListener('click', function(){ hideOverlay(); go('lobby'); });
      }, 0);
    });
    es.onerror = function(){};
  }

  var snakeControlsInited = false;
  function initSnakeControls(){
    if (snakeControlsInited) return;
    snakeControlsInited = true;
    document.querySelectorAll('.snake-ctrl button[data-dir]').forEach(function(b){
      b.addEventListener('click', function(){
        sendSnakeDir(b.getAttribute('data-dir'));
      });
    });
    document.addEventListener('keydown', function(e){
      if (!state.room || state.room.game !== 'snake') return;
      var map = { ArrowUp:'up', ArrowDown:'down', ArrowLeft:'left', ArrowRight:'right',
                  w:'up', s:'down', a:'left', d:'right', W:'up', S:'down', A:'left', D:'right' };
      if (map[e.key]) { e.preventDefault(); sendSnakeDir(map[e.key]); }
    });
    var canvas = $('snakeCanvas');
    if (canvas){
      var tx = 0, ty = 0;
      canvas.addEventListener('touchstart', function(e){
        var t = e.touches[0]; tx = t.clientX; ty = t.clientY;
      }, { passive: true });
      canvas.addEventListener('touchmove', function(e){ e.preventDefault(); }, { passive: false });
      canvas.addEventListener('touchend', function(e){
        var t = e.changedTouches[0];
        var dx = t.clientX - tx, dy = t.clientY - ty;
        if (Math.abs(dx) < 20 && Math.abs(dy) < 20) return;
        if (Math.abs(dx) > Math.abs(dy)) sendSnakeDir(dx > 0 ? 'right' : 'left');
        else sendSnakeDir(dy > 0 ? 'down' : 'up');
      });
    }
  }

  var lastSnakeDir = '';
  function sendSnakeDir(dir){
    if (!state.room || state.room.game !== 'snake') return;
    if (dir === lastSnakeDir) return;
    lastSnakeDir = dir;
    api('POST', '/api/room/action', {
      roomId: state.room.id, action: 'dir', dir: dir
    }).catch(function(){});
  }

  function renderSnakeState(s){
    if (!s) return;
    var canvas = $('snakeCanvas');
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    var W = canvas.width, H = canvas.height;
    var cellW = W / s.w;
    var cellH = H / s.h;

    ctx.fillStyle = '#0d0f18';
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = 'rgba(124,92,255,.06)';
    ctx.lineWidth = 1;
    for (var i = 1; i < s.w; i++){
      ctx.beginPath(); ctx.moveTo(i * cellW, 0); ctx.lineTo(i * cellW, H); ctx.stroke();
    }
    for (var j = 1; j < s.h; j++){
      ctx.beginPath(); ctx.moveTo(0, j * cellH); ctx.lineTo(W, j * cellH); ctx.stroke();
    }

    s.food.forEach(function(f){
      var fx = f.x * cellW + cellW / 2;
      var fy = f.y * cellH + cellH / 2;
      var r = Math.min(cellW, cellH) * 0.32;
      ctx.fillStyle = '#f5c96b';
      ctx.beginPath();
      ctx.arc(fx, fy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowColor = '#f5c96b';
      ctx.shadowBlur = 15;
      ctx.fill();
      ctx.shadowBlur = 0;
    });

    var scores = [];
    for (var u in s.snakes){
      var sn = s.snakes[u];
      scores.push({ name: sn.name, color: sn.color, score: sn.score, alive: sn.alive });
      sn.body.forEach(function(b, i){
        var x = b.x * cellW;
        var y = b.y * cellH;
        var alpha = sn.alive ? (1 - i / (sn.body.length + 5) * 0.7) : 0.25;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = sn.color;
        roundRectS(ctx, x + 1, y + 1, cellW - 2, cellH - 2, Math.min(cellW, cellH) * 0.3);
        ctx.fill();
        if (i === 0 && sn.alive){
          ctx.shadowColor = sn.color;
          ctx.shadowBlur = 14;
          ctx.fill();
          ctx.shadowBlur = 0;
          ctx.globalAlpha = 1;
          ctx.fillStyle = '#fff';
          var ex = x + cellW / 2, ey = y + cellH / 2;
          var er = Math.min(cellW, cellH) * 0.1;
          ctx.beginPath(); ctx.arc(ex - cellW * 0.15, ey, er, 0, Math.PI * 2); ctx.fill();
          ctx.beginPath(); ctx.arc(ex + cellW * 0.15, ey, er, 0, Math.PI * 2); ctx.fill();
        }
      });
    }
    ctx.globalAlpha = 1;

    var sl = $('snakeScores');
    if (sl){
      scores.sort(function(a, b){ return b.score - a.score; });
      sl.innerHTML = scores.map(function(x){
        return '<div class="snake-score-row' + (x.alive ? '' : ' dead') + '">' +
          '<span class="dot" style="background:'+x.color+'"></span>' +
          '<span class="name">'+esc(x.name)+(x.name===state.username?' (我)':'')+'</span>' +
          '<span class="score">'+x.score+'</span>' +
        '</div>';
      }).join('');
    }
  }

  function roundRectS(ctx, x, y, w, h, r){
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* ===================== 你画我猜 ===================== */
  function showDrawLobby(){
    var main = $('main');
    main.innerHTML = gameHeader('🎨 你画我猜') +
      '<div class="room-panel">' +
        '<div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;justify-content:space-between">' +
          '<div>' +
            '<div style="font-size:13px;color:var(--muted);margin-bottom:6px;font-weight:600">创建房间，把房间号发给好友</div>' +
            '<button class="btn btn-primary" id="createDrawBtn" type="button">创建新房间</button>' +
          '</div>' +
          '<div style="text-align:right">' +
            '<div style="font-size:13px;color:var(--muted);margin-bottom:6px;font-weight:600">或输入房间号加入</div>' +
            '<div style="display:flex;gap:8px">' +
              '<input class="input" id="drawJoinCode" placeholder="6 位房间号" maxlength="6" style="width:130px;text-transform:lowercase">' +
              '<button class="btn btn-secondary" id="joinDrawBtn" type="button">加入</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';

    $('backBtn').addEventListener('click', function(){ go('lobby'); });
    $('createDrawBtn').addEventListener('click', function(){
      $('createDrawBtn').disabled = true;
      api('POST', '/api/room/create', { game: 'draw' })
        .then(function(r){
          state.room = { id: r.roomId, game: r.game };
          enterDrawRoom();
        })
        .catch(function(err){ toast(err.message); $('createDrawBtn').disabled = false; });
    });
    $('joinDrawBtn').addEventListener('click', function(){
      var code = ($('drawJoinCode').value || '').trim().toLowerCase();
      if (!code) { toast('请输入房间号'); return; }
      api('POST', '/api/room/join', { roomId: code })
        .then(function(r){
          state.room = { id: r.roomId, game: r.game };
          enterDrawRoom();
        })
        .catch(function(err){ toast(err.message); });
    });
    $('drawJoinCode').addEventListener('keydown', function(e){
      if (e.key === 'Enter') $('joinDrawBtn').click();
    });
  }

  function enterDrawRoom(){
    var main = $('main');
    main.innerHTML = gameHeader('🎨 你画我猜',
      '<span class="room-id" id="roomIdChip">----</span>' +
      '<button class="btn btn-secondary btn-sm" id="leaveDrawBtn" type="button">离开房间</button>'
    ) +
      '<div class="room-panel" id="drawPreGame">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:16px">' +
          '<div style="font-size:14px;font-weight:600">房间号：<span id="roomIdText" style="color:var(--accent);letter-spacing:2px;font-family:ui-monospace,monospace"></span></div>' +
          '<div style="font-size:13px;color:var(--muted)">至少 2 人 · 房主可开始游戏</div>' +
        '</div>' +
        '<div style="font-size:13px;color:var(--muted);font-weight:600;margin-bottom:8px">当前玩家</div>' +
        '<div class="room-players" id="drawPlayers"></div>' +
        '<div class="room-wait" id="drawWait">等待房主开始游戏<span class="dots"></span></div>' +
        '<div class="room-actions">' +
          '<button class="btn btn-primary" id="drawStartBtn" type="button" style="display:none">开始游戏</button>' +
        '</div>' +
      '</div>' +
      '<div class="draw-wrap hidden" id="drawGame">' +
        '<div class="draw-main">' +
          '<div class="draw-info">' +
            '<div class="draw-word">词语提示：<span class="hint" id="drawHint">_ _ _</span></div>' +
            '<div class="draw-timer">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>' +
              '<span id="drawTimer">60</span>s' +
            '</div>' +
          '</div>' +
          '<canvas class="draw-canvas" id="drawCanvas" width="800" height="500"></canvas>' +
          '<div class="draw-tools" id="drawTools" style="display:none">' +
            '<button class="color-btn on" data-color="#1a1a1a" style="background:#1a1a1a"></button>' +
            '<button class="color-btn" data-color="#e06f92" style="background:#e06f92"></button>' +
            '<button class="color-btn" data-color="#7c5cff" style="background:#7c5cff"></button>' +
            '<button class="color-btn" data-color="#5fd28f" style="background:#5fd28f"></button>' +
            '<button class="color-btn" data-color="#f5c96b" style="background:#f5c96b"></button>' +
            '<button class="color-btn" data-color="#3b82f6" style="background:#3b82f6"></button>' +
            '<span style="flex:1"></span>' +
            '<button class="btn btn-secondary btn-sm" id="drawClear" type="button">清空</button>' +
          '</div>' +
        '</div>' +
        '<div class="draw-side">' +
          '<h4>聊天 / 猜词</h4>' +
          '<div class="guess-list" id="guessList"></div>' +
          '<form class="guess-form" id="guessForm" autocomplete="off">' +
            '<input class="input" id="guessInput" placeholder="输入你的猜测…" maxlength="20">' +
            '<button class="btn btn-primary btn-sm" type="submit">发送</button>' +
          '</form>' +
        '</div>' +
      '</div>' +
    '</div>';

    $('backBtn').addEventListener('click', function(){
      api('POST', '/api/room/leave', { roomId: state.room.id }).catch(function(){});
      go('lobby');
    });
    $('leaveDrawBtn').addEventListener('click', function(){
      api('POST', '/api/room/leave', { roomId: state.room.id }).catch(function(){});
      go('lobby');
    });
    $('drawStartBtn').addEventListener('click', function(){
      api('POST', '/api/room/action', { roomId: state.room.id, action: 'start' })
        .catch(function(err){ toast(err.message); });
    });

    connectDrawRoom();
  }

  function renderDrawPlayers(players, host){
    var el = $('drawPlayers');
    if (!el) return;
    el.innerHTML = players.map(function(p){
      var isHost = p === host ? ' host' : '';
      return '<span class="player-chip'+isHost+'"><span class="ava">'+esc(avatarChar(p))+'</span>'+esc(p)+(p===state.username?' (我)':'')+'</span>';
    }).join('');
    var startBtn = $('drawStartBtn');
    if (startBtn){
      startBtn.style.display = (host === state.username && players.length >= 2) ? '' : 'none';
    }
  }

  var drawState = null;

  function connectDrawRoom(){
    if (state.es) state.es.close();
    var es = new EventSource('/api/room/events?room=' + encodeURIComponent(state.room.id));
    state.es = es;
    drawState = { strokes: [], color: '#1a1a1a', drawing: false, isDrawer: false };

    es.addEventListener('init', function(e){
      var d = JSON.parse(e.data);
      state.room.game = d.game;
      state.room.host = d.host;
      state.room.players = d.players;
      var chip = $('roomIdChip');
      if (chip) chip.textContent = '#' + d.roomId.toUpperCase();
      var rt = $('roomIdText');
      if (rt) rt.textContent = d.roomId.toUpperCase();
      renderDrawPlayers(d.players, d.host);
    });
    es.addEventListener('players', function(e){
      var d = JSON.parse(e.data);
      state.room.players = d.players;
      state.room.host = d.host;
      renderDrawPlayers(d.players, d.host);
    });
    es.addEventListener('draw-start', function(e){
      var d = JSON.parse(e.data);
      var pg = $('drawPreGame'), dg = $('drawGame');
      if (pg) pg.classList.add('hidden');
      if (dg) dg.classList.remove('hidden');
      if (!drawState.inited) {
        initDrawCanvas();
        drawState.inited = true;
      }
      drawState.strokes = [];
      drawState.isDrawer = d.drawer === state.username;
      clearDrawCanvas();
      redrawDrawStrokes();
      updateDrawHint(d.revealed);
      $('drawTimer').textContent = d.timeLeft;
      $('drawTools').style.display = drawState.isDrawer ? '' : 'none';
      addGuessItem({ sys: true, text: '第 ' + d.round + '/' + d.maxRounds + ' 轮开始，' + (drawState.isDrawer ? '你是画手' : '画手是 ' + d.drawer) });
    });
    es.addEventListener('draw-word', function(e){
      var d = JSON.parse(e.data);
      if (d.drawer === state.username){
        addGuessItem({ sys: true, text: '你要画的是：' + d.word });
      }
    });
    es.addEventListener('draw-tick', function(e){
      var d = JSON.parse(e.data);
      var t = $('drawTimer');
      if (t) t.textContent = d.timeLeft;
    });
    es.addEventListener('draw-stroke', function(e){
      var d = JSON.parse(e.data);
      drawState.strokes.push(d);
      drawStroke(d);
    });
    es.addEventListener('draw-clear', function(){
      drawState.strokes = [];
      clearDrawCanvas();
    });
    es.addEventListener('draw-guess', function(e){
      var d = JSON.parse(e.data);
      addGuessItem(d.guess);
      if (d.revealed) updateDrawHint(d.revealed);
    });
    es.addEventListener('draw-reveal', function(e){
      var d = JSON.parse(e.data);
      addGuessItem({ sys: true, text: '本轮答案：' + d.word });
    });
    es.addEventListener('draw-end', function(e){
      var d = JSON.parse(e.data);
      var myScore = d.scores[state.username] || 0;
      showOverlay(
        '<h2>游戏结束</h2>' +
        '<p>你的总分</p>' +
        '<div class="big-score">' + myScore + '</div>' +
        '<div class="row">' +
          '<button class="btn btn-primary" id="ovAgainD">再来一局</button>' +
          '<button class="btn btn-secondary" id="ovLobbyD">回大厅</button>' +
        '</div>'
      );
      setTimeout(function(){
        var b = document.getElementById('ovAgainD');
        if (b) b.addEventListener('click', function(){
          hideOverlay();
          var pg = $('drawPreGame'), dg = $('drawGame');
          if (pg) pg.classList.remove('hidden');
          if (dg) dg.classList.add('hidden');
          $('guessList').innerHTML = '';
        });
        var l = document.getElementById('ovLobbyD');
        if (l) l.addEventListener('click', function(){ hideOverlay(); go('lobby'); });
      }, 0);
    });
    es.addEventListener('draw-sync', function(e){
      var d = JSON.parse(e.data);
      var pg = $('drawPreGame'), dg = $('drawGame');
      if (pg) pg.classList.add('hidden');
      if (dg) dg.classList.remove('hidden');
      if (!drawState.inited) {
        initDrawCanvas();
        drawState.inited = true;
      }
      drawState.isDrawer = d.drawer === state.username;
      drawState.strokes = d.strokes || [];
      clearDrawCanvas();
      redrawDrawStrokes();
      updateDrawHint(d.revealed);
      $('drawTimer').textContent = d.timeLeft;
      $('drawTools').style.display = drawState.isDrawer ? '' : 'none';
    });
    es.onerror = function(){};
  }

  function updateDrawHint(revealed){
    var el = $('drawHint');
    if (el) el.textContent = revealed || '_';
  }

  function addGuessItem(g){
    var list = $('guessList');
    if (!list) return;
    var div = document.createElement('div');
    if (g.sys){
      div.className = 'guess-item sys';
      div.textContent = g.text;
    } else {
      div.className = 'guess-item' + (g.correct ? ' correct' : '');
      div.innerHTML = '<span class="who">' + esc(g.name) + '</span>' + esc(g.text) + (g.correct ? ' ✓' : '');
    }
    list.appendChild(div);
    list.scrollTop = list.scrollHeight;
  }

  function clearDrawCanvas(){
    var canvas = $('drawCanvas');
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  function redrawDrawStrokes(){
    drawState.strokes.forEach(function(s){ drawStroke(s); });
  }

  function drawStroke(s){
    var canvas = $('drawCanvas');
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    var W = canvas.width, H = canvas.height;
    ctx.strokeStyle = s.color || '#1a1a1a';
    ctx.lineWidth = (s.w || 3) * (W / 800);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(s.x1 * W, s.y1 * H);
    ctx.lineTo(s.x2 * W, s.y2 * H);
    ctx.stroke();
  }

  var drawCanvasInited = false;
  function initDrawCanvas(){
    if (drawCanvasInited) return;
    drawCanvasInited = true;
    var canvas = $('drawCanvas');
    if (!canvas) return;
    clearDrawCanvas();

    var last = null;

    function pos(e){
      var rect = canvas.getBoundingClientRect();
      var cx, cy;
      if (e.touches && e.touches[0]){
        cx = e.touches[0].clientX; cy = e.touches[0].clientY;
      } else {
        cx = e.clientX; cy = e.clientY;
      }
      return {
        x: (cx - rect.left) / rect.width,
        y: (cy - rect.top) / rect.height
      };
    }

    function send(x1, y1, x2, y2){
      api('POST', '/api/room/action', {
        roomId: state.room.id, action: 'stroke',
        x1: x1, y1: y1, x2: x2, y2: y2,
        color: drawState.color, w: 3
      }).catch(function(){});
    }

    function onDown(e){
      if (!drawState.isDrawer) return;
      e.preventDefault();
      drawState.drawing = true;
      last = pos(e);
    }
    function onMove(e){
      if (!drawState.drawing || !drawState.isDrawer) return;
      e.preventDefault();
      var p = pos(e);
      if (last){
        var st = {
          x1: last.x, y1: last.y, x2: p.x, y2: p.y,
          color: drawState.color, w: 3
        };
        drawStroke(st);
        send(st.x1, st.y1, st.x2, st.y2);
      }
      last = p;
    }
    function onUp(){
      drawState.drawing = false;
      last = null;
    }

    canvas.addEventListener('mousedown', onDown);
    canvas.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    canvas.addEventListener('touchstart', onDown, { passive: false });
    canvas.addEventListener('touchmove', onMove, { passive: false });
    canvas.addEventListener('touchend', onUp);

    document.querySelectorAll('.color-btn').forEach(function(b){
      b.addEventListener('click', function(){
        document.querySelectorAll('.color-btn').forEach(function(x){ x.classList.remove('on'); });
        b.classList.add('on');
        drawState.color = b.getAttribute('data-color');
      });
    });
    var clearBtn = $('drawClear');
    if (clearBtn){
      clearBtn.addEventListener('click', function(){
        if (!drawState.isDrawer) return;
        api('POST', '/api/room/action', {
          roomId: state.room.id, action: 'clear'
        }).catch(function(){});
      });
    }
    $('guessForm').addEventListener('submit', function(e){
      e.preventDefault();
      var input = $('guessInput');
      var text = input.value.trim();
      if (!text) return;
      input.value = '';
      api('POST', '/api/room/action', {
        roomId: state.room.id, action: 'guess', text: text
      }).catch(function(err){ toast(err.message); });
    });
  }

  /* ---------- 初始化 ---------- */
  api('GET', '/api/me')
    .then(function(r){
      if (r.authed){
        state.username = r.username;
        enterApp();
      }
    })
    .catch(function(){});
})();
</script>
</body>
</html>
`;

server.listen(PORT, () => {
  console.log('[games] 欢乐小游戏运行中 http://0.0.0.0:' + PORT);
});