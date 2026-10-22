import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ADMIN = 'test-only-admin-token-at-least-24-characters';
async function start(t, options = {}) {
  const app = createApp({ adminToken: ADMIN, ...options }); app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const url = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { app.server.closeAllConnections(); await new Promise(r => app.server.close(r)); app.engine.close(); });
  return { ...app, url };
}

test('browser access requires auth; cookies are HttpOnly; CSRF and static path traversal rejected', async t => {
  const { url } = await start(t);
  assert.equal((await fetch(url + '/health')).status, 200);
  assert.equal((await fetch(url + '/api/matches')).status, 401);
  const login = await fetch(url + '/api/login', { method: 'POST', body: JSON.stringify({ token: ADMIN }) });
  const cookie = login.headers.get('set-cookie'); assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
  assert.equal((await fetch(url + '/api/matches', { headers: { cookie } })).status, 200);
  assert.equal((await fetch(url + '/api/matches', { headers: { cookie, Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(url + '/src/server.mjs')).status, 404);
  assert.equal((await fetch(url + '/.env')).status, 404);
  const home = await fetch(url); assert.match(home.headers.get('content-security-policy'), /script-src 'self'/); assert.match(await home.text(), /ACCORD/);
});

test('MCP initialize, discovery and call scope; invalid tokens rejected; rivals cannot steal actions', async t => {
  const { engine, url } = await start(t);
  const id = engine.create({ name: 'HTTP game', cycles: 1 }).id;
  const a = engine.addPlayer(id, { name: 'A', model: 'test/a' }), b = engine.addPlayer(id, { name: 'B', model: 'test/b' });
  async function rpc(token, method, params = {}) {
    const res = await fetch(url + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return { status: res.status, data: await res.json() };
  }
  assert.equal((await rpc('wrong', 'initialize')).status, 401);
  const init = await rpc(a.token, 'initialize', { protocolVersion: '2025-11-25' }); assert.equal(init.data.result.protocolVersion, '2025-11-25');
  assert.ok(engine.view(id).players.find(p => p.id === a.player.id).connectedAt);
  assert.equal((await rpc(a.token, 'tools/list')).data.result.tools.length, 4);
  engine.control(id, 'start');
  const spoof = await rpc(b.token, 'tools/call', { name: 'arena_say', arguments: { round: 1, turn: 0, playerId: a.player.id, message: 'Spoof' } });
  assert.equal(spoof.data.result.isError, true);
  await rpc(a.token, 'tools/call', { name: 'arena_say', arguments: { round: 1, turn: 0, message: 'Olá, B. Cooperamos?' } });
  const view = await rpc(b.token, 'tools/call', { name: 'arena_view' }); const data = JSON.parse(view.data.result.content[0].text);
  assert.equal(data.you.id, b.player.id); assert.equal(data.events.at(-1).content, 'Olá, B. Cooperamos?');
  assert.equal((await fetch(url + '/mcp', { headers: { Authorization: 'Bearer ' + a.token } })).status, 405);
  const malformed = await fetch(url + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + a.token }, body: '{' });
  assert.equal((await malformed.json()).error.code, -32700);
});

test('SQLite survives server restart and private projections remain secret', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'accord-test-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'arena.sqlite');
  const first = createApp({ adminToken: ADMIN, dbPath });
  const id = first.engine.create({ name: 'Persisted' }).id;
  const credential = first.engine.addPlayer(id, { name: 'Persistent', model: 'test/model' }); first.engine.close();
  const second = await start(t, { dbPath });
  assert.equal(second.engine.authenticate(credential.token).matchId, id);
  assert.equal(second.engine.view(id).name, 'Persisted');
  assert.ok(!JSON.stringify(second.engine.view(id)).includes('tokenHash'));
});

test('Python executor plays a complete MCP conversation and all agents acknowledge the winner', async t => {
  const { url, engine } = await start(t);
  const runner = fileURLToPath(new URL('../runner/run.py', import.meta.url));
  const child = spawn('python3', [runner, '--demo', url, '--interval', '0.1', '--max-wait', '10'], { env: { ...process.env, ACCORD_ADMIN_TOKEN: ADMIN }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { errors += data; });
  const timer = setTimeout(() => child.kill(), 15000);
  const [code] = await once(child, 'exit'); clearTimeout(timer);
  assert.equal(code, 0, errors + output);
  const game = engine.view(engine.list()[0].id);
  assert.equal(game.outcome, 'winner');
  assert.equal(game.players.find(p => p.id === game.winner).name, 'Meridian');
  assert.equal(game.events.filter(e => e.type === 'message').length, 6);
  assert.equal(game.acknowledgements.length, 3);
  assert.equal(game.events.filter(e => e.type === 'reaction').length, 3);
  assert.ok(game.events.filter(e => e.type === 'message').every(e => e.content.includes('[SIMULAÇÃO]')));
  assert.match(output, /0 chamadas/);
});
