import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, groupAnswers, similar } from '../src/match.js';
import { newRoom, addPlayer, apply, view, tick, setConnected } from '../src/game.js';

test('normalize', () => {
  assert.equal(normalize('The Beatles!'), 'beatle');
  assert.equal(normalize('  BANANAS '), 'banana');
  assert.equal(normalize('Pokémon'), 'pokemon');
  assert.equal(normalize('Seven'), '7');
  assert.equal(normalize("McDonald's"), 'mcdonald');
  assert.equal(normalize('glass'), 'glass');
  assert.equal(normalize('cherries'), 'cherry');
});

test('similar / typos', () => {
  assert.ok(similar('banana', 'bananna'));
  assert.ok(similar('strawberry', 'strawbery'));
  assert.ok(similar('ice cream', 'icecream'));
  assert.ok(!similar('cat', 'car'));
  assert.ok(!similar('red', 'rod'));
  assert.ok(!similar('lion', 'loin'));
});

test('groupAnswers', () => {
  const g = groupAnswers({ a: 'Apple', b: 'apples', c: 'Banana', d: 'APPLE!', e: 'bananna', f: 'Kiwi', g: '' });
  assert.equal(g.length, 3);
  assert.deepEqual(g[0].members.sort(), ['a', 'b', 'd']);
  assert.equal(g[0].label, 'Apple');
  assert.deepEqual(g[1].members.sort(), ['c', 'e']);
  assert.deepEqual(g[2].members, ['f']);
});

function room(n = 4) {
  const s = newRoom('ABCD');
  for (let i = 0; i < n; i++) addPlayer(s, { id: 'p' + i, token: 't' + i, name: 'P' + i });
  return s;
}

test('full round with per-match scoring', () => {
  const s = room(5);
  assert.equal(s.hostId, 'p0');
  apply(s, 'p0', { type: 'settings', settings: { rounds: 3, timer: 0 } });
  apply(s, 'p0', { type: 'start' });
  assert.equal(s.phase, 'category');
  assert.equal(s.askerId, 'p0');
  apply(s, 'p0', { type: 'category', text: 'A fruit' });
  assert.equal(s.phase, 'answering');
  apply(s, 'p0', { type: 'answer', text: 'Apple' });
  apply(s, 'p1', { type: 'answer', text: 'apple' });
  apply(s, 'p2', { type: 'answer', text: 'Apples' });
  // answers hidden from others while answering
  assert.deepEqual(view(s, 'p3').answers, {});
  assert.equal(view(s, 'p2').yourAnswer, 'Apples');
  apply(s, 'p3', { type: 'answer', text: 'Banana' });
  apply(s, 'p4', { type: 'answer', text: 'Mango' });
  assert.equal(s.phase, 'reveal'); // auto reveal when all in
  assert.deepEqual(s.roundPoints, { p0: 2, p1: 2, p2: 2, p3: 0, p4: 0 });
  // host merges Banana + Mango (silly, but tests merge): pair -> 1 each
  const bi = s.groups.findIndex(g => g.label === 'Banana');
  const mi = s.groups.findIndex(g => g.label === 'Mango');
  apply(s, 'p0', { type: 'merge', a: bi, b: mi });
  assert.equal(s.roundPoints.p3, 1);
  assert.equal(s.roundPoints.p4, 1);
  // split p2 out of apple group -> apples drop to 1 each
  apply(s, 'p0', { type: 'split', player: 'p2' });
  assert.deepEqual([s.roundPoints.p0, s.roundPoints.p1, s.roundPoints.p2], [1, 1, 0]);
  apply(s, 'p0', { type: 'next' });
  assert.equal(s.players.p0.score, 1);
  assert.equal(s.players.p2.score, 0);
  assert.equal(s.round, 2);
  assert.equal(s.askerId, 'p1'); // asker rotates
  assert.throws(() => apply(s, 'p3', { type: 'category', text: 'x' }));
});

test('game ends after N rounds; non-host blocked', () => {
  const s = room(2);
  apply(s, 'p0', { type: 'settings', settings: { rounds: 3, timer: 0 } });
  assert.throws(() => apply(s, 'p1', { type: 'start' }));
  apply(s, 'p0', { type: 'start' });
  for (let r = 0; r < 3; r++) {
    apply(s, s.askerId, { type: 'category', text: 'C' + r });
    apply(s, 'p0', { type: 'answer', text: 'x' });
    apply(s, 'p1', { type: 'answer', text: 'x' });
    apply(s, 'p0', { type: 'next' });
  }
  assert.equal(s.phase, 'over');
  assert.equal(s.players.p0.score, 3);
  assert.equal(view(s, 'p0').history.length, 3);
});

test('timer and disconnects', () => {
  const s = room(3);
  apply(s, 'p0', { type: 'settings', settings: { rounds: 5, timer: 20 } });
  apply(s, 'p0', { type: 'start' });
  apply(s, 'p0', { type: 'category', text: 'A colour' });
  apply(s, 'p0', { type: 'answer', text: 'Blue' });
  apply(s, 'p1', { type: 'answer', text: 'blue' });
  assert.equal(s.phase, 'answering');
  setConnected(s, 'p2', false); // p2's phone dies -> everyone connected has answered
  assert.equal(s.phase, 'reveal');
  assert.equal(s.groups.at(-1).none, true);
  assert.equal(s.roundPoints.p2, 0);

  const s2 = room(3);
  apply(s2, 'p0', { type: 'settings', settings: { timer: 20 } });
  apply(s2, 'p0', { type: 'start' });
  apply(s2, 'p0', { type: 'category', text: 'X' });
  assert.equal(tick(s2, s2.deadline + 1), true);
  assert.equal(s2.phase, 'reveal');
});

test('host handover', () => {
  const s = room(3);
  setConnected(s, 'p0', false);
  assert.equal(tick(s, Date.now() + 5000), false);
  assert.equal(tick(s, Date.now() + 25000), true);
  assert.equal(s.hostId, 'p1');
});

test('duplicate names get numbered', () => {
  const s = newRoom('X');
  addPlayer(s, { id: 'a', token: 'a', name: 'John' });
  const b = addPlayer(s, { id: 'b', token: 'b', name: 'john' });
  assert.equal(b.name, 'john 2');
});
