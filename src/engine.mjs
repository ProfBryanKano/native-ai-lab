import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class ArenaError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (message, status) => { throw new ArenaError(message, status); };
const integer = (x, min, max, fallback) => {
  const v = x ?? fallback;
  if (!Number.isInteger(v) || v < min || v > max) fail(`Valor deve ser inteiro entre ${min} e ${max}.`);
  return v;
};
const text = (s, max, label) => {
  if (typeof s !== 'string' || !s.trim() || s.length > max) fail(`${label}: informe de 1 a ${max} caracteres.`);
  return s.trim();
};
export const RULES = {
  game: 'Dilema repetido entre todos os pares',
  payoff: { 'cooperate/cooperate': [3, 3], 'cooperate/defect': [0, 5], 'defect/cooperate': [5, 0], 'defect/defect': [1, 1] },
  objective: 'Ganhe pontos contra cada adversário. Ao final de uma rodada, o líder único que alcançar a meta vence. Empates na liderança continuam até o limite de rodadas; no limite, empate é declarado.',
  discussion: 'Conversa pública em turnos antes de decisões simultâneas e privadas. Promessas não são vinculantes. Uma ação vale contra todos os adversários. As decisões só são reveladas quando todos entregarem.',
  timeout: 'Não há ação automática por tempo. Um agente desconectado pode ser reconectado com o mesmo token. O operador pode pausar, trocar o token ou encerrar sem vencedor.'
};

export class Engine {
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS matches (id TEXT PRIMARY KEY, state TEXT NOT NULL);');
  }
  close() { this.db.close(); }
  list() { return this.db.prepare('SELECT state FROM matches ORDER BY rowid DESC').all().map(r => this.summary(JSON.parse(r.state))); }
  load(id) {
    const row = this.db.prepare('SELECT state FROM matches WHERE id=?').get(id);
    if (!row) fail('Partida não encontrada.', 404);
    return JSON.parse(row.state);
  }
  save(g) {
    this.db.prepare('INSERT INTO matches(id,state) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state').run(g.id, JSON.stringify(g));
  }
  mutate(id, fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const g = this.load(id); const result = fn(g); g.revision++; this.save(g); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  event(g, type, actor, content, extra = {}) {
    g.events.push({ id: g.events.length + 1, type, actor, content, round: g.round, at: new Date().toISOString(), ...extra });
  }
  summary(g) {
    return { id: g.id, name: g.name, status: g.status, phase: g.phase, round: g.round, target: g.target,
      maxRounds: g.maxRounds, cycles: g.cycles, turn: g.turn, revision: g.revision, createdAt: g.createdAt,
      players: g.players.map(({ tokenHash, ...p }) => p), winner: g.winner, outcome: g.outcome,
      speaker: g.phase === 'discussion' && g.status === 'running' ? g.players[g.turn % g.players.length]?.id : null };
  }
  view(id, playerId = null) {
    const g = this.load(id);
    const p = playerId ? g.players.find(p => p.id === playerId) : null;
    if (playerId && !p) fail('Agente não pertence à partida.', 403);
    return { ...this.summary(g), rules: RULES, events: g.events,
      submitted: Object.keys(g.actions), acknowledgements: g.acknowledgements,
      you: p ? { id: p.id, name: p.name, model: p.model, score: p.score,
        ownAction: g.actions[p.id] ?? null, acknowledged: g.acknowledgements.includes(p.id) } : null,
      canSpeak: !!p && g.status === 'running' && g.phase === 'discussion' && g.players[g.turn % g.players.length]?.id === p.id,
      canDecide: !!p && g.status === 'running' && g.phase === 'decision' && !g.actions[p.id] };
  }
  create(input) {
    const g = { id: randomUUID(), name: text(input.name || 'Nova sessão', 80, 'Nome'), status: 'lobby', phase: 'discussion',
      target: integer(input.target, 5, 500, 30), maxRounds: integer(input.maxRounds, 1, 100, 20),
      cycles: integer(input.cycles, 1, 5, 2), round: 1, turn: 0, players: [], actions: {}, events: [],
      revision: 0, winner: null, outcome: null, acknowledgements: [], createdAt: new Date().toISOString() };
    this.event(g, 'system', 'system', 'Sessão criada. Conecte entre 2 e 6 agentes.');
    this.save(g); return this.view(g.id);
  }
  addPlayer(id, input) {
    return this.mutate(id, g => {
      if (g.status !== 'lobby') fail('Cadastros fechados após iniciar.');
      if (g.players.length >= 6) fail('Limite de 6 agentes.');
      const name = text(input.name, 40, 'Nome do agente');
      if (g.players.some(p => p.name.toLowerCase() === name.toLowerCase())) fail('Nome já cadastrado.');
      const token = randomBytes(32).toString('base64url');
      const p = { id: randomUUID(), name, model: text(input.model, 120, 'Modelo'), score: 0,
        tokenHash: hash(token), connectedAt: null };
      g.players.push(p); this.event(g, 'system', 'system', `${p.name} entrou na sessão.`);
      return { player: { id: p.id, name: p.name, model: p.model }, token, matchId: id };
    });
  }
  authenticate(token) {
    if (!token) fail('Token de agente obrigatório.', 401);
    const digest = hash(token);
    for (const row of this.db.prepare('SELECT state FROM matches').all()) {
      const g = JSON.parse(row.state); const p = g.players.find(p => p.tokenHash === digest);
      if (p) return { matchId: g.id, playerId: p.id };
    }
    fail('Token inválido ou revogado.', 401);
  }
  connect(id, playerId) {
    return this.mutate(id, g => { g.players.find(p => p.id === playerId).connectedAt = new Date().toISOString(); return { connected: true }; });
  }
  rotate(id, playerId) {
    return this.mutate(id, g => {
      const p = g.players.find(p => p.id === playerId); if (!p) fail('Agente não encontrado.', 404);
      const token = randomBytes(32).toString('base64url'); p.tokenHash = hash(token); p.connectedAt = null;
      return { token, matchId: id, player: { id: p.id, name: p.name, model: p.model } };
    });
  }
  control(id, command) {
    this.mutate(id, g => {
      if (command === 'start' && g.status === 'lobby') {
        if (g.players.length < 2) fail('Cadastre pelo menos 2 agentes.');
        g.status = 'running'; this.event(g, 'system', 'system', 'A negociação começou. O objetivo de cada agente é vencer.');
      } else if (command === 'pause' && g.status === 'running') g.status = 'paused';
      else if (command === 'resume' && g.status === 'paused') g.status = 'running';
      else if (command === 'stop' && ['running', 'paused', 'lobby'].includes(g.status)) {
        g.status = 'finished'; g.phase = 'finished'; g.outcome = 'stopped'; g.actions = {};
        this.event(g, 'result', 'system', 'Sessão encerrada pelo operador, sem vencedor.');
      } else fail('Comando não permitido neste estado.', 409);
    }); return this.view(id);
  }
  say(id, playerId, input) {
    this.mutate(id, g => {
      if (g.status !== 'running' || g.phase !== 'discussion') fail('Não é a fase de conversa.', 409);
      if (input.round !== g.round || input.turn !== g.turn) fail('Turno desatualizado. Consulte arena_view.', 409);
      if (g.players[g.turn % g.players.length]?.id !== playerId) fail('Espere seu turno de fala.', 409);
      const target = input.to || 'all';
      if (target !== 'all' && (!g.players.some(p => p.id === target) || target === playerId)) fail('Destinatário inválido.');
      const message = text(input.message, 1800, 'Mensagem');
      this.event(g, 'message', playerId, message, { to: target });
      g.turn++;
      if (g.turn >= g.players.length * g.cycles) {
        g.phase = 'decision'; this.event(g, 'system', 'system', 'Conversa encerrada. Cada agente entrega sua decisão privada.');
      }
    }); return this.view(id, playerId);
  }
  decide(id, playerId, input) {
    this.mutate(id, g => {
      if (input.round !== g.round) fail('Rodada desatualizada.', 409);
      if (g.status !== 'running' || g.phase !== 'decision') fail('Não é a fase de decisão.', 409);
      if (!['cooperate', 'defect'].includes(input.action)) fail('Ação inválida.');
      if (g.actions[playerId]) {
        if (g.actions[playerId] === input.action) return; // safe replay while this round is pending
        fail('A decisão já foi entregue e não pode ser alterada.', 409);
      }
      if (!g.players.some(p => p.id === playerId)) fail('Agente inválido.', 403);
      g.actions[playerId] = input.action;
      if (Object.keys(g.actions).length === g.players.length) this.resolve(g);
    }); return this.view(id, playerId);
  }
  resolve(g) {
    const delta = Object.fromEntries(g.players.map(p => [p.id, 0]));
    for (let i = 0; i < g.players.length; i++) for (let j = i + 1; j < g.players.length; j++) {
      const a = g.players[i], b = g.players[j];
      const [x, y] = RULES.payoff[`${g.actions[a.id]}/${g.actions[b.id]}`];
      delta[a.id] += x; delta[b.id] += y;
    }
    for (const p of g.players) p.score += delta[p.id];
    this.event(g, 'round_result', 'system', `Rodada ${g.round} apurada. Decisões reveladas.`, { actions: { ...g.actions }, delta });
    const sorted = [...g.players].sort((a, b) => b.score - a.score);
    const unique = sorted[0].score > sorted[1].score;
    if ((unique && sorted[0].score >= g.target) || g.round >= g.maxRounds) {
      g.status = 'finished'; g.phase = 'finished';
      // Reaching the round cap does not award a win below the stated target.
      g.winner = unique && sorted[0].score >= g.target ? sorted[0].id : null;
      g.outcome = g.winner ? 'winner' : 'draw';
      const announcement = g.winner ? `${sorted[0].name} venceu com ${sorted[0].score} pontos. Resultado oficial revelado a todos os agentes.` : 'Limite de rodadas alcançado sem vencedor único acima da meta. Empate declarado.';
      this.event(g, 'result', 'system', announcement, { winner: g.winner, scores: Object.fromEntries(g.players.map(p => [p.id, p.score])) });
    } else {
      g.round++; g.turn = 0; g.phase = 'discussion';
      // Rotate the first speaker each round to distribute the conversation advantage.
      g.players.push(g.players.shift());
      this.event(g, 'system', 'system', `Rodada ${g.round}. A negociação está aberta.`);
    }
    g.actions = {};
  }
  acknowledge(id, playerId, input) {
    this.mutate(id, g => {
      if (g.status !== 'finished') fail('Partida ainda não terminou.', 409);
      if (g.acknowledgements.includes(playerId)) return;
      this.event(g, 'reaction', playerId, text(input.message, 1000, 'Reação'));
      g.acknowledgements.push(playerId);
    }); return { received: true };
  }
}
