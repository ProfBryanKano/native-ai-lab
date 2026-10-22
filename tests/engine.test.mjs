import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.mjs';

function setup(options = {}, count = 2) {
  const e = new Engine();
  const id = e.create({ name: 'Test', cycles: 1, ...options }).id;
  const creds = Array.from({ length: count }, (_, i) => e.addPlayer(id, { name: `Agent ${i}`, model: `test/model-${i}` }));
  return { e, id, creds };
}
function talk(e, id) {
  while (e.view(id).phase === 'discussion') {
    const v = e.view(id);
    e.say(id, v.speaker, { round: v.round, turn: v.turn, message: 'Proponho cooperação para esta rodada.', to: 'all' });
  }
}

test('conversation is addressed, shared, turn-locked, and precedes decisions', () => {
  const { e, id, creds: [a, b] } = setup();
  e.control(id, 'start');
  assert.throws(() => e.decide(id, a.player.id, { round: 1, action: 'defect' }));
  assert.throws(() => e.say(id, b.player.id, { round: 1, turn: 0, message: 'out of turn' }));
  e.say(id, a.player.id, { round: 1, turn: 0, message: 'B, vamos cooperar?', to: b.player.id });
  const v = e.view(id, b.player.id);
  assert.equal(v.events.at(-1).content, 'B, vamos cooperar?');
  assert.equal(v.events.at(-1).to, b.player.id);
  assert.equal(v.canSpeak, true);
  assert.throws(() => e.say(id, b.player.id, { round: 1, turn: 0, message: 'stale' }));
  e.say(id, b.player.id, { round: 1, turn: 1, message: 'A, aceito seu acordo.' });
  assert.equal(e.view(id).phase, 'decision'); e.close();
});

for (const [aAction, bAction, expected] of [['cooperate', 'cooperate', [3, 3]], ['cooperate', 'defect', [0, 5]], ['defect', 'cooperate', [5, 0]], ['defect', 'defect', [1, 1]]]) {
  test(`payoffs ${aAction}/${bAction} and simultaneous secrecy`, () => {
    const { e, id, creds: [a, b] } = setup({ maxRounds: 1, target: 5 }); e.control(id, 'start'); talk(e, id);
    e.decide(id, a.player.id, { round: 1, action: aAction });
    assert.equal(e.view(id, b.player.id).you.ownAction, null);
    assert.equal(e.view(id, a.player.id).you.ownAction, aAction);
    assert.equal(e.view(id).events.some(x => x.type === 'round_result'), false);
    assert.equal(JSON.stringify(e.view(id)).includes('tokenHash'), false);
    const pending = JSON.stringify(e.view(id));
    e.decide(id, a.player.id, { round: 1, action: aAction });
    assert.equal(e.view(id).round, 1);
    assert.throws(() => e.decide(id, a.player.id, { round: 1, action: aAction === 'cooperate' ? 'defect' : 'cooperate' }));
    assert.ok(pending);
    e.decide(id, b.player.id, { round: 1, action: bAction });
    const v = e.view(id); assert.equal(v.status, 'finished');
    assert.deepEqual([v.players.find(p => p.id === a.player.id).score, v.players.find(p => p.id === b.player.id).score], expected);
    assert.deepEqual(v.events.find(x => x.type === 'round_result').actions, { [a.player.id]: aAction, [b.player.id]: bAction });
    e.close();
  });
}

test('three-player pairwise scoring and official winner reaches every player', () => {
  const { e, id, creds: [a, b, c] } = setup({ target: 10 }, 3);
  e.control(id, 'start'); talk(e, id);
  for (const p of [a, b, c]) e.decide(id, p.player.id, { round: 1, action: p === b ? 'defect' : 'cooperate' });
  assert.equal(e.view(id).winner, b.player.id);
  assert.deepEqual(e.view(id).players.map(p => p.score), [3, 10, 3]);
  for (const p of [a, b, c]) {
    const v = e.view(id, p.player.id); assert.equal(v.events.find(x => x.type === 'result').winner, b.player.id);
    e.acknowledge(id, p.player.id, { message: 'Meridian venceu. Recebi o resultado.' });
    e.acknowledge(id, p.player.id, { message: 'duplicate' });
  }
  assert.equal(e.view(id).acknowledgements.length, 3);
  assert.equal(e.view(id).events.filter(x => x.type === 'reaction').length, 3);
  assert.throws(() => e.decide(id, a.player.id, { round: 1, action: 'defect' })); e.close();
});

test('a tied threshold continues; the cap produces draw without fabricating a winner', () => {
  const { e, id, creds } = setup({ target: 5, maxRounds: 2 }); e.control(id, 'start');
  for (let r = 1; r <= 2; r++) { talk(e, id); for (const c of creds) e.decide(id, c.player.id, { round: r, action: 'cooperate' }); }
  assert.equal(e.view(id).outcome, 'draw'); assert.equal(e.view(id).winner, null); e.close();
});

test('a unique leader below target at cap is not called a winner', () => {
  const { e, id, creds: [a, b] } = setup({ target: 20, maxRounds: 1 }); e.control(id, 'start'); talk(e, id);
  e.decide(id, a.player.id, { round: 1, action: 'defect' }); e.decide(id, b.player.id, { round: 1, action: 'cooperate' });
  assert.equal(e.view(id).outcome, 'draw'); e.close();
});

test('token rotation revokes credentials; public projections never expose hashes', () => {
  const { e, id, creds: [a] } = setup();
  assert.equal(e.authenticate(a.token).playerId, a.player.id);
  const rotated = e.rotate(id, a.player.id); assert.throws(() => e.authenticate(a.token));
  assert.equal(e.authenticate(rotated.token).playerId, a.player.id);
  for (const view of [e.list(), e.view(id), e.view(id, a.player.id)]) { assert.ok(!JSON.stringify(view).includes(rotated.token)); assert.ok(!JSON.stringify(view).includes('tokenHash')); }
  e.close();
});

test('pause blocks actions; stop erases pending choices and preserves transcript', () => {
  const { e, id, creds: [a] } = setup(); e.control(id, 'start'); e.control(id, 'pause');
  assert.throws(() => e.say(id, a.player.id, { round: 1, turn: 0, message: 'blocked' }));
  e.control(id, 'resume'); talk(e, id); e.decide(id, a.player.id, { round: 1, action: 'defect' }); e.control(id, 'stop');
  const v = e.view(id); assert.deepEqual(v.submitted, []); assert.equal(v.outcome, 'stopped'); assert.equal(v.winner, null); assert.ok(v.events.some(e => e.type === 'message')); e.close();
});

test('old submissions cannot contaminate the next round; first speaker rotates', () => {
  const { e, id, creds: [a, b] } = setup(); e.control(id, 'start'); talk(e, id);
  for (const p of [a, b]) e.decide(id, p.player.id, { round: 1, action: 'cooperate' });
  assert.equal(e.view(id).speaker, b.player.id);
  assert.throws(() => e.decide(id, a.player.id, { round: 1, action: 'defect' })); e.close();
});
