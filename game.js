'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const url = require('url');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SECRET = process.env.SESSION_SECRET || 'games-v3-secret';

fs.mkdirSync(DATA_DIR, { recursive: true });

function loadDB() {
  try { const d = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); return { users: d.users || {}, scores: d.scores || {} }; }
  catch (e) { return { users: {}, scores: {} }; }
}
const db = loadDB();
let saveTimer = null;
function saveDB() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DB_FILE + '.tmp';
    try { fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, DB_FILE); } catch (e) {}
  }, 100);
}

function hashPw(pw, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
}
function verifyPw(pw, stored) {
  if (!stored) return false;
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(pw, salt, 32).toString('hex');
  try { return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(test, 'hex')); } catch (e) { return false; }
}
function sign(p) { return crypto.createHmac('sha256', SECRET).update(p).digest('hex'); }
function makeToken(u) { const e = Date.now() + 30 * 864e5; const p = u + '.' + e; return p + '.' + sign(p); }
function validToken(t) {
  if (!t) return null;
  const parts = t.split('.');
  if (parts.length !== 3) return null;
  const [u, e, s] = parts;
  if (!/^\d+$/.test(e) || Number(e) < Date.now()) return null;
  const s2 = sign(u + '.' + e);
  if (s.length !== s2.length) return null;
  try { if (!crypto.timingSafeEqual(Buffer.from(s), Buffer.from(s2))) return null; } catch (e) { return null; }
  return u;
}
function cookies(req) {
  const h = req.headers.cookie || '', o = {};
  h.split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return o;
}
function me(req) { return validToken(cookies(req)['gid']); }

function send(res, code, obj, h) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, h || {}));
  res.end(JSON.stringify(obj));
}
function body(req, limit) {
  return new Promise((resolve, reject) => {
    let n = 0; const c = [];
    req.on('data', x => { n += x.length; if (n > limit) { reject(new Error('too big')); req.destroy(); return; } c.push(x); });
    req.on('end', () => resolve(Buffer.concat(c)));
    req.on('error', reject);
  });
}
function addScore(g, u, s) {
  if (!db.scores[g]) db.scores[g] = {};
  if (s > (db.scores[g][u] || 0)) { db.scores[g][u] = s; saveDB(); }
}
function board(g, n) {
  const m = db.scores[g] || {};
  return Object.keys(m).map(u => ({ username: u, score: m[u] })).sort((a, b) => b.score - a.score).slice(0, n || 20);
}

const rooms = new Map();
function newId() { let i; do { i = crypto.randomBytes(3).toString('hex'); } while (rooms.has(i)); return i; }
function mkRoom(g, host) { const r = { id: newId(), game: g, host, players: new Map(), state: null, timer: null, clients: new Set(), createdAt: Date.now() }; rooms.set(r.id, r); return r; }
function bc(r, ev, d) {
  const p = 'event: ' + ev + '\ndata: ' + JSON.stringify(d) + '\n\n';
  for (const c of r.clients) { try { c.write(p); } catch (e) {} }
}
function join(r, u) { if (!r.players.has(u)) r.players.set(u, { name: u, alive: true, score: 0 }); }
function leave(r, u) { r.players.delete(u); if (!r.players.size) { if (r.timer) clearInterval(r.timer); rooms.delete(r.id); } }
setInterval(() => {
  const now = Date.now();
  for (const [id, r] of rooms) if (!r.players.size && now - r.createdAt > 30 * 6e4) { if (r.timer) clearInterval(r.timer); rooms.delete(id); }
}, 6e4);

const SW = 28, SH = 20;
const DIR = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
const SCOLORS = ['#e06f92', '#6f9ce0', '#7bb87b', '#e0a56f'];
function startSnake(r) {
  if (r.timer) return;
  const us = [...r.players.keys()].slice(0, 4);
  if (!us.length) return;
  const pos = [{ x: 3, y: 3, d: 'right' }, { x: SW - 4, y: SH - 4, d: 'left' }, { x: 3, y: SH - 4, d: 'right' }, { x: SW - 4, y: 3, d: 'left' }];
  const snakes = {};
  us.forEach((u, i) => {
    const p = pos[i];
    snakes[u] = { name: u, color: SCOLORS[i], body: [{ x: p.x, y: p.y }, { x: p.x, y: p.y }, { x: p.x, y: p.y }], dir: p.d, nextDir: p.d, alive: true, score: 0 };
  });
  r.state = { w: SW, h: SH, snakes, food: [], running: true };
  const rf = () => {
    for (let t = 0; t < 100; t++) {
      const x = Math.floor(Math.random() * SW), y = Math.floor(Math.random() * SH);
      let ok = true;
      for (const u in snakes) if (snakes[u].body.some(s => s.x === x && s.y === y)) { ok = false; break; }
      if (ok && !r.state.food.some(f => f.x === x && f.y === y)) return { x, y };
    }
    return { x: 0, y: 0 };
  };
  for (let i = 0; i < 3; i++) r.state.food.push(rf());
  r.timer = setInterval(() => {
    const s = r.state;
    if (!s || !s.running) return;
    const occ = new Set();
    for (const u in s.snakes) { const sn = s.snakes[u]; if (sn.alive) for (const b of sn.body) occ.add(b.x + ',' + b.y); }
    const nhs = {};
    for (const u in s.snakes) {
      const sn = s.snakes[u]; if (!sn.alive) continue;
      const c = DIR[sn.dir], n = DIR[sn.nextDir];
      if (!(c.x + n.x === 0 && c.y + n.y === 0)) sn.dir = sn.nextDir;
      const d = DIR[sn.dir], h = sn.body[0];
      const nh = { x: h.x + d.x, y: h.y + d.y };
      if (nh.x < 0 || nh.x >= SW || nh.y < 0 || nh.y >= SH) { sn.alive = false; continue; }
      nhs[u] = nh;
    }
    for (const u in nhs) {
      const nh = nhs[u];
      if (occ.has(nh.x + ',' + nh.y)) {
        const sn = s.snakes[u], tl = sn.body[sn.body.length - 1];
        if (!(tl.x === nh.x && tl.y === nh.y)) { sn.alive = false; delete nhs[u]; }
      }
    }
    for (const u in nhs) {
      const sn = s.snakes[u]; sn.body.unshift(nhs[u]);
      const fi = s.food.findIndex(f => f.x === nhs[u].x && f.y === nhs[u].y);
      if (fi >= 0) { s.food.splice(fi, 1); s.food.push(rf()); sn.score += 10; } else sn.body.pop();
    }
    if (Object.values(s.snakes).filter(x => x.alive).length <= 1) {
      s.running = false;
      if (r.timer) { clearInterval(r.timer); r.timer = null; }
      for (const u in s.snakes) if (s.snakes[u].score > 0) addScore('snake', u, s.snakes[u].score);
      bc(r, 'snake-end', { state: s }); return;
    }
    bc(r, 'snake-state', { state: s });
  }, 150);
  bc(r, 'snake-start', { state: r.state });
}

const GN = 15;
function startGomoku(r) {
  const us = [...r.players.keys()];
  if (us.length < 2) return;
  const ps = us.slice(0, 2);
  const b = [];
  for (let i = 0; i < GN; i++) b.push(new Array(GN).fill(0));
  r.state = { n: GN, board: b, players: ps, turn: 1, winner: 0, lastMove: null };
  bc(r, 'gomoku-start', { state: r.state, black: ps[0], white: ps[1] });
}
function gcheck(b, x, y, c) {
  const ds = [[1,0],[0,1],[1,1],[1,-1]];
  for (const [dx, dy] of ds) {
    let n = 1;
    for (let k = 1; k < 5; k++) { const nx = x + dx * k, ny = y + dy * k; if (nx < 0 || nx >= GN || ny < 0 || ny >= GN || b[nx][ny] !== c) break; n++; }
    for (let k = 1; k < 5; k++) { const nx = x - dx * k, ny = y - dy * k; if (nx < 0 || nx >= GN || ny < 0 || ny >= GN || b[nx][ny] !== c) break; n++; }
    if (n >= 5) return true;
  }
  return false;
}

/* ===== 你画我猜 ===== */
const DRAW_WORDS = ['太阳','月亮','苹果','香蕉','房子','大树','小狗','小猫','汽车','飞机','电脑','雨伞','眼镜','蛋糕','雪人','彩虹','星星','足球','铅笔','花朵','时钟','小鸟','冰淇淋','气球','爱心','西瓜','草莓','蘑菇','蝴蝶','锤子'];
function startDraw(r) {
  if (r.timer) return;
  const us = [...r.players.keys()];
  if (us.length < 2) return;
  r.state = {
    phase: 'drawing', round: 1, maxRounds: 3,
    drawerIdx: 0, drawer: us[0], word: '',
    strokes: [], guesses: [], scores: {}, timeLeft: 60,
    usernames: us, lastWinner: ''
  };
  us.forEach(u => r.state.scores[u] = 0);
  nextDrawRound(r);
}
function nextDrawRound(r) {
  const s = r.state;
  if (!s) return;
  s.drawer = s.usernames[s.drawerIdx % s.usernames.length];
  s.word = DRAW_WORDS[Math.floor(Math.random() * DRAW_WORDS.length)];
  s.strokes = [];
  s.guesses = [];
  s.timeLeft = 60;
  s.phase = 'drawing';
  bc(r, 'draw-start', {
    round: s.round, maxRounds: s.maxRounds,
    drawer: s.drawer, word: s.word,
    wordLength: s.word.length,
    scores: s.scores, timeLeft: s.timeLeft
  });
  if (r.timer) clearInterval(r.timer);
  r.timer = setInterval(() => {
    s.timeLeft--;
    if (s.timeLeft <= 0) {
      clearInterval(r.timer); r.timer = null;
      endDrawRound(r);
    } else {
      bc(r, 'draw-tick', { timeLeft: s.timeLeft });
    }
  }, 1000);
}
function endDrawRound(r) {
  const s = r.state;
  if (!s) return;
  s.phase = 'reveal';
  bc(r, 'draw-reveal', { word: s.word, scores: s.scores });
  setTimeout(() => {
    if (!rooms.has(r.id)) return;
    s.drawerIdx++;
    if (s.drawerIdx >= s.usernames.length * s.maxRounds) {
      s.phase = 'ended';
      for (const u in s.scores) if (s.scores[u] > 0) addScore('draw', u, s.scores[u]);
      bc(r, 'draw-end', { scores: s.scores });
    } else {
      s.round = Math.floor(s.drawerIdx / s.usernames.length) + 1;
      nextDrawRound(r);
    }
  }, 4000);
}

const server = http.createServer(async (req, res) => {
  const u = url.parse(req.url, true);
  const p = u.pathname, m = req.method;
  try {
    if (p === '/' || p === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(HTML);
    }
    if (m === 'POST' && p === '/api/register') {
      const b = JSON.parse((await body(req, 1e5)).toString() || '{}');
      const un = String(b.username || '').trim(), pw = String(b.password || '');
      if (!/^[\u4e00-\u9fa5a-zA-Z0-9_]{2,16}$/.test(un)) return send(res, 400, { error: '用户名需 2-16 位中文/字母/数字' });
      if (pw.length < 4) return send(res, 400, { error: '密码至少 4 位' });
      if (db.users[un]) return send(res, 400, { error: '用户名已被注册' });
      db.users[un] = { password: hashPw(pw), createdAt: Date.now() };
      saveDB();
      res.writeHead(200, { 'Set-Cookie': 'gid=' + makeToken(un) + '; HttpOnly; Path=/; Max-Age=' + 30 * 86400 + '; SameSite=Lax', 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, username: un }));
    }
    if (m === 'POST' && p === '/api/login') {
      const b = JSON.parse((await body(req, 1e5)).toString() || '{}');
      const un = String(b.username || '').trim(), pw = String(b.password || '');
      const uu = db.users[un];
      if (!uu || !verifyPw(pw, uu.password)) return send(res, 401, { error: '用户名或密码错误' });
      res.writeHead(200, { 'Set-Cookie': 'gid=' + makeToken(un) + '; HttpOnly; Path=/; Max-Age=' + 30 * 86400 + '; SameSite=Lax', 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, username: un }));
    }
    if (m === 'POST' && p === '/api/logout') {
      res.writeHead(200, { 'Set-Cookie': 'gid=; HttpOnly; Path=/; Max-Age=0', 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (p === '/api/me') { const u2 = me(req); return send(res, 200, { authed: !!u2, username: u2 }); }

    if (p.startsWith('/api/')) {
      const myName = me(req);
      if (!myName) return send(res, 401, { error: '请先登录' });

      if (m === 'GET' && p === '/api/leaderboard') return send(res, 200, { game: u.query.game || 'jump', list: board(u.query.game || 'jump', 20) });

      if (m === 'POST' && p === '/api/score') {
        const b = JSON.parse((await body(req, 1e4)).toString() || '{}');
        const g = String(b.game || ''), s = Math.max(0, Math.floor(Number(b.score) || 0));
        if (!['jump','snake','breakout'].includes(g)) return send(res, 400, { error: '不支持' });
        addScore(g, myName, s);
        return send(res, 200, { ok: true, list: board(g, 20) });
      }

      if (m === 'POST' && p === '/api/room/create') {
        const b = JSON.parse((await body(req, 1e4)).toString() || '{}');
        const g = String(b.game || '');
        if (!['snake','gomoku','draw'].includes(g)) return send(res, 400, { error: '不支持' });
        const r = mkRoom(g, myName); join(r, myName);
        return send(res, 200, { ok: true, roomId: r.id, game: g });
      }
      if (m === 'POST' && p === '/api/room/join') {
        const b = JSON.parse((await body(req, 1e4)).toString() || '{}');
        const rid = String(b.roomId || '').trim().toLowerCase();
        const r = rooms.get(rid);
        if (!r) return send(res, 404, { error: '房间不存在' });
        if (r.game === 'gomoku' && r.players.size >= 2) return send(res, 400, { error: '五子棋房间已满' });
        join(r, myName);
        bc(r, 'players', { players: [...r.players.keys()], host: r.host });
        return send(res, 200, { ok: true, roomId: r.id, game: r.game });
      }
      if (m === 'POST' && p === '/api/room/leave') {
        const b = JSON.parse((await body(req, 1e4)).toString() || '{}');
        const r = rooms.get(String(b.roomId || ''));
        if (r) { leave(r, myName); bc(r, 'players', { players: [...r.players.keys()], host: r.host }); }
        return send(res, 200, { ok: true });
      }

      if (m === 'GET' && p === '/api/room/events') {
        const r = rooms.get(u.query.room);
        if (!r) return send(res, 404, { error: '房间不存在' });
        join(r, myName);
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write('retry: 3000\n\n');
        r.clients.add(res);
        res.write('event: init\ndata: ' + JSON.stringify({ roomId: r.id, game: r.game, host: r.host, players: [...r.players.keys()], me: myName }) + '\n\n');
        if (r.state) {
          if (r.game === 'snake') res.write('event: snake-state\ndata: ' + JSON.stringify({ state: r.state }) + '\n\n');
          else if (r.game === 'gomoku') res.write('event: gomoku-sync\ndata: ' + JSON.stringify({ state: r.state }) + '\n\n');
          else if (r.game === 'draw') res.write('event: draw-sync\ndata: ' + JSON.stringify({
            round: r.state.round, maxRounds: r.state.maxRounds,
            drawer: r.state.drawer, word: r.state.word,
            wordLength: r.state.word.length,
            scores: r.state.scores, timeLeft: r.state.timeLeft,
            strokes: r.state.strokes, guesses: r.state.guesses,
            phase: r.state.phase
          }) + '\n\n');
        }
        bc(r, 'players', { players: [...r.players.keys()], host: r.host });
        const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 25000);
        req.on('close', () => {
          clearInterval(hb); r.clients.delete(res);
          setTimeout(() => {
            if (!rooms.has(r.id)) return;
            if (r.clients.size === 0) { leave(r, myName); bc(r, 'players', { players: [...r.players.keys()], host: r.host }); }
          }, 3000);
        });
        return;
      }

      if (m === 'POST' && p === '/api/room/action') {
        const b = JSON.parse((await body(req, 2e5)).toString() || '{}');
        const r = rooms.get(String(b.roomId || ''));
        if (!r) return send(res, 404, { error: '房间不存在' });
        const a = String(b.action || '');
        if (a === 'start') {
          if (r.host !== myName) return send(res, 403, { error: '只有房主可以开始' });
          if (r.game === 'snake') { if (!r.players.size) return send(res, 400, { error: '至少 1 人' }); startSnake(r); }
          else if (r.game === 'gomoku') { if (r.players.size < 2) return send(res, 400, { error: '需要 2 人' }); startGomoku(r); }
          else if (r.game === 'draw') { if (r.players.size < 2) return send(res, 400, { error: '至少 2 人' }); startDraw(r); }
          return send(res, 200, { ok: true });
        }
        if (r.game === 'snake' && a === 'dir' && r.state && r.state.running) {
          const sn = r.state.snakes[myName];
          if (sn && sn.alive) { const d = String(b.dir || ''); if (DIR[d]) sn.nextDir = d; }
          return send(res, 200, { ok: true });
        }
        if (r.game === 'gomoku') {
          const s = r.state;
          if (!s) return send(res, 400, { error: '未开始' });
          if (s.winner) return send(res, 400, { error: '已结束' });
          const myC = s.players[0] === myName ? 1 : (s.players[1] === myName ? 2 : 0);
          if (!myC) return send(res, 403, { error: '不是本局玩家' });
          if (s.turn !== myC) return send(res, 400, { error: '还没到你' });
          if (a === 'place') {
            const x = Math.floor(Number(b.x)), y = Math.floor(Number(b.y));
            if (x < 0 || x >= GN || y < 0 || y >= GN) return send(res, 400, { error: '位置不合法' });
            if (s.board[x][y] !== 0) return send(res, 400, { error: '已有棋子' });
            s.board[x][y] = myC;
            s.lastMove = { x, y, color: myC };
            if (gcheck(s.board, x, y, myC)) {
              s.winner = myC;
              addScore('gomoku', myName, 1);
              bc(r, 'gomoku-end', { state: s, winner: myName });
            } else {
              s.turn = myC === 1 ? 2 : 1;
              bc(r, 'gomoku-move', { state: s });
            }
            return send(res, 200, { ok: true });
          }
          if (a === 'restart') { if (!s.winner) return send(res, 400, { error: '未结束' }); startGomoku(r); return send(res, 200, { ok: true }); }
        }
        if (r.game === 'draw') {
          const s = r.state;
          if (!s) return send(res, 400, { error: '未开始' });
          if (a === 'stroke' && s.phase === 'drawing' && s.drawer === myName) {
            const st = {
              x1: Math.max(0, Math.min(1, Number(b.x1))),
              y1: Math.max(0, Math.min(1, Number(b.y1))),
              x2: Math.max(0, Math.min(1, Number(b.x2))),
              y2: Math.max(0, Math.min(1, Number(b.y2))),
              color: String(b.color || '#1a1a1a').slice(0, 16),
              w: Math.max(1, Math.min(20, Number(b.w) || 3))
            };
            s.strokes.push(st);
            if (s.strokes.length > 3000) s.strokes.splice(0, 500);
            bc(r, 'draw-stroke', st);
            return send(res, 200, { ok: true });
          }
          if (a === 'clear' && s.phase === 'drawing' && s.drawer === myName) {
            s.strokes = [];
            bc(r, 'draw-clear', {});
            return send(res, 200, { ok: true });
          }
          if (a === 'guess' && s.phase === 'drawing' && s.drawer !== myName) {
            const text = String(b.text || '').trim().slice(0, 20);
            if (!text) return send(res, 400, { error: '内容为空' });
            const alreadyCorrect = s.guesses.some(g => g.username === myName && g.correct);
            if (alreadyCorrect) return send(res, 400, { error: '你已经猜对啦' });
            const isCorrect = text === s.word;
            const guess = { username: myName, text, correct: isCorrect };
            s.guesses.push(guess);
            if (s.guesses.length > 200) s.guesses.splice(0, 50);
            if (isCorrect) {
              s.scores[myName] = (s.scores[myName] || 0) + 10;
              s.scores[s.drawer] = (s.scores[s.drawer] || 0) + 5;
              bc(r, 'draw-guess', { guess, scores: s.scores });
              const correctCount = s.guesses.filter(g => g.correct).length;
              if (correctCount >= s.usernames.length - 1) {
                if (r.timer) { clearInterval(r.timer); r.timer = null; }
                endDrawRound(r);
              }
            } else {
              bc(r, 'draw-guess', { guess });
            }
            return send(res, 200, { ok: true, correct: isCorrect });
          }
        }
        return send(res, 400, { error: '无效操作' });
      }

      return send(res, 404, { error: '接口不存在' });
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  } catch (e) {
    console.error('[err]', e);
    if (!res.headersSent) send(res, 500, { error: (e && e.message) || '服务器错误' });
  }
});

/* ===== HTML ===== */
const HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#0f1117"><title>欢乐小游戏</title>
<link href="https://cdn.jsdelivr.net/npm/@fontsource-variable/noto-sans-sc@5.2.10/index.css" rel="stylesheet">
<style>
:root{--bg:#0f1117;--panel:#171a24;--panel2:#1e2231;--panel3:#252a3d;--fg:#e8ecf5;--muted:#8b93a7;--border:#2a3046;--accent:#7c5cff;--accent2:#9d7dff;--pink:#e06f92;--green:#5fd28f;--red:#f56565;--shadow:0 20px 50px -25px rgba(0,0,0,.6);--font:"Noto Sans SC Variable","PingFang SC","Microsoft YaHei",system-ui,sans-serif}
*,*::before,*::after{box-sizing:border-box}body{margin:0;color:var(--fg);font-family:var(--font);font-size:15px;line-height:1.6;-webkit-font-smoothing:antialiased;min-height:100vh;background:radial-gradient(900px 500px at 85% -10%,rgba(124,92,255,.18),transparent 60%),radial-gradient(700px 500px at -10% 20%,rgba(224,111,146,.12),transparent 60%),var(--bg)}
button{font:inherit;cursor:pointer;color:inherit}input{font:inherit;color:inherit}.hidden{display:none!important}.wrap{max-width:1100px;margin:0 auto;padding:0 20px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:11px 20px;border-radius:12px;border:1px solid transparent;font-size:14.5px;font-weight:600;white-space:nowrap;min-height:44px;transition:transform .06s,background .16s,border-color .16s;text-decoration:none}
.btn:active{transform:translateY(1px)}.btn-primary{background:var(--accent);color:#fff;box-shadow:0 12px 30px -12px rgba(124,92,255,.7)}.btn-primary:hover{background:var(--accent2)}
.btn-secondary{background:var(--panel2);color:var(--fg);border-color:var(--border)}.btn-secondary:hover{border-color:var(--accent);color:var(--accent)}.btn-ghost{background:transparent;color:var(--muted)}.btn-ghost:hover{color:var(--accent);background:var(--panel2)}.btn[disabled]{opacity:.5;cursor:not-allowed}.btn-sm{padding:8px 14px;min-height:36px;font-size:13.5px;border-radius:10px}
.input{width:100%;padding:12px 16px;border:1px solid var(--border);border-radius:12px;background:var(--panel2);color:var(--fg);font-size:15px}.input:focus{outline:none;border-color:var(--accent);background:var(--panel3)}.input::placeholder{color:var(--muted)}
.login-view{min-height:100vh;display:grid;place-items:center;padding:24px}.login-card{width:100%;max-width:420px;background:var(--panel);border:1px solid var(--border);border-radius:24px;box-shadow:var(--shadow);padding:clamp(28px,6vw,44px)}
.login-logo{width:72px;height:72px;margin:0 auto 20px;border-radius:20px;display:grid;place-items:center;background:rgba(124,92,255,.15);color:var(--accent);font-size:36px}
.login-card h1{margin:0 0 6px;font-size:26px;text-align:center;font-weight:700}.login-card .sub{color:var(--muted);font-size:14px;margin:0 0 26px;text-align:center}
.login-tabs{display:flex;gap:6px;background:var(--panel2);padding:4px;border-radius:12px;margin-bottom:18px}.login-tabs button{flex:1;border:0;background:transparent;color:var(--muted);padding:9px;border-radius:9px;font-weight:600;font-size:14px;transition:all .2s}.login-tabs button.on{background:var(--accent);color:#fff}
.field{margin-bottom:14px}.field label{display:block;font-size:13px;font-weight:600;color:var(--muted);margin-bottom:6px}.msg{min-height:20px;font-size:13px;color:var(--red);margin:4px 0 14px;text-align:center}.login-card .btn{width:100%}
.topnav{position:sticky;top:0;z-index:40;background:rgba(15,17,23,.85);backdrop-filter:blur(14px);border-bottom:1px solid var(--border)}
.topnav-inner{display:flex;align-items:center;justify-content:space-between;padding:14px 0;gap:14px}.brand{display:flex;align-items:center;gap:10px;font-size:17px;font-weight:700}
.brand .mark{width:34px;height:34px;border-radius:11px;display:grid;place-items:center;background:linear-gradient(135deg,var(--accent),var(--pink));color:#fff;font-size:18px}
.nav-right{display:flex;align-items:center;gap:12px}.user-chip{display:flex;align-items:center;gap:8px;background:var(--panel2);border:1px solid var(--border);padding:6px 14px 6px 6px;border-radius:999px;font-size:13.5px;font-weight:600}
.user-chip .ava{width:28px;height:28px;border-radius:50%;display:grid;place-items:center;background:linear-gradient(135deg,var(--accent),var(--pink));color:#fff;font-weight:700;font-size:13px}
.section{padding:36px 0}.section h2{font-size:24px;font-weight:700;margin:0 0 6px}.section .sub{color:var(--muted);margin:0 0 26px;font-size:14.5px}
.game-grid{display:grid;gap:18px;grid-template-columns:repeat(auto-fill,minmax(260px,1fr))}.game-card{position:relative;background:var(--panel);border:1px solid var(--border);border-radius:20px;padding:24px;cursor:pointer;overflow:hidden;transition:transform .35s,border-color .35s,box-shadow .35s}
.game-card:hover{transform:translateY(-4px);border-color:rgba(124,92,255,.5);box-shadow:0 30px 60px -30px rgba(124,92,255,.4)}
.game-icon{width:56px;height:56px;border-radius:16px;display:grid;place-items:center;font-size:28px;margin-bottom:16px}
.game-card h3{font-size:18px;margin:0 0 6px}.game-card p{color:var(--muted);font-size:13.5px;margin:0 0 14px;min-height:40px}
.game-tags{display:flex;gap:6px;flex-wrap:wrap}.tag{font-size:11.5px;font-weight:600;padding:3px 9px;border-radius:6px;background:var(--panel3);color:var(--muted)}.tag.accent{background:rgba(124,92,255,.15);color:var(--accent)}
.lb-panel{background:var(--panel);border:1px solid var(--border);border-radius:20px;padding:20px;margin-top:20px}.lb-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;gap:12px;flex-wrap:wrap}.lb-head h3{font-size:16px;margin:0}
.lb-tabs{display:flex;gap:6px;background:var(--panel2);padding:3px;border-radius:10px;flex-wrap:wrap}.lb-tabs button{border:0;background:transparent;color:var(--muted);padding:6px 12px;border-radius:7px;font-size:12.5px;font-weight:600}
.lb-tabs button.on{background:var(--panel3);color:var(--accent)}.lb-list{display:flex;flex-direction:column;gap:2px}
.lb-row{display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:10px;font-size:14px}.lb-row:hover{background:var(--panel2)}.lb-row.me{background:rgba(124,92,255,.15);color:var(--accent)}
.lb-rank{width:26px;height:26px;border-radius:8px;display:grid;place-items:center;font-weight:700;font-size:12.5px;flex:none;background:var(--panel3);color:var(--muted)}.lb-name{flex:1;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.lb-score{font-weight:700}
.lb-empty{color:var(--muted);text-align:center;padding:24px;font-size:14px}
.game-view{padding:24px 0 60px}.game-head{display:flex;align-items:center;gap:14px;margin-bottom:20px;flex-wrap:wrap}.game-head h1{font-size:22px;margin:0;font-weight:700}.game-head .spacer{flex:1}
.back-btn{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;background:var(--panel2);border:1px solid var(--border);color:var(--muted);font-size:20px}
.back-btn:hover{border-color:var(--accent);color:var(--accent)}
.mode-tabs{display:flex;gap:6px;background:var(--panel2);padding:3px;border-radius:10px;margin-bottom:16px;width:max-content}.mode-tabs button{border:0;background:transparent;color:var(--muted);padding:8px 16px;border-radius:7px;font-size:13.5px;font-weight:600}.mode-tabs button.on{background:var(--accent);color:#fff}
.stage{background:var(--panel);border:1px solid var(--border);border-radius:20px;padding:18px;box-shadow:var(--shadow)}
.hud{display:flex;align-items:center;gap:16px;margin-bottom:14px;flex-wrap:wrap}.hud-item{background:var(--panel2);border:1px solid var(--border);border-radius:10px;padding:8px 14px;font-size:13px;font-weight:600}.hud-item .val{color:var(--accent);font-size:17px;font-weight:700;margin-left:6px}
.jump-canvas{width:100%;height:auto;display:block;border-radius:12px;background:linear-gradient(180deg,#1a1d2b 0%,#131625 100%);touch-action:none;cursor:pointer}.tip{text-align:center;color:var(--muted);font-size:13px;margin-top:12px}
.room-panel{background:var(--panel);border:1px solid var(--border);border-radius:20px;padding:22px;box-shadow:var(--shadow)}
.room-id{display:inline-flex;align-items:center;gap:8px;background:rgba(124,92,255,.15);color:var(--accent);padding:8px 16px;border-radius:10px;font-weight:700;letter-spacing:2px;font-family:ui-monospace,monospace;font-size:15px}
.room-players{margin:18px 0;display:flex;flex-wrap:wrap;gap:8px}.player-chip{display:inline-flex;align-items:center;gap:8px;background:var(--panel2);border:1px solid var(--border);padding:7px 14px 7px 7px;border-radius:999px;font-size:13.5px;font-weight:600}.player-chip .ava{width:26px;height:26px;border-radius:50%;display:grid;place-items:center;background:linear-gradient(135deg,var(--accent),var(--pink));color:#fff;font-size:12px}.player-chip.host{border-color:var(--accent)}
.room-wait{text-align:center;color:var(--muted);font-size:14px;padding:30px 20px}
.snake-wrap{display:grid;gap:18px;grid-template-columns:1fr 240px}@media(max-width:800px){.snake-wrap{grid-template-columns:1fr}}
.snake-canvas-box{background:var(--panel);border:1px solid var(--border);border-radius:20px;padding:14px;box-shadow:var(--shadow)}.snake-canvas{width:100%;height:auto;display:block;border-radius:10px;background:#0d0f18}
.snake-side{background:var(--panel);border:1px solid var(--border);border-radius:20px;padding:16px}.snake-side h4{font-size:13px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);margin:0 0 10px}
.snake-scores{display:flex;flex-direction:column;gap:8px;margin-bottom:16px}.snake-score-row{display:flex;align-items:center;gap:10px;font-size:13.5px}.snake-score-row .dot{width:12px;height:12px;border-radius:3px;flex:none}.snake-score-row .name{flex:1;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.snake-score-row .score{font-weight:700}.snake-score-row.dead{opacity:.4}
.snake-ctrl{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;max-width:180px;margin:0 auto}.snake-ctrl button{aspect-ratio:1;border:1px solid var(--border);background:var(--panel2);border-radius:10px;display:grid;place-items:center;font-size:18px}.snake-ctrl button:hover{border-color:var(--accent);color:var(--accent)}.snake-ctrl .empty{background:transparent;border:0;pointer-events:none}
.breakout-canvas{width:100%;height:auto;display:block;border-radius:12px;background:#0d0f18;touch-action:none;cursor:none}
.gomoku-wrap{display:grid;gap:18px;grid-template-columns:1fr 240px}@media(max-width:800px){.gomoku-wrap{grid-template-columns:1fr}}
.gomoku-canvas{width:100%;height:auto;display:block;border-radius:10px;background:#d9b382;cursor:pointer;touch-action:manipulation}
.gomoku-side{background:var(--panel2);border:1px solid var(--border);border-radius:14px;padding:16px}.gomoku-turn{display:flex;align-items:center;gap:10px;margin-bottom:16px;font-weight:700}.gomoku-turn .stone{width:22px;height:22px;border-radius:50%;border:2px solid rgba(0,0,0,.3);flex:none}.stone.black{background:#1a1a1a}.stone.white{background:#f5f5f5}
.draw-wrap{display:grid;gap:18px;grid-template-columns:1fr 280px}@media(max-width:900px){.draw-wrap{grid-template-columns:1fr}}
.draw-main{background:var(--panel);border:1px solid var(--border);border-radius:20px;padding:14px;box-shadow:var(--shadow)}
.draw-info{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px}
.draw-word{display:inline-flex;align-items:center;gap:8px;font-size:14px;font-weight:600}
.draw-word .hint{font-family:ui-monospace,monospace;letter-spacing:4px;font-size:18px;font-weight:700;color:var(--accent);padding:4px 12px;background:rgba(124,92,255,.15);border-radius:8px}
.draw-timer{display:inline-flex;align-items:center;gap:6px;font-weight:700;font-size:16px;color:var(--pink)}
.draw-canvas{width:100%;height:auto;display:block;border-radius:10px;background:#fff;touch-action:none;cursor:crosshair}
.draw-tools{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;align-items:center}
.color-btn{width:26px;height:26px;border-radius:50%;border:2px solid transparent;padding:0;transition:transform .15s}.color-btn.on{border-color:var(--fg);transform:scale(1.15)}
.draw-side{background:var(--panel);border:1px solid var(--border);border-radius:20px;padding:16px;display:flex;flex-direction:column;min-height:400px}
.draw-side h4{font-size:13px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);margin:0 0 12px}
.guess-list{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:6px;margin-bottom:12px;padding-right:4px;max-height:420px}
.guess-item{background:var(--panel2);border-radius:9px;padding:8px 12px;font-size:13.5px;line-height:1.45}
.guess-item .who{font-weight:700;color:var(--accent);margin-right:6px}
.guess-item.correct{background:rgba(95,210,143,.14);color:var(--green)}.guess-item.correct .who{color:var(--green)}
.guess-item.sys{background:transparent;color:var(--muted);text-align:center;font-size:12.5px;padding:4px}
.guess-form{display:flex;gap:8px}.guess-form input{flex:1;min-width:0}
.overlay{position:fixed;inset:0;z-index:100;display:none;place-items:center;padding:24px;background:rgba(8,10,16,.82);backdrop-filter:blur(8px)}.overlay.on{display:grid}
.overlay-card{background:var(--panel);border:1px solid var(--border);border-radius:24px;padding:32px;max-width:400px;width:100%;text-align:center;box-shadow:0 40px 80px -30px rgba(0,0,0,.8)}
.overlay-card h2{font-size:24px;margin:0 0 8px}.overlay-card p{color:var(--muted);margin:0 0 22px}.overlay-card .big-score{font-size:56px;font-weight:800;color:var(--accent);line-height:1;margin:12px 0}.overlay-card .row{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}
.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%) translateY(20px);background:var(--panel3);color:var(--fg);border:1px solid var(--border);padding:11px 22px;border-radius:12px;font-size:14px;font-weight:600;opacity:0;pointer-events:none;transition:opacity .25s,transform .25s;z-index:200;max-width:90vw;text-align:center}.toast.on{opacity:1;transform:translateX(-50%) translateY(0)}
@media(max-width:600px){.brand span.t{display:none}.user-chip .name{display:none}.section{padding:26px 0}.game-grid{grid-template-columns:1fr}}
</style></head><body>
<div class="login-view" id="loginView"><div class="login-card">
<div class="login-logo">🎮</div><h1 id="authTitle">欢迎回来</h1><p class="sub" id="authSub">登录你的账号，开始游戏之旅</p>
<div class="login-tabs"><button class="on" data-tab="login">登录</button><button data-tab="register">注册</button></div>
<form id="authForm"><div class="field"><label>用户名</label><input class="input" type="text" id="username" placeholder="2-16 位中文、字母或数字" required></div>
<div class="field"><label>密码</label><input class="input" type="password" id="password" placeholder="至少 4 位" required></div>
<p class="msg" id="authMsg"></p><button class="btn btn-primary" type="submit" id="authBtn">登录</button></form>
</div></div>
<div id="appView" class="hidden"><header class="topnav"><div class="wrap topnav-inner">
<div class="brand"><span class="mark">🎮</span><span class="t">欢乐小游戏</span></div>
<div class="nav-right"><div class="user-chip"><span class="ava" id="userAva">?</span><span class="name" id="userName">...</span></div><button class="btn btn-ghost btn-sm" id="logoutBtn">退出</button></div>
</div></header><main id="main"></main></div>
<div class="overlay" id="overlay"><div class="overlay-card" id="overlayCard"></div></div>
<div class="toast" id="toast"></div>
<script>
(function(){
"use strict";
var $=function(i){return document.getElementById(i)};
var state={username:null,view:"lobby",room:null,es:null,lbGame:"jump",jump:null,snakeSingle:null,breakout:null,gomokuState:null,drawData:null};
function toast(m){var t=$("toast");t.textContent=m;t.classList.add("on");clearTimeout(t._t);t._t=setTimeout(function(){t.classList.remove("on")},2400)}
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]})}
function api(method,path,b){return fetch(path,{method:method,headers:b?{"Content-Type":"application/json"}:undefined,body:b?JSON.stringify(b):undefined,credentials:"same-origin"}).then(function(r){return r.json().catch(function(){return{}}).then(function(j){if(!r.ok)throw Object.assign(new Error(j.error||"请求失败"),{status:r.status});return j})})}
function avaChar(n){return (n||"?").slice(0,1).toUpperCase()}
function showOv(h){$("overlayCard").innerHTML=h;$("overlay").classList.add("on")}
function hideOv(){$("overlay").classList.remove("on")}
$("overlay").addEventListener("click",function(e){if(e.target===$("overlay"))hideOv()});
var authMode="login";
document.querySelectorAll(".login-tabs button").forEach(function(b){b.addEventListener("click",function(){authMode=b.getAttribute("data-tab");document.querySelectorAll(".login-tabs button").forEach(function(x){x.classList.toggle("on",x===b)});$("authTitle").textContent=authMode==="login"?"欢迎回来":"创建账号";$("authSub").textContent=authMode==="login"?"登录你的账号，开始游戏之旅":"注册一个专属账号，和好友一起玩";$("authBtn").textContent=authMode==="login"?"登录":"注册并登录";$("authMsg").textContent=""})});
$("authForm").addEventListener("submit",function(e){e.preventDefault();var u=$("username").value.trim(),p=$("password").value;if(!u||!p){$("authMsg").textContent="请填写完整";return}$("authBtn").disabled=true;$("authMsg").textContent=authMode==="login"?"登录中…":"注册中…";var url=authMode==="login"?"/api/login":"/api/register";api("POST",url,{username:u,password:p}).then(function(r){state.username=r.username;$("password").value="";$("authMsg").textContent="";enterApp()}).catch(function(err){$("authMsg").textContent=err.message||"出错了"}).then(function(){$("authBtn").disabled=false})});
$("logoutBtn").addEventListener("click",function(){if(state.es){state.es.close();state.es=null}api("POST","/api/logout").catch(function(){}).then(function(){location.reload()})});
function enterApp(){$("loginView").classList.add("hidden");$("appView").classList.remove("hidden");$("userAva").textContent=avaChar(state.username);$("userName").textContent=state.username;go("lobby")}
function go(v){
  if(state.jump&&state.jump.destroy)state.jump.destroy();
  if(state.snakeSingle&&state.snakeSingle.destroy)state.snakeSingle.destroy();
  if(state.breakout&&state.breakout.destroy)state.breakout.destroy();
  state.jump=null;state.snakeSingle=null;state.breakout=null;
  if(state.es){state.es.close();state.es=null}
  state.room=null;state.view=v;
  if(v==="lobby")showLobby();else if(v==="jump")showJump();else if(v==="snake")showSnakeLobby();else if(v==="breakout")showBreakout();else if(v==="gomoku")showGomokuLobby();else if(v==="draw")showDrawLobby();
}
function showLobby(){
  var m=$("main");
  m.innerHTML='<div class="wrap section"><h2>选择一个小游戏</h2><p class="sub">单人挑战或和好友联机</p>'+
    '<div class="game-grid">'+
    '<div class="game-card" data-game="jump"><div class="game-icon" style="background:rgba(124,92,255,.15);color:#7c5cff">🎯</div><h3>跳一跳</h3><p>按住蓄力，松开跳跃，落到下一个方块上得一分。</p><div class="game-tags"><span class="tag accent">单人</span><span class="tag">排行榜</span></div></div>'+
    '<div class="game-card" data-game="snake"><div class="game-icon" style="background:rgba(95,210,143,.15);color:#5fd28f">🐍</div><h3>贪吃蛇</h3><p>单人挑战或最多 4 人同房间实时对战。</p><div class="game-tags"><span class="tag accent">单/联机</span><span class="tag">1-4 人</span></div></div>'+
    '<div class="game-card" data-game="breakout"><div class="game-icon" style="background:rgba(59,130,246,.15);color:#3b82f6">🧱</div><h3>打砖块</h3><p>控制挡板反弹小球，打碎所有砖块得高分。</p><div class="game-tags"><span class="tag accent">单人</span><span class="tag">排行榜</span></div></div>'+
    '<div class="game-card" data-game="draw"><div class="game-icon" style="background:rgba(224,111,146,.15);color:#e06f92">🎨</div><h3>你画我猜</h3><p>轮流当画手，把看到的词画出来让其他人猜。</p><div class="game-tags"><span class="tag accent">联机</span><span class="tag">2+ 人</span></div></div>'+
    '<div class="game-card" data-game="gomoku"><div class="game-icon" style="background:rgba(6,182,212,.15);color:#06b6d4">⚫</div><h3>五子棋</h3><p>15×15 棋盘，黑白轮流落子，先连五子者胜。</p><div class="game-tags"><span class="tag accent">联机</span><span class="tag">2 人</span></div></div>'+
    '</div></div>'+
    '<div class="wrap"><div class="lb-panel"><div class="lb-head"><h3>🏆 排行榜</h3><div class="lb-tabs" id="lbTabs">'+
    '<button data-game="jump" class="on">跳一跳</button><button data-game="snake">贪吃蛇</button><button data-game="breakout">打砖块</button><button data-game="draw">你画我猜</button><button data-game="gomoku">五子棋</button></div></div><div class="lb-list" id="lbList"><div class="lb-empty">加载中…</div></div></div></div>';
  m.querySelectorAll(".game-card").forEach(function(c){c.addEventListener("click",function(){go(c.getAttribute("data-game"))})});
  m.querySelectorAll("#lbTabs button").forEach(function(b){b.addEventListener("click",function(){m.querySelectorAll("#lbTabs button").forEach(function(x){x.classList.toggle("on",x===b)});state.lbGame=b.getAttribute("data-game");loadLB()})});
  state.lbGame="jump";loadLB();
}
function loadLB(){var l=$("lbList");if(!l)return;api("GET","/api/leaderboard?game="+encodeURIComponent(state.lbGame)).then(function(r){if(!r.list||!r.list.length){l.innerHTML='<div class="lb-empty">还没有记录，快来抢占第一名 🥇</div>';return}l.innerHTML=r.list.map(function(x,i){return '<div class="lb-row'+(x.username===state.username?" me":"")+'"><span class="lb-rank">'+(i+1)+'</span><span class="lb-name">'+esc(x.username)+'</span><span class="lb-score">'+x.score+'</span></div>'}).join("")}).catch(function(){l.innerHTML='<div class="lb-empty">加载失败</div>'})}
function head(title,extra){return '<div class="wrap game-view"><div class="game-head"><button class="back-btn" id="backBtn" type="button">←</button><h1>'+title+'</h1><div class="spacer"></div>'+(extra||"")+'</div>'}
function backLobby(){var b=$("backBtn");if(b)b.addEventListener("click",function(){go("lobby")})}

/* ===== 跳一跳 ===== */
function showJump(){
  var m=$("main");
  m.innerHTML=head("🎯 跳一跳")+'<div class="stage"><div class="hud"><div class="hud-item">得分<span class="val" id="jumpScore">0</span></div><div class="hud-item">最高<span class="val" id="jumpBest">0</span></div><div style="flex:1"></div><button class="btn btn-secondary btn-sm" id="jumpRestart">重新开始</button></div><canvas class="jump-canvas" id="jumpCanvas" width="900" height="500"></canvas><p class="tip">按住屏幕或空格键蓄力，松开跳跃</p></div></div>';
  backLobby();
  var cv=$("jumpCanvas"),ctx=cv.getContext("2d"),W=cv.width,H=cv.height;
  var g={blocks:[],player:null,camX:0,score:0,power:0,charging:false,state:"idle",dead:false};
  function rr(c,x,y,w,h,r){c.beginPath();c.moveTo(x+r,y);c.arcTo(x+w,y,x+w,y+h,r);c.arcTo(x+w,y+h,x,y+h,r);c.arcTo(x,y+h,x,y,r);c.arcTo(x,y,x+w,y,r);c.closePath()}
  function reset(){var gy=H-100;g.blocks=[{x:0,y:gy,w:120,h:100},{x:300,y:gy,w:120,h:100}];g.player={x:60,y:gy-34,w:34,h:34};g.camX=0;g.score=0;g.state="idle";g.power=0;g.charging=false;$("jumpScore").textContent="0";draw()}
  function draw(){
    ctx.clearRect(0,0,W,H);
    var gr=ctx.createLinearGradient(0,0,0,H);gr.addColorStop(0,"#1a1d2b");gr.addColorStop(1,"#131625");ctx.fillStyle=gr;ctx.fillRect(0,0,W,H);
    ctx.fillStyle="rgba(124,92,255,.08)";for(var i=0;i<6;i++){var xx=(i*200-g.camX*.3)%(W+200);if(xx<-100)xx+=W+200;ctx.fillRect(xx,H-220,100,220)}
    g.blocks.forEach(function(b){var bx=b.x-g.camX;if(bx+b.w<-20||bx>W+20)return;var gg=ctx.createLinearGradient(bx,b.y,bx,b.y+b.h);gg.addColorStop(0,"#2d3450");gg.addColorStop(1,"#1d2338");ctx.fillStyle=gg;rr(ctx,bx,b.y,b.w,b.h,8);ctx.fill();ctx.strokeStyle="rgba(124,92,255,.35)";ctx.lineWidth=1.5;ctx.stroke();ctx.fillStyle="rgba(124,92,255,.5)";ctx.fillRect(bx+6,b.y+3,b.w-12,2)});
    var px=g.player.x-g.camX,py=g.player.y;var pg=ctx.createLinearGradient(px,py,px,py+g.player.h);pg.addColorStop(0,"#9d7dff");pg.addColorStop(1,"#7c5cff");ctx.fillStyle=pg;ctx.shadowColor="rgba(124,92,255,.7)";ctx.shadowBlur=18;rr(ctx,px,py,g.player.w,g.player.h,8);ctx.fill();ctx.shadowBlur=0;
    if(g.charging){var bw=200,bx2=W/2-bw/2,by=40;ctx.fillStyle="rgba(255,255,255,.1)";rr(ctx,bx2,by,bw,10,5);ctx.fill();var pct=Math.min(1,g.power);var g2=ctx.createLinearGradient(bx2,0,bx2+bw,0);g2.addColorStop(0,"#7c5cff");g2.addColorStop(1,"#e06f92");ctx.fillStyle=g2;rr(ctx,bx2,by,bw*pct,10,5);ctx.fill()}
  }
  var raf=null;
  function loop(){if(g.dead)return;if(g.charging){g.power=Math.min(1,g.power+.018);draw();raf=requestAnimationFrame(loop)}}
  function press(){if(g.state!=="idle")return;g.state="charging";g.charging=true;g.power=0;cancelAnimationFrame(raf);loop()}
  function rel(){
    if(g.state!=="charging")return;g.state="jumping";g.charging=false;cancelAnimationFrame(raf);
    var dist=80+g.power*360,sx=g.player.x,sy=g.player.y,nx=sx+dist;
    var land=g.blocks.find(function(b){return nx>=b.x&&nx<=b.x+b.w-g.player.w});
    var dur=320,t0=performance.now(),arc=90+g.power*60;
    function step(now){if(g.dead)return;var t=Math.min(1,(now-t0)/dur);g.player.x=sx+(nx-sx)*t;g.player.y=sy-Math.sin(Math.PI*t)*arc;draw();
      if(t<1)requestAnimationFrame(step);
      else{
        if(land){g.score++;$("jumpScore").textContent=g.score;var last=g.blocks[g.blocks.length-1];var nX=last.x+last.w+90+Math.random()*120,nW=80+Math.random()*70;g.blocks.push({x:nX,y:H-100,w:nW,h:100});if(g.blocks.length>5)g.blocks.shift();g.player.y=H-100-g.player.h;g.player.x=land.x+land.w/2-g.player.w/2;g.state="idle";animCam(g.player.x-W*.35)}
        else{g.state="falling";var fs=g.player.y,ft=performance.now();(function fstep(n2){if(g.dead)return;var x=Math.min(1,(n2-ft)/500);g.player.y=fs+x*300;g.player.x+=1.5;draw();if(x<1)requestAnimationFrame(fstep);else over()})(performance.now())}
      }
    }requestAnimationFrame(step)
  }
  function animCam(tc){var s=g.camX,t0=performance.now();(function st(now){if(g.dead)return;var t=Math.min(1,(now-t0)/300);g.camX=s+(tc-s)*(1-Math.pow(1-t,3));draw();if(t<1)requestAnimationFrame(st)})(performance.now())}
  function over(){
    if(g.dead)return;api("POST","/api/score",{game:"jump",score:g.score}).catch(function(){});
    var best=parseInt($("jumpBest").textContent,10)||0;if(g.score>best)$("jumpBest").textContent=g.score;
    showOv('<h2>游戏结束</h2><p>再来一次，挑战更高分！</p><div class="big-score">'+g.score+'</div><div class="row"><button class="btn btn-primary" id="ovR">再来一次</button><button class="btn btn-secondary" id="ovL">回大厅</button></div>');
    setTimeout(function(){var b=document.getElementById("ovR");if(b)b.addEventListener("click",function(){hideOv();reset()});var l=document.getElementById("ovL");if(l)l.addEventListener("click",function(){hideOv();go("lobby")})},0)
  }
  var dp=function(e){if(e.type==="mousedown"&&e.button!==0)return;e.preventDefault();press()};
  var up=function(e){if(g.state==="charging"){e.preventDefault();rel()}};
  cv.addEventListener("mousedown",dp);cv.addEventListener("touchstart",dp,{passive:false});
  window.addEventListener("mouseup",up);window.addEventListener("touchend",up);
  var kd=function(e){if(e.code==="Space"){e.preventDefault();if(!e.repeat)press()}};
  var ku=function(e){if(e.code==="Space"){e.preventDefault();rel()}};
  window.addEventListener("keydown",kd);window.addEventListener("keyup",ku);
  $("jumpRestart").addEventListener("click",reset);
  reset();
  api("GET","/api/leaderboard?game=jump").then(function(r){if(r.list&&r.list.length){var mine=r.list.find(function(x){return x.username===state.username});if(mine)$("jumpBest").textContent=mine.score}}).catch(function(){});
  state.jump={destroy:function(){g.dead=true;cancelAnimationFrame(raf);window.removeEventListener("mouseup",up);window.removeEventListener("touchend",up);window.removeEventListener("keydown",kd);window.removeEventListener("keyup",ku)}}
}

/* ===== 贪吃蛇 ===== */
function showSnakeLobby(){
  var m=$("main");
  m.innerHTML=head("🐍 贪吃蛇")+'<div class="mode-tabs" id="smt"><button class="on" data-mode="single">单人模式</button><button data-mode="multi">联机模式</button></div><div id="snakeBody"></div></div>';
  backLobby();
  function render(mode){if(mode==="single")renderSnakeSingle();else renderSnakeMulti()}
  document.querySelectorAll("#smt button").forEach(function(b){b.addEventListener("click",function(){document.querySelectorAll("#smt button").forEach(function(x){x.classList.toggle("on",x===b)});render(b.getAttribute("data-mode"))})});
  render("single")
}
function renderSnakeSingle(){
  var b=$("snakeBody");
  b.innerHTML='<div class="stage"><div class="hud"><div class="hud-item">得分<span class="val" id="ssScore">0</span></div><div class="hud-item">最高<span class="val" id="ssBest">0</span></div><div style="flex:1"></div><button class="btn btn-secondary btn-sm" id="ssRestart">重新开始</button></div><div class="snake-wrap"><div class="snake-canvas-box" style="padding:8px"><canvas class="snake-canvas" id="ssCanvas" width="560" height="400"></canvas></div><div class="snake-side"><h4>控制方式</h4><p style="color:var(--muted);font-size:13px">键盘 ↑↓←→ 或 WASD<br>手机可用下方方向键</p><div class="snake-ctrl" style="margin-top:14px"><button class="empty"></button><button data-dir="up">↑</button><button class="empty"></button><button data-dir="left">←</button><button data-dir="down">↓</button><button data-dir="right">→</button></div></div></div></div>';
  var W=28,H=20,cv=$("ssCanvas"),ctx=cv.getContext("2d"),cw=cv.width/W,ch=cv.height/H;
  var g={snake:[{x:10,y:10},{x:9,y:10},{x:8,y:10}],dir:"right",nextDir:"right",food:{x:15,y:10},score:0,alive:true,dead:false,timer:null};
  function rf(){while(1){var x=Math.floor(Math.random()*W),y=Math.floor(Math.random()*H);if(!g.snake.some(function(s){return s.x===x&&s.y===y}))return{x:x,y:y}}}
  function rrs(c,x,y,w,h,r){c.beginPath();c.moveTo(x+r,y);c.arcTo(x+w,y,x+w,y+h,r);c.arcTo(x+w,y+h,x,y+h,r);c.arcTo(x,y+h,x,y,r);c.arcTo(x,y,x+w,y,r);c.closePath()}
  function draw(){
    ctx.fillStyle="#0d0f18";ctx.fillRect(0,0,cv.width,cv.height);
    ctx.strokeStyle="rgba(124,92,255,.06)";ctx.lineWidth=1;
    for(var i=1;i<W;i++){ctx.beginPath();ctx.moveTo(i*cw,0);ctx.lineTo(i*cw,cv.height);ctx.stroke()}
    for(var j=1;j<H;j++){ctx.beginPath();ctx.moveTo(0,j*ch);ctx.lineTo(cv.width,j*ch);ctx.stroke()}
    var fx=g.food.x*cw+cw/2,fy=g.food.y*ch+ch/2,r=Math.min(cw,ch)*.32;ctx.fillStyle="#f5c96b";ctx.beginPath();ctx.arc(fx,fy,r,0,Math.PI*2);ctx.fill();ctx.shadowColor="#f5c96b";ctx.shadowBlur=15;ctx.fill();ctx.shadowBlur=0;
    g.snake.forEach(function(b,i){var x=b.x*cw,y=b.y*ch;var al=1-i/(g.snake.length+5)*.6;ctx.globalAlpha=al;ctx.fillStyle="#7bb87b";rrs(ctx,x+1,y+1,cw-2,ch-2,Math.min(cw,ch)*.3);ctx.fill();if(i===0){ctx.shadowColor="#7bb87b";ctx.shadowBlur=14;ctx.fill();ctx.shadowBlur=0;ctx.globalAlpha=1;ctx.fillStyle="#fff";var ex=x+cw/2,ey=y+ch/2,er=Math.min(cw,ch)*.1;ctx.beginPath();ctx.arc(ex-cw*.15,ey,er,0,Math.PI*2);ctx.fill();ctx.beginPath();ctx.arc(ex+cw*.15,ey,er,0,Math.PI*2);ctx.fill()}});
    ctx.globalAlpha=1
  }
  function tick(){
    if(!g.alive||g.dead)return;
    var cur={up:{x:0,y:-1},down:{x:0,y:1},left:{x:-1,y:0},right:{x:1,y:0}};
    var c=cur[g.dir],n=cur[g.nextDir];if(!(c.x+n.x===0&&c.y+n.y===0))g.dir=g.nextDir;
    var d=cur[g.dir],h=g.snake[0],nh={x:h.x+d.x,y:h.y+d.y};
    if(nh.x<0||nh.x>=W||nh.y<0||nh.y>=H)return over();
    if(g.snake.some(function(s,i){return i<g.snake.length-1&&s.x===nh.x&&s.y===nh.y}))return over();
    g.snake.unshift(nh);
    if(nh.x===g.food.x&&nh.y===g.food.y){g.score+=10;$("ssScore").textContent=g.score;g.food=rf()}else g.snake.pop();
    draw()
  }
  function over(){
    g.alive=false;if(g.timer)clearInterval(g.timer);
    api("POST","/api/score",{game:"snake",score:g.score}).catch(function(){});
    var best=parseInt($("ssBest").textContent,10)||0;if(g.score>best)$("ssBest").textContent=g.score;
    showOv('<h2>游戏结束</h2><p>你的得分</p><div class="big-score">'+g.score+'</div><div class="row"><button class="btn btn-primary" id="ovR">再来一次</button><button class="btn btn-secondary" id="ovL">回大厅</button></div>');
    setTimeout(function(){var b=document.getElementById("ovR");if(b)b.addEventListener("click",function(){hideOv();restart()});var l=document.getElementById("ovL");if(l)l.addEventListener("click",function(){hideOv();go("lobby")})},0)
  }
  function restart(){g.snake=[{x:10,y:10},{x:9,y:10},{x:8,y:10}];g.dir="right";g.nextDir="right";g.food=rf();g.score=0;g.alive=true;$("ssScore").textContent="0";draw();if(g.timer)clearInterval(g.timer);g.timer=setInterval(tick,130)}
  function sd(d){if(g.alive)g.nextDir=d}
  document.querySelectorAll(".snake-ctrl button[data-dir]").forEach(function(bt){bt.addEventListener("click",function(){sd(bt.getAttribute("data-dir"))})});
  var kh=function(e){var map={ArrowUp:"up",ArrowDown:"down",ArrowLeft:"left",ArrowRight:"right",w:"up",s:"down",a:"left",d:"right",W:"up",S:"down",A:"left",D:"right"};if(map[e.key]){e.preventDefault();sd(map[e.key])}};
  window.addEventListener("keydown",kh);
  var tx=0,ty=0;
  cv.addEventListener("touchstart",function(e){var t=e.touches[0];tx=t.clientX;ty=t.clientY},{passive:true});
  cv.addEventListener("touchmove",function(e){e.preventDefault()},{passive:false});
  cv.addEventListener("touchend",function(e){var t=e.changedTouches[0],dx=t.clientX-tx,dy=t.clientY-ty;if(Math.abs(dx)<20&&Math.abs(dy)<20)return;if(Math.abs(dx)>Math.abs(dy))sd(dx>0?"right":"left");else sd(dy>0?"down":"up")});
  $("ssRestart").addEventListener("click",restart);
  restart();
  api("GET","/api/leaderboard?game=snake").then(function(r){if(r.list&&r.list.length){var mine=r.list.find(function(x){return x.username===state.username});if(mine)$("ssBest").textContent=mine.score}}).catch(function(){});
  state.snakeSingle={destroy:function(){g.dead=true;if(g.timer)clearInterval(g.timer);window.removeEventListener("keydown",kh)}}
}
function renderSnakeMulti(){
  var b=$("snakeBody");
  b.innerHTML='<div class="room-panel"><div style="display:flex;gap:14px;flex-wrap:wrap;justify-content:space-between"><div><div style="font-size:13px;color:var(--muted);margin-bottom:6px;font-weight:600">创建房间，把房间号发给好友</div><button class="btn btn-primary" id="crBtn">创建新房间</button></div><div style="text-align:right"><div style="font-size:13px;color:var(--muted);margin-bottom:6px;font-weight:600">或输入房间号加入</div><div style="display:flex;gap:8px"><input class="input" id="jcIn" placeholder="6 位房间号" maxlength="6" style="width:130px;text-transform:lowercase"><button class="btn btn-secondary" id="jrBtn">加入</button></div></div></div></div>';
  $("crBtn").addEventListener("click",function(){$("crBtn").disabled=true;api("POST","/api/room/create",{game:"snake"}).then(function(r){state.room={id:r.roomId,game:r.game};enterSnakeRoom()}).catch(function(err){toast(err.message);$("crBtn").disabled=false})});
  $("jrBtn").addEventListener("click",function(){var c=($("jcIn").value||"").trim().toLowerCase();if(!c){toast("请输入房间号");return}api("POST","/api/room/join",{roomId:c}).then(function(r){state.room={id:r.roomId,game:r.game};enterSnakeRoom()}).catch(function(err){toast(err.message)})});
  $("jcIn").addEventListener("keydown",function(e){if(e.key==="Enter")$("jrBtn").click()})
}
function enterSnakeRoom(){
  var m=$("main");
  m.innerHTML=head("🐍 贪吃蛇对战",'<span class="room-id" id="ridChip">----</span><button class="btn btn-secondary btn-sm" id="lvBtn">离开房间</button>')+
    '<div class="room-panel" id="preG"><div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:16px"><div style="font-size:14px;font-weight:600">房间号：<span id="ridTxt" style="color:var(--accent);letter-spacing:2px;font-family:ui-monospace,monospace"></span></div><div style="font-size:13px;color:var(--muted)">最多 4 人 · 房主可开始</div></div><div style="font-size:13px;color:var(--muted);font-weight:600;margin-bottom:8px">当前玩家</div><div class="room-players" id="sPlayers"></div><div class="room-wait">等待房主开始游戏…</div><div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:8px"><button class="btn btn-primary" id="sStart" style="display:none">开始游戏</button></div></div>'+
    '<div class="snake-wrap hidden" id="sGame"><div class="snake-canvas-box"><canvas class="snake-canvas" id="sCanvas" width="840" height="600"></canvas></div><div class="snake-side"><h4>玩家分数</h4><div class="snake-scores" id="sScores"></div><h4 style="margin-top:16px">方向控制</h4><div class="snake-ctrl"><button class="empty"></button><button data-dir="up">↑</button><button class="empty"></button><button data-dir="left">←</button><button data-dir="down">↓</button><button data-dir="right">→</button></div></div></div></div>';
  $("backBtn").addEventListener("click",function(){api("POST","/api/room/leave",{roomId:state.room.id}).catch(function(){});go("lobby")});
  $("lvBtn").addEventListener("click",function(){api("POST","/api/room/leave",{roomId:state.room.id}).catch(function(){});go("lobby")});
  $("sStart").addEventListener("click",function(){api("POST","/api/room/action",{roomId:state.room.id,action:"start"}).catch(function(err){toast(err.message)})});
  csr()
}
function rsPlayers(ps,host){var el=$("sPlayers");if(!el)return;el.innerHTML=ps.map(function(p){return '<span class="player-chip'+(p===host?" host":"")+'"><span class="ava">'+esc(avaChar(p))+'</span>'+esc(p)+(p===state.username?" (我)":"")+'</span>'}).join("");var sb=$("sStart");if(sb)sb.style.display=(host===state.username&&ps.length>=1)?"":"none"}
var smcInited=false;
function csr(){
  if(state.es)state.es.close();
  var es=new EventSource("/api/room/events?room="+encodeURIComponent(state.room.id));
  state.es=es;
  es.addEventListener("init",function(e){var d=JSON.parse(e.data);state.room.game=d.game;state.room.host=d.host;state.room.players=d.players;var c=$("ridChip");if(c)c.textContent="#"+d.roomId.toUpperCase();var rt=$("ridTxt");if(rt)rt.textContent=d.roomId.toUpperCase();rsPlayers(d.players,d.host)});
  es.addEventListener("players",function(e){var d=JSON.parse(e.data);state.room.players=d.players;state.room.host=d.host;rsPlayers(d.players,d.host)});
  es.addEventListener("snake-start",function(e){var d=JSON.parse(e.data);var pg=$("preG"),sg=$("sGame");if(pg)pg.classList.add("hidden");if(sg)sg.classList.remove("hidden");if(!smcInited){initSMC();smcInited=true}rss(d.state)});
  es.addEventListener("snake-state",function(e){rss(JSON.parse(e.data).state)});
  es.addEventListener("snake-end",function(e){var d=JSON.parse(e.data);rss(d.state);var my=d.state.snakes[state.username];var sc=my?my.score:0;showOv('<h2>游戏结束</h2><p>你的得分</p><div class="big-score">'+sc+'</div><div class="row"><button class="btn btn-primary" id="ovR">再来一局</button><button class="btn btn-secondary" id="ovL">回大厅</button></div>');setTimeout(function(){var b=document.getElementById("ovR");if(b)b.addEventListener("click",function(){hideOv();var pg=$("preG"),sg=$("sGame");if(pg)pg.classList.remove("hidden");if(sg)sg.classList.add("hidden")});var l=document.getElementById("ovL");if(l)l.addEventListener("click",function(){hideOv();go("lobby")})},0)});
  es.onerror=function(){}
}
function initSMC(){
  document.querySelectorAll(".snake-ctrl button[data-dir]").forEach(function(b){b.addEventListener("click",function(){ssd(b.getAttribute("data-dir"))})});
  document.addEventListener("keydown",function(e){if(!state.room||state.room.game!=="snake")return;var map={ArrowUp:"up",ArrowDown:"down",ArrowLeft:"left",ArrowRight:"right",w:"up",s:"down",a:"left",d:"right",W:"up",S:"down",A:"left",D:"right"};if(map[e.key]){e.preventDefault();ssd(map[e.key])}});
  var cv=$("sCanvas");
  if(cv){var tx=0,ty=0;cv.addEventListener("touchstart",function(e){var t=e.touches[0];tx=t.clientX;ty=t.clientY},{passive:true});cv.addEventListener("touchmove",function(e){e.preventDefault()},{passive:false});cv.addEventListener("touchend",function(e){var t=e.changedTouches[0],dx=t.clientX-tx,dy=t.clientY-ty;if(Math.abs(dx)<20&&Math.abs(dy)<20)return;if(Math.abs(dx)>Math.abs(dy))ssd(dx>0?"right":"left");else ssd(dy>0?"down":"up")})}
}
var lastSD="";
function ssd(d){if(!state.room||state.room.game!=="snake")return;if(d===lastSD)return;lastSD=d;api("POST","/api/room/action",{roomId:state.room.id,action:"dir",dir:d}).catch(function(){})}
function rrs(s){
  if(!s)return;var cv=$("sCanvas");if(!cv)return;var ctx=cv.getContext("2d"),W=cv.width,H=cv.height,cw=W/s.w,ch=H/s.h;
  ctx.fillStyle="#0d0f18";ctx.fillRect(0,0,W,H);ctx.strokeStyle="rgba(124,92,255,.06)";ctx.lineWidth=1;
  for(var i=1;i<s.w;i++){ctx.beginPath();ctx.moveTo(i*cw,0);ctx.lineTo(i*cw,H);ctx.stroke()}
  for(var j=1;j<s.h;j++){ctx.beginPath();ctx.moveTo(0,j*ch);ctx.lineTo(W,j*ch);ctx.stroke()}
  s.food.forEach(function(f){var fx=f.x*cw+cw/2,fy=f.y*ch+ch/2,r=Math.min(cw,ch)*.32;ctx.fillStyle="#f5c96b";ctx.beginPath();ctx.arc(fx,fy,r,0,Math.PI*2);ctx.fill();ctx.shadowColor="#f5c96b";ctx.shadowBlur=15;ctx.fill();ctx.shadowBlur=0});
  function rrs2(c,x,y,w,h,r){c.beginPath();c.moveTo(x+r,y);c.arcTo(x+w,y,x+w,y+h,r);c.arcTo(x+w,y+h,x,y+h,r);c.arcTo(x,y+h,x,y,r);c.arcTo(x,y,x+w,y,r);c.closePath()}
  var sc=[];
  for(var u in s.snakes){var sn=s.snakes[u];sc.push({name:sn.name,color:sn.color,score:sn.score,alive:sn.alive});sn.body.forEach(function(b,i){var x=b.x*cw,y=b.y*ch,al=sn.alive?(1-i/(sn.body.length+5)*.7):.25;ctx.globalAlpha=al;ctx.fillStyle=sn.color;rrs2(ctx,x+1,y+1,cw-2,ch-2,Math.min(cw,ch)*.3);ctx.fill();if(i===0&&sn.alive){ctx.shadowColor=sn.color;ctx.shadowBlur=14;ctx.fill();ctx.shadowBlur=0;ctx.globalAlpha=1;ctx.fillStyle="#fff";var ex=x+cw/2,ey=y+ch/2,er=Math.min(cw,ch)*.1;ctx.beginPath();ctx.arc(ex-cw*.15,ey,er,0,Math.PI*2);ctx.fill();ctx.beginPath();ctx.arc(ex+cw*.15,ey,er,0,Math.PI*2);ctx.fill()}})}
  ctx.globalAlpha=1;
  var sl=$("sScores");if(sl){sc.sort(function(a,b){return b.score-a.score});sl.innerHTML=sc.map(function(x){return '<div class="snake-score-row'+(x.alive?"":" dead")+'"><span class="dot" style="background:'+x.color+'"></span><span class="name">'+esc(x.name)+(x.name===state.username?" (我)":"")+'</span><span class="score">'+x.score+'</span></div>'}).join("")}
}

/* ===== 打砖块 ===== */
function showBreakout(){
  var m=$("main");
  m.innerHTML=head("🧱 打砖块")+'<div class="stage"><div class="hud"><div class="hud-item">得分<span class="val" id="boScore">0</span></div><div class="hud-item">生命<span class="val" id="boLives">3</span></div><div class="hud-item">最高<span class="val" id="boBest">0</span></div><div style="flex:1"></div><button class="btn btn-secondary btn-sm" id="boRestart">重新开始</button></div><canvas class="breakout-canvas" id="boCanvas" width="700" height="500"></canvas><p class="tip">鼠标 / 触摸移动挡板，打碎所有砖块</p></div></div>';
  backLobby();
  var cv=$("boCanvas"),ctx=cv.getContext("2d"),W=cv.width,H=cv.height;
  var destroyed=false;
  var g={paddle:{x:W/2-50,y:H-30,w:100,h:14},ball:{x:W/2,y:H-50,r:8,vx:0,vy:0},bricks:[],score:0,lives:3,running:false,keys:{},colors:["#e06f92","#7c5cff","#5fd28f","#f5c96b","#3b82f6"]};
  function initBricks(){
    g.bricks=[];
    var rows=5,cols=8,bw=W/cols-4,bh=22,pad=4,offY=50;
    for(var r=0;r<rows;r++)for(var c=0;c<cols;c++){
      g.bricks.push({x:c*(bw+pad)+pad/2,y:offY+r*(bh+pad),w:bw,h:bh,color:g.colors[r%g.colors.length],alive:true,pts:(5-r)*10});
    }
  }
  function reset(){
    g.score=0;g.lives=3;g.paddle.x=W/2-50;g.running=false;
    g.ball.x=W/2;g.ball.y=H-50;g.ball.vx=0;g.ball.vy=0;
    $("boScore").textContent="0";$("boLives").textContent="3";
    initBricks();draw();
  }
  function launch(){
    if(g.running)return;
    g.running=true;
    var angle=(-Math.PI/2)+(Math.random()*0.8-0.4);
    var speed=5;
    g.ball.vx=Math.cos(angle)*speed;g.ball.vy=Math.sin(angle)*speed;
    loop();
  }
  function rr(c,x,y,w,h,r){c.beginPath();c.moveTo(x+r,y);c.arcTo(x+w,y,x+w,y+h,r);c.arcTo(x+w,y+h,x,y+h,r);c.arcTo(x,y+h,x,y,r);c.arcTo(x,y,x+w,y,r);c.closePath()}
  function draw(){
    ctx.fillStyle="#0d0f18";ctx.fillRect(0,0,W,H);
    // 砖块
    g.bricks.forEach(function(b){if(!b.alive)return;ctx.fillStyle=b.color;rr(ctx,b.x,b.y,b.w,b.h,5);ctx.fill();ctx.shadowColor=b.color;ctx.shadowBlur=10;ctx.fill();ctx.shadowBlur=0});
    // 挡板
    var pg=ctx.createLinearGradient(g.paddle.x,0,g.paddle.x+g.paddle.w,0);pg.addColorStop(0,"#7c5cff");pg.addColorStop(1,"#9d7dff");ctx.fillStyle=pg;rr(ctx,g.paddle.x,g.paddle.y,g.paddle.w,g.paddle.h,7);ctx.fill();
    // 球
    ctx.fillStyle="#fff";ctx.beginPath();ctx.arc(g.ball.x,g.ball.y,g.ball.r,0,Math.PI*2);ctx.fill();ctx.shadowColor="#fff";ctx.shadowBlur=15;ctx.fill();ctx.shadowBlur=0;
  }
  function loop(){
    if(destroyed||!g.running)return;
    // 键盘
    if(g.keys.left)g.paddle.x-=8;
    if(g.keys.right)g.paddle.x+=8;
    g.paddle.x=Math.max(0,Math.min(W-g.paddle.w,g.paddle.x));
    // 移动球
    g.ball.x+=g.ball.vx;g.ball.y+=g.ball.vy;
    // 边界
    if(g.ball.x<g.ball.r){g.ball.x=g.ball.r;g.ball.vx=-g.ball.vx}
    if(g.ball.x>W-g.ball.r){g.ball.x=W-g.ball.r;g.ball.vx=-g.ball.vx}
    if(g.ball.y<g.ball.r){g.ball.y=g.ball.r;g.ball.vy=-g.ball.vy}
    // 挡板
    if(g.ball.vy>0 && g.ball.y+g.ball.r>=g.paddle.y && g.ball.y-g.ball.r<=g.paddle.y+g.paddle.h && g.ball.x>=g.paddle.x && g.ball.x<=g.paddle.x+g.paddle.w){
      var hit=(g.ball.x-(g.paddle.x+g.paddle.w/2))/(g.paddle.w/2);
      var angle=hit*Math.PI/3;
      var speed=Math.min(9,Math.sqrt(g.ball.vx*g.ball.vx+g.ball.vy*g.ball.vy)*1.02);
      g.ball.vx=Math.sin(angle)*speed;
      g.ball.vy=-Math.cos(angle)*speed;
      g.ball.y=g.paddle.y-g.ball.r;
    }
    // 砖块碰撞
    for(var i=0;i<g.bricks.length;i++){
      var b=g.bricks[i];if(!b.alive)continue;
      if(g.ball.x+g.ball.r>b.x && g.ball.x-g.ball.r<b.x+b.w && g.ball.y+g.ball.r>b.y && g.ball.y-g.ball.r<b.y+b.h){
        b.alive=false;
        g.score+=b.pts;
        $("boScore").textContent=g.score;
        // 判断撞击方向
        var overlapX=Math.min(g.ball.x+g.ball.r-b.x,b.x+b.w-(g.ball.x-g.ball.r));
        var overlapY=Math.min(g.ball.y+g.ball.r-b.y,b.y+b.h-(g.ball.y-g.ball.r));
        if(overlapX<overlapY)g.ball.vx=-g.ball.vx;else g.ball.vy=-g.ball.vy;
        break;
      }
    }
    // 掉到底部
    if(g.ball.y-g.ball.r>H){
      g.lives--;
      $("boLives").textContent=g.lives;
      if(g.lives<=0){return over()}
      g.running=false;
      g.ball.x=W/2;g.ball.y=H-50;g.ball.vx=0;g.ball.vy=0;
      draw();
      return;
    }
    // 全部打完了？
    if(g.bricks.every(function(b){return !b.alive})){return over()}
    draw();
    requestAnimationFrame(loop);
  }
  function over(){
    g.running=false;
    api("POST","/api/score",{game:"breakout",score:g.score}).catch(function(){});
    var best=parseInt($("boBest").textContent,10)||0;if(g.score>best)$("boBest").textContent=g.score;
    showOv('<h2>游戏结束</h2><p>你的得分</p><div class="big-score">'+g.score+'</div><div class="row"><button class="btn btn-primary" id="ovR">再来一次</button><button class="btn btn-secondary" id="ovL">回大厅</button></div>');
    setTimeout(function(){var b=document.getElementById("ovR");if(b)b.addEventListener("click",function(){hideOv();reset()});var l=document.getElementById("ovL");if(l)l.addEventListener("click",function(){hideOv();go("lobby")})},0);
  }
  // 鼠标 / 触摸控制
  function movePaddle(clientX){
    var rect=cv.getBoundingClientRect();
    var x=(clientX-rect.left)/rect.width*W;
    g.paddle.x=Math.max(0,Math.min(W-g.paddle.w,x-g.paddle.w/2));
  }
  cv.addEventListener("mousemove",function(e){movePaddle(e.clientX)});
  cv.addEventListener("touchstart",function(e){e.preventDefault();movePaddle(e.touches[0].clientX);launch()},{passive:false});
  cv.addEventListener("touchmove",function(e){e.preventDefault();movePaddle(e.touches[0].clientX)},{passive:false});
  cv.addEventListener("click",function(){launch()});
  var kd=function(e){if(e.key==="ArrowLeft"||e.key==="a"||e.key==="A"){g.keys.left=true;e.preventDefault()}if(e.key==="ArrowRight"||e.key==="d"||e.key==="D"){g.keys.right=true;e.preventDefault()}if(e.key===" "){e.preventDefault();launch()}};
  var ku=function(e){if(e.key==="ArrowLeft"||e.key==="a"||e.key==="A")g.keys.left=false;if(e.key==="ArrowRight"||e.key==="d"||e.key==="D")g.keys.right=false};
  window.addEventListener("keydown",kd);window.addEventListener("keyup",ku);
  $("boRestart").addEventListener("click",reset);
  reset();
  api("GET","/api/leaderboard?game=breakout").then(function(r){if(r.list&&r.list.length){var mine=r.list.find(function(x){return x.username===state.username});if(mine)$("boBest").textContent=mine.score}}).catch(function(){});
  state.breakout={destroy:function(){destroyed=true;g.running=false;window.removeEventListener("keydown",kd);window.removeEventListener("keyup",ku)}}
}

/* ===== 五子棋 ===== */
function showGomokuLobby(){
  var m=$("main");
  m.innerHTML=head("⚫ 五子棋")+'<div class="room-panel"><div style="display:flex;gap:14px;flex-wrap:wrap;justify-content:space-between"><div><div style="font-size:13px;color:var(--muted);margin-bottom:6px;font-weight:600">创建房间，把房间号发给好友</div><button class="btn btn-primary" id="crBtn">创建新房间</button></div><div style="text-align:right"><div style="font-size:13px;color:var(--muted);margin-bottom:6px;font-weight:600">或输入房间号加入</div><div style="display:flex;gap:8px"><input class="input" id="jcIn" placeholder="6 位房间号" maxlength="6" style="width:130px;text-transform:lowercase"><button class="btn btn-secondary" id="jrBtn">加入</button></div></div></div></div></div>';
  backLobby();
  $("crBtn").addEventListener("click",function(){$("crBtn").disabled=true;api("POST","/api/room/create",{game:"gomoku"}).then(function(r){state.room={id:r.roomId,game:r.game};enterGomokuRoom()}).catch(function(err){toast(err.message);$("crBtn").disabled=false})});
  $("jrBtn").addEventListener("click",function(){var c=($("jcIn").value||"").trim().toLowerCase();if(!c){toast("请输入房间号");return}api("POST","/api/room/join",{roomId:c}).then(function(r){state.room={id:r.roomId,game:r.game};enterGomokuRoom()}).catch(function(err){toast(err.message)})});
  $("jcIn").addEventListener("keydown",function(e){if(e.key==="Enter")$("jrBtn").click()})
}
function enterGomokuRoom(){
  var m=$("main");
  m.innerHTML=head("⚫ 五子棋",'<span class="room-id" id="ridChip">----</span><button class="btn btn-secondary btn-sm" id="lvBtn">离开房间</button>')+
    '<div class="room-panel" id="preG"><div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:16px"><div style="font-size:14px;font-weight:600">房间号：<span id="ridTxt" style="color:var(--accent);letter-spacing:2px;font-family:ui-monospace,monospace"></span></div><div style="font-size:13px;color:var(--muted)">2 人对战 · 房主可开始</div></div><div style="font-size:13px;color:var(--muted);font-weight:600;margin-bottom:8px">当前玩家</div><div class="room-players" id="gPlayers"></div><div class="room-wait">等待房主开始游戏…</div><div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:8px"><button class="btn btn-primary" id="gStart" style="display:none">开始游戏</button></div></div>'+
    '<div class="gomoku-wrap hidden" id="gGame"><div class="stage" style="padding:10px"><canvas class="gomoku-canvas" id="gCanvas" width="600" height="600"></canvas></div><div class="gomoku-side"><h4 style="font-size:13px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);margin:0 0 10px">对局信息</h4><div class="gomoku-turn" id="gTurn"></div><div id="gInfo" style="font-size:13.5px;color:var(--muted);line-height:1.7"></div><button class="btn btn-primary btn-sm" id="gRestart" style="display:none;margin-top:16px;width:100%">再来一局</button></div></div>';
  $("backBtn").addEventListener("click",function(){api("POST","/api/room/leave",{roomId:state.room.id}).catch(function(){});go("lobby")});
  $("lvBtn").addEventListener("click",function(){api("POST","/api/room/leave",{roomId:state.room.id}).catch(function(){});go("lobby")});
  $("gStart").addEventListener("click",function(){api("POST","/api/room/action",{roomId:state.room.id,action:"start"}).catch(function(err){toast(err.message)})});
  $("gRestart").addEventListener("click",function(){api("POST","/api/room/action",{roomId:state.room.id,action:"restart"}).catch(function(err){toast(err.message)})});
  cgr()
}
function rgPlayers(ps,host){var el=$("gPlayers");if(!el)return;el.innerHTML=ps.map(function(p){return '<span class="player-chip'+(p===host?" host":"")+'"><span class="ava">'+esc(avaChar(p))+'</span>'+esc(p)+(p===state.username?" (我)":"")+'</span>'}).join("");var sb=$("gStart");if(sb)sb.style.display=(host===state.username&&ps.length>=2)?"":"none"}
function cgr(){
  if(state.es)state.es.close();
  var es=new EventSource("/api/room/events?room="+encodeURIComponent(state.room.id));
  state.es=es;
  es.addEventListener("init",function(e){var d=JSON.parse(e.data);state.room.game=d.game;state.room.host=d.host;state.room.players=d.players;var c=$("ridChip");if(c)c.textContent="#"+d.roomId.toUpperCase();var rt=$("ridTxt");if(rt)rt.textContent=d.roomId.toUpperCase();rgPlayers(d.players,d.host)});
  es.addEventListener("players",function(e){var d=JSON.parse(e.data);state.room.players=d.players;state.room.host=d.host;rgPlayers(d.players,d.host)});
  es.addEventListener("gomoku-start",function(e){var d=JSON.parse(e.data);var pg=$("preG"),gg=$("gGame");if(pg)pg.classList.add("hidden");if(gg)gg.classList.remove("hidden");initGC();drawG(d.state)});
  es.addEventListener("gomoku-move",function(e){drawG(JSON.parse(e.data).state)});
  es.addEventListener("gomoku-end",function(e){var d=JSON.parse(e.data);drawG(d.state);var win=d.winner===state.username;showOv('<h2>'+(win?"🎉 你赢了！":"😢 你输了")+'</h2><div class="row"><button class="btn btn-primary" id="ovR">再来一局</button><button class="btn btn-secondary" id="ovL">回大厅</button></div>');setTimeout(function(){var b=document.getElementById("ovR");if(b)b.addEventListener("click",function(){hideOv();api("POST","/api/room/action",{roomId:state.room.id,action:"restart"}).catch(function(err){toast(err.message)})});var l=document.getElementById("ovL");if(l)l.addEventListener("click",function(){hideOv();go("lobby")})},0)});
  es.addEventListener("gomoku-sync",function(e){var d=JSON.parse(e.data);var pg=$("preG"),gg=$("gGame");if(pg)pg.classList.add("hidden");if(gg)gg.classList.remove("hidden");initGC();drawG(d.state)});
  es.onerror=function(){}
}
var gcInited=false;
function initGC(){
  if(gcInited)return;gcInited=true;
  var cv=$("gCanvas");
  cv.addEventListener("click",function(e){
    if(!state.gomokuState||state.gomokuState.winner)return;
    var rect=cv.getBoundingClientRect();
    var x=e.clientX-rect.left,y=e.clientY-rect.top;
    var N=state.gomokuState.n;
    var cx=Math.round(x/rect.width*(N+1))-1,cy=Math.round(y/rect.height*(N+1))-1;
    if(cx<0||cx>=N||cy<0||cy>=N)return;
    api("POST","/api/room/action",{roomId:state.room.id,action:"place",x:cx,y:cy}).catch(function(err){toast(err.message)});
  });
}
function drawG(s){
  state.gomokuState=s;
  var cv=$("gCanvas");if(!cv)return;var ctx=cv.getContext("2d"),W=cv.width,H=cv.height,N=s.n;
  ctx.fillStyle="#d9b382";ctx.fillRect(0,0,W,H);
  var pad=W/(N+1);
  ctx.strokeStyle="rgba(60,30,10,.55)";ctx.lineWidth=1;
  for(var i=0;i<N;i++){
    var x=pad+(i+0.5)*pad;
    ctx.beginPath();ctx.moveTo(x,pad/2);ctx.lineTo(x,H-pad/2);ctx.stroke();
    var y=pad+(i+0.5)*pad;
    ctx.beginPath();ctx.moveTo(pad/2,y);ctx.lineTo(W-pad/2,y);ctx.stroke();
  }
  for(var i=0;i<N;i++)for(var j=0;j<N;j++){
    var v=s.board[i][j];if(!v)continue;
    var cx=pad+(i+0.5)*pad,cy=pad+(j+0.5)*pad,rr=pad*0.42;
    ctx.fillStyle=v===1?"#1a1a1a":"#f5f5f5";
    ctx.beginPath();ctx.arc(cx,cy,rr,0,Math.PI*2);ctx.fill();
    ctx.strokeStyle="rgba(0,0,0,.35)";ctx.lineWidth=1;ctx.stroke();
    if(s.lastMove&&s.lastMove.x===i&&s.lastMove.y===j){ctx.strokeStyle="#e06f92";ctx.lineWidth=3;ctx.stroke()}
  }
  var t=$("gTurn"),info=$("gInfo");
  if(t&&info){
    var myC=s.players[0]===state.username?1:(s.players[1]===state.username?2:0);
    if(s.winner){
      t.innerHTML='<span class="stone '+(s.winner===1?"black":"white")+'"></span>'+(s.winner===1?esc(s.players[0]):esc(s.players[1]))+' 获胜！';
      $("gRestart").style.display="";
    }else{
      t.innerHTML='<span class="stone '+(s.turn===1?"black":"white")+'"></span>'+(s.turn===1?"黑棋":"白棋")+'回合';
      var myTurn=(myC===s.turn);
      info.innerHTML='你执'+(myC===1?"黑棋":(myC===2?"白棋":"旁观"))+'<br>'+(myTurn?'<b style="color:var(--accent)">轮到你了</b>':"等待对手落子…");
      $("gRestart").style.display="none";
    }
  }
}

/* ===== 你画我猜 ===== */
function showDrawLobby(){
  var m=$("main");
  m.innerHTML=head("🎨 你画我猜")+'<div class="room-panel"><div style="display:flex;gap:14px;flex-wrap:wrap;justify-content:space-between"><div><div style="font-size:13px;color:var(--muted);margin-bottom:6px;font-weight:600">创建房间，把房间号发给好友</div><button class="btn btn-primary" id="crBtn">创建新房间</button></div><div style="text-align:right"><div style="font-size:13px;color:var(--muted);margin-bottom:6px;font-weight:600">或输入房间号加入</div><div style="display:flex;gap:8px"><input class="input" id="jcIn" placeholder="6 位房间号" maxlength="6" style="width:130px;text-transform:lowercase"><button class="btn btn-secondary" id="jrBtn">加入</button></div></div></div></div></div>';
  backLobby();
  $("crBtn").addEventListener("click",function(){$("crBtn").disabled=true;api("POST","/api/room/create",{game:"draw"}).then(function(r){state.room={id:r.roomId,game:r.game};enterDrawRoom()}).catch(function(err){toast(err.message);$("crBtn").disabled=false})});
  $("jrBtn").addEventListener("click",function(){var c=($("jcIn").value||"").trim().toLowerCase();if(!c){toast("请输入房间号");return}api("POST","/api/room/join",{roomId:c}).then(function(r){state.room={id:r.roomId,game:r.game};enterDrawRoom()}).catch(function(err){toast(err.message)})});
  $("jcIn").addEventListener("keydown",function(e){if(e.key==="Enter")$("jrBtn").click()})
}
function enterDrawRoom(){
  var m=$("main");
  m.innerHTML=head("🎨 你画我猜",'<span class="room-id" id="ridChip">----</span><button class="btn btn-secondary btn-sm" id="lvBtn">离开房间</button>')+
    '<div class="room-panel" id="preG"><div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:16px"><div style="font-size:14px;font-weight:600">房间号：<span id="ridTxt" style="color:var(--accent);letter-spacing:2px;font-family:ui-monospace,monospace"></span></div><div style="font-size:13px;color:var(--muted)">至少 2 人 · 房主可开始</div></div><div style="font-size:13px;color:var(--muted);font-weight:600;margin-bottom:8px">当前玩家</div><div class="room-players" id="dPlayers"></div><div class="room-wait">等待房主开始游戏…</div><div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:8px"><button class="btn btn-primary" id="dStart" style="display:none">开始游戏</button></div></div>'+
    '<div class="draw-wrap hidden" id="dGame">'+
      '<div class="draw-main">'+
        '<div class="draw-info"><div class="draw-word">词语提示：<span class="hint" id="dHint">_ _ _</span></div><div class="draw-timer">⏱ <span id="dTimer">60</span>s</div></div>'+
        '<canvas class="draw-canvas" id="dCanvas" width="800" height="500"></canvas>'+
        '<div class="draw-tools" id="dTools" style="display:none">'+
          '<button class="color-btn on" data-color="#1a1a1a" style="background:#1a1a1a"></button>'+
          '<button class="color-btn" data-color="#e06f92" style="background:#e06f92"></button>'+
          '<button class="color-btn" data-color="#7c5cff" style="background:#7c5cff"></button>'+
          '<button class="color-btn" data-color="#5fd28f" style="background:#5fd28f"></button>'+
          '<button class="color-btn" data-color="#f5c96b" style="background:#f5c96b"></button>'+
          '<button class="color-btn" data-color="#3b82f6" style="background:#3b82f6"></button>'+
          '<span style="flex:1"></span>'+
          '<button class="btn btn-secondary btn-sm" id="dClear" type="button">清空</button>'+
        '</div>'+
      '</div>'+
      '<div class="draw-side">'+
        '<h4>聊天 / 猜词</h4>'+
        '<div class="guess-list" id="dGuesses"></div>'+
        '<form class="guess-form" id="dGuessForm" autocomplete="off">'+
          '<input class="input" id="dGuessInput" placeholder="输入猜测…" maxlength="20">'+
          '<button class="btn btn-primary btn-sm" type="submit">发送</button>'+
        '</form>'+
      '</div>'+
    '</div>';
  $("backBtn").addEventListener("click",function(){api("POST","/api/room/leave",{roomId:state.room.id}).catch(function(){});go("lobby")});
  $("lvBtn").addEventListener("click",function(){api("POST","/api/room/leave",{roomId:state.room.id}).catch(function(){});go("lobby")});
  $("dStart").addEventListener("click",function(){api("POST","/api/room/action",{roomId:state.room.id,action:"start"}).catch(function(err){toast(err.message)})});
  cdr()
}
function rdPlayers(ps,host){var el=$("dPlayers");if(!el)return;el.innerHTML=ps.map(function(p){return '<span class="player-chip'+(p===host?" host":"")+'"><span class="ava">'+esc(avaChar(p))+'</span>'+esc(p)+(p===state.username?" (我)":"")+'</span>'}).join("");var sb=$("dStart");if(sb)sb.style.display=(host===state.username&&ps.length>=2)?"":"none"}
var dInited=false;
function cdr(){
  if(state.es)state.es.close();
  var es=new EventSource("/api/room/events?room="+encodeURIComponent(state.room.id));
  state.es=es;
  state.drawData={strokes:[],color:"#1a1a1a",drawing:false,isDrawer:false};
  es.addEventListener("init",function(e){var d=JSON.parse(e.data);state.room.game=d.game;state.room.host=d.host;state.room.players=d.players;var c=$("ridChip");if(c)c.textContent="#"+d.roomId.toUpperCase();var rt=$("ridTxt");if(rt)rt.textContent=d.roomId.toUpperCase();rdPlayers(d.players,d.host)});
  es.addEventListener("players",function(e){var d=JSON.parse(e.data);state.room.players=d.players;state.room.host=d.host;rdPlayers(d.players,d.host)});
  es.addEventListener("draw-start",function(e){
    var d=JSON.parse(e.data);
    var pg=$("preG"),dg=$("dGame");
    if(pg)pg.classList.add("hidden");if(dg)dg.classList.remove("hidden");
    if(!dInited){initDC();dInited=true}
    state.drawData.strokes=[];
    state.drawData.isDrawer=(d.drawer===state.username);
    clearDC();
    $("dHint").textContent=d.wordLength?"_ ".repeat(d.wordLength).trim():"_";
    $("dTimer").textContent=d.timeLeft;
    $("dTools").style.display=state.drawData.isDrawer?"":"none";
    $("dGuesses").innerHTML="";
    addDG({sys:true,text:"第 "+d.round+"/"+d.maxRounds+" 轮开始，画手："+d.drawer+(state.drawData.isDrawer?" （你）":"")});
    if(state.drawData.isDrawer)addDG({sys:true,text:"你要画的是：「"+d.word+"」"});
  });
  es.addEventListener("draw-tick",function(e){var t=$("dTimer");if(t)t.textContent=JSON.parse(e.data).timeLeft});
  es.addEventListener("draw-stroke",function(e){var s=JSON.parse(e.data);state.drawData.strokes.push(s);drawStroke(s)});
  es.addEventListener("draw-clear",function(){state.drawData.strokes=[];clearDC()});
  es.addEventListener("draw-guess",function(e){var d=JSON.parse(e.data);addDG(d.guess)});
  es.addEventListener("draw-reveal",function(e){var d=JSON.parse(e.data);addDG({sys:true,text:"本轮答案：「"+d.word+"」"})});
  es.addEventListener("draw-end",function(e){
    var d=JSON.parse(e.data);
    var myScore=d.scores[state.username]||0;
    showOv('<h2>游戏结束</h2><p>你的总分</p><div class="big-score">'+myScore+'</div><div class="row"><button class="btn btn-primary" id="ovR">再来一局</button><button class="btn btn-secondary" id="ovL">回大厅</button></div>');
    setTimeout(function(){var b=document.getElementById("ovR");if(b)b.addEventListener("click",function(){hideOv();var pg=$("preG"),dg=$("dGame");if(pg)pg.classList.remove("hidden");if(dg)dg.classList.add("hidden")});var l=document.getElementById("ovL");if(l)l.addEventListener("click",function(){hideOv();go("lobby")})},0);
  });
  es.addEventListener("draw-sync",function(e){
    var d=JSON.parse(e.data);
    var pg=$("preG"),dg=$("dGame");
    if(pg)pg.classList.add("hidden");if(dg)dg.classList.remove("hidden");
    if(!dInited){initDC();dInited=true}
    state.drawData.isDrawer=(d.drawer===state.username);
    state.drawData.strokes=d.strokes||[];
    clearDC();state.drawData.strokes.forEach(drawStroke);
    $("dHint").textContent=d.wordLength?"_ ".repeat(d.wordLength).trim():"_";
    $("dTimer").textContent=d.timeLeft;
    $("dTools").style.display=state.drawData.isDrawer?"":"none";
  });
  es.onerror=function(){}
}
function addDG(g){
  var list=$("dGuesses");if(!list)return;
  var div=document.createElement("div");
  if(g.sys){div.className="guess-item sys";div.textContent=g.text}
  else{div.className="guess-item"+(g.correct?" correct":"");div.innerHTML='<span class="who">'+esc(g.username)+'</span>'+esc(g.text)+(g.correct?" ✓":"")}
  list.appendChild(div);list.scrollTop=list.scrollHeight;
}
function clearDC(){var cv=$("dCanvas");if(!cv)return;var ctx=cv.getContext("2d");ctx.fillStyle="#fff";ctx.fillRect(0,0,cv.width,cv.height)}
function drawStroke(s){
  var cv=$("dCanvas");if(!cv)return;var ctx=cv.getContext("2d"),W=cv.width,H=cv.height;
  ctx.strokeStyle=s.color||"#1a1a1a";ctx.lineWidth=(s.w||3)*(W/800);ctx.lineCap="round";ctx.lineJoin="round";
  ctx.beginPath();ctx.moveTo(s.x1*W,s.y1*H);ctx.lineTo(s.x2*W,s.y2*H);ctx.stroke();
}
function initDC(){
  var cv=$("dCanvas");if(!cv)return;clearDC();
  var last=null;
  function pos(e){
    var rect=cv.getBoundingClientRect();
    var cx,cy;
    if(e.touches&&e.touches[0]){cx=e.touches[0].clientX;cy=e.touches[0].clientY}
    else{cx=e.clientX;cy=e.clientY}
    return {x:(cx-rect.left)/rect.width,y:(cy-rect.top)/rect.height};
  }
  function send(x1,y1,x2,y2){
    api("POST","/api/room/action",{roomId:state.room.id,action:"stroke",x1:x1,y1:y1,x2:x2,y2:y2,color:state.drawData.color,w:3}).catch(function(){});
  }
  function onDown(e){
    if(!state.drawData.isDrawer)return;
    e.preventDefault();
    state.drawData.drawing=true;
    last=pos(e);
  }
  function onMove(e){
    if(!state.drawData.drawing||!state.drawData.isDrawer)return;
    e.preventDefault();
    var p=pos(e);
    if(last){
      var st={x1:last.x,y1:last.y,x2:p.x,y2:p.y,color:state.drawData.color,w:3};
      drawStroke(st);
      send(st.x1,st.y1,st.x2,st.y2);
    }
    last=p;
  }
  function onUp(){state.drawData.drawing=false;last=null}
  cv.addEventListener("mousedown",onDown);
  cv.addEventListener("mousemove",onMove);
  window.addEventListener("mouseup",onUp);
  cv.addEventListener("touchstart",onDown,{passive:false});
  cv.addEventListener("touchmove",onMove,{passive:false});
  cv.addEventListener("touchend",onUp);
  document.querySelectorAll(".color-btn").forEach(function(b){
    b.addEventListener("click",function(){
      document.querySelectorAll(".color-btn").forEach(function(x){x.classList.remove("on")});
      b.classList.add("on");
      state.drawData.color=b.getAttribute("data-color");
    });
  });
  var cb=$("dClear");
  if(cb){
    cb.addEventListener("click",function(){
      if(!state.drawData.isDrawer)return;
      api("POST","/api/room/action",{roomId:state.room.id,action:"clear"}).catch(function(){});
    });
  }
  var gf=$("dGuessForm");
  if(gf){
    gf.addEventListener("submit",function(e){
      e.preventDefault();
      var inp=$("dGuessInput");
      var text=inp.value.trim();
      if(!text)return;
      inp.value="";
      api("POST","/api/room/action",{roomId:state.room.id,action:"guess",text:text}).catch(function(err){toast(err.message)});
    });
  }
}

api("GET","/api/me").then(function(r){if(r.authed){state.username=r.username;enterApp()}}).catch(function(){});
})();
</script></body></html>`;

server.listen(PORT, () => {
  console.log('[games] 欢乐小游戏运行中 http://0.0.0.0:' + PORT);
});
