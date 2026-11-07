// Pure game engine. No I/O: the Durable Object feeds it actions and persists
// the returned state. Everything here is unit-testable in plain Node.
import { groupAnswers } from './match.js';
import { randomCategory } from './categories.js';

export const LIMITS = { players: 24, name: 16, answer: 40, category: 80 };
export const COLORS = ['#FF5D73', '#FFB13B', '#3BC4FF', '#7C5CFF', '#2ED47A', '#FF7AD9',
  '#00C2A8', '#FF8A3D', '#5B8CFF', '#B4E33D', '#E45CFF', '#FFD23F'];
export const AVATARS = ['🐑', '🐮', '🐷', '🐔', '🐴', '🐐', '🦙', '🐶', '🐱', '🦊', '🐸', '🐨',
  '🦘', '🐼', '🐯', '🦁', '🐵', '🐧', '🦉', '🐙', '🦄', '🐝', '🦖', '🐢'];

const now = () => Date.now();
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

export function newRoom(code) {
  return {
    code,
    createdAt: now(),
    lastActivity: now(),
    phase: 'lobby', // lobby | category | answering | reveal | over
    hostId: null,
    settings: { rounds: 10, timer: 45, fuzzy: true, decks: ['classic', 'places', 'pop', 'aussie', 'spicy'] },
    players: {},
    order: [],
    round: 0,
    askerId: null,
    category: '',
    answers: {},
    deadline: null,
    groups: [],
    roundPoints: {},
    usedCategories: [],
    history: [],
    seq: 0,
  };
}

export class GameError extends Error {}
const fail = msg => { throw new GameError(msg); };

function requireHost(s, pid) { if (s.hostId !== pid) fail('Only the host can do that'); }
function connectedIds(s) { return s.order.filter(id => s.players[id]?.connected); }
function activeIds(s) { return s.order.filter(id => s.players[id]); }

export function addPlayer(s, { id, token, name, avatar }) {
  if (Object.keys(s.players).length >= LIMITS.players) fail('Room is full');
  const nm = clean(name, LIMITS.name) || 'Player';
  const taken = new Set(Object.values(s.players).map(p => p.name.toLowerCase()));
  let finalName = nm, n = 2;
  while (taken.has(finalName.toLowerCase())) finalName = `${nm.slice(0, LIMITS.name - 2)} ${n++}`;
  const usedColors = new Set(Object.values(s.players).map(p => p.color));
  const color = COLORS.find(c => !usedColors.has(c)) || COLORS[s.order.length % COLORS.length];
  s.players[id] = {
    id, token, name: finalName,
    avatar: AVATARS.includes(avatar) ? avatar : AVATARS[s.order.length % AVATARS.length],
    color, score: 0, connected: true, joinedAt: now(),
  };
  s.order.push(id);
  if (!s.hostId) s.hostId = id;
  return s.players[id];
}

export function apply(s, pid, action) {
  const p = s.players[pid];
  if (!p) fail('You are not in this room');
  s.lastActivity = now();
  const a = action || {};
  switch (a.type) {
    case 'profile': {
      if (a.name !== undefined) {
        const nm = clean(a.name, LIMITS.name);
        if (nm) p.name = nm;
      }
      if (AVATARS.includes(a.avatar)) p.avatar = a.avatar;
      break;
    }
    case 'settings': {
      requireHost(s, pid);
      const st = a.settings || {};
      if ([3, 5, 10, 15, 20, 0].includes(st.rounds)) s.settings.rounds = st.rounds;
      if ([0, 20, 30, 45, 60, 90].includes(st.timer)) s.settings.timer = st.timer;
      if (typeof st.fuzzy === 'boolean') s.settings.fuzzy = st.fuzzy;
      if (Array.isArray(st.decks)) s.settings.decks = st.decks.filter(d => typeof d === 'string').slice(0, 10);
      break;
    }
    case 'start': {
      requireHost(s, pid);
      if (!['lobby', 'over'].includes(s.phase)) fail('Game already running');
      if (activeIds(s).length < 2) fail('Need at least 2 players');
      for (const id of s.order) s.players[id].score = 0;
      s.round = 0; s.history = []; s.usedCategories = [];
      s.askerId = null;
      nextRound(s);
      break;
    }
    case 'category': {
      if (s.phase !== 'category') fail('Not choosing a category right now');
      if (pid !== s.askerId && pid !== s.hostId) fail(`Waiting for ${s.players[s.askerId]?.name || 'the asker'}`);
      const cat = clean(a.text, LIMITS.category);
      if (!cat) fail('Type a category');
      s.category = cat;
      s.usedCategories.push(cat);
      s.answers = {};
      s.phase = 'answering';
      s.deadline = s.settings.timer ? now() + s.settings.timer * 1000 : null;
      break;
    }
    case 'suggest': {
      // Returns a suggestion without changing phase; caller reads s._suggestion.
      s._suggestion = randomCategory(s.settings.decks, s.usedCategories);
      break;
    }
    case 'answer': {
      if (s.phase !== 'answering') fail('Answers are closed');
      const ans = clean(a.text, LIMITS.answer);
      if (ans) s.answers[pid] = ans; else delete s.answers[pid];
      maybeAutoReveal(s);
      break;
    }
    case 'reveal': {
      requireHost(s, pid);
      if (s.phase !== 'answering') fail('Nothing to reveal');
      reveal(s);
      break;
    }
    case 'merge': {
      // Host says two groups are really the same answer ("Coke" + "Coca-Cola").
      requireHost(s, pid);
      if (s.phase !== 'reveal') fail('Can only merge during the reveal');
      const g1 = s.groups[a.a], g2 = s.groups[a.b];
      if (!g1 || !g2 || g1 === g2) fail('Pick two different answers');
      g1.members.push(...g2.members);
      g1.merged = true;
      s.groups.splice(a.b, 1);
      sortGroups(s.groups);
      score(s);
      break;
    }
    case 'split': {
      // Host says one player's answer doesn't really belong in its group.
      requireHost(s, pid);
      if (s.phase !== 'reveal') fail('Can only split during the reveal');
      const g = s.groups.find(gr => gr.members.includes(a.player));
      if (!g || g.members.length < 2) fail('Nothing to split');
      g.members = g.members.filter(m => m !== a.player);
      s.groups.push({ key: 'split:' + a.player, label: s.answers[a.player] || '—', members: [a.player], split: true });
      sortGroups(s.groups);
      score(s);
      break;
    }
    case 'next': {
      requireHost(s, pid);
      if (s.phase !== 'reveal') fail('Finish the reveal first');
      commitRound(s);
      if (s.settings.rounds && s.round >= s.settings.rounds) s.phase = 'over';
      else nextRound(s);
      break;
    }
    case 'end': {
      requireHost(s, pid);
      if (s.phase === 'reveal') commitRound(s);
      s.phase = 'over';
      s.deadline = null;
      break;
    }
    case 'lobby': {
      requireHost(s, pid);
      s.phase = 'lobby'; s.deadline = null; s.answers = {}; s.groups = []; s.category = '';
      break;
    }
    case 'skipAsker': {
      requireHost(s, pid);
      if (s.phase !== 'category') fail('Not choosing a category right now');
      s.askerId = pickNextAsker(s, s.askerId);
      break;
    }
    case 'kick': {
      requireHost(s, pid);
      if (a.player === pid) fail("You can't kick yourself");
      removePlayer(s, a.player);
      break;
    }
    case 'makeHost': {
      requireHost(s, pid);
      if (!s.players[a.player]) fail('No such player');
      s.hostId = a.player;
      break;
    }
    case 'leave': {
      removePlayer(s, pid);
      break;
    }
    default:
      fail('Unknown action');
  }
  s.seq++;
  return s;
}

function pickNextAsker(s, current) {
  const ids = connectedIds(s).length ? connectedIds(s) : activeIds(s);
  if (!ids.length) return null;
  const idx = ids.indexOf(current);
  return ids[(idx + 1) % ids.length];
}

function nextRound(s) {
  s.round += 1;
  s.askerId = pickNextAsker(s, s.askerId);
  s.phase = 'category';
  s.category = '';
  s.answers = {};
  s.groups = [];
  s.roundPoints = {};
  s.deadline = null;
}

function maybeAutoReveal(s) {
  const waiting = connectedIds(s).filter(id => !s.answers[id]);
  if (s.phase === 'answering' && waiting.length === 0 && Object.keys(s.answers).length >= 2) reveal(s);
}

export function reveal(s) {
  s.groups = groupAnswers(s.answers, { fuzzy: s.settings.fuzzy });
  // Players who didn't answer appear as a "no answer" group (never scores).
  const silent = activeIds(s).filter(id => !s.answers[id]);
  if (silent.length) s.groups.push({ key: '__none__', label: 'No answer', members: silent, none: true });
  sortGroups(s.groups);
  s.phase = 'reveal';
  s.deadline = null;
  score(s);
}

function sortGroups(groups) {
  groups.sort((a, b) => (a.none ? 1 : 0) - (b.none ? 1 : 0) || b.members.length - a.members.length);
}

// SCORING: you get 1 point for every other player who matched your answer.
// No match = 0. (A herd of 4 -> each of the 4 scores 3.)
export function score(s) {
  s.roundPoints = {};
  for (const id of activeIds(s)) s.roundPoints[id] = 0;
  for (const g of s.groups) {
    if (g.none) continue;
    const pts = g.members.length - 1;
    for (const m of g.members) if (s.players[m]) s.roundPoints[m] = pts;
  }
}

function commitRound(s) {
  for (const [id, pts] of Object.entries(s.roundPoints)) if (s.players[id]) s.players[id].score += pts;
  s.history.push({
    round: s.round,
    category: s.category,
    asker: s.askerId,
    groups: s.groups.map(g => ({ label: g.label, members: [...g.members], none: !!g.none })),
    points: { ...s.roundPoints },
  });
  if (s.history.length > 50) s.history.shift();
  s.roundPoints = {};
}

export function removePlayer(s, id) {
  if (!s.players[id]) return;
  delete s.players[id];
  delete s.answers[id];
  s.order = s.order.filter(x => x !== id);
  for (const g of s.groups) g.members = g.members.filter(m => m !== id);
  s.groups = s.groups.filter(g => g.members.length);
  if (s.hostId === id) s.hostId = connectedIds(s)[0] || s.order[0] || null;
  if (s.askerId === id && s.phase === 'category') s.askerId = pickNextAsker(s, null);
  if (s.phase === 'reveal') score(s);
  if (s.phase === 'answering') maybeAutoReveal(s);
}

export function setConnected(s, id, connected) {
  const p = s.players[id];
  if (!p) return;
  p.connected = connected;
  p.lastSeen = now();
  if (!connected && s.hostId === id) {
    s.hostAwaySince = now();
  }
  if (connected && s.hostId === id) s.hostAwaySince = null;
  if (s.phase === 'answering' && !connected) maybeAutoReveal(s);
  s.seq++;
}

// Called periodically: hand host to someone else if the host's phone has been
// gone for a while, and reveal when the timer runs out.
export function tick(s, t = now()) {
  let changed = false;
  const host = s.players[s.hostId];
  if ((!host || !host.connected) && s.hostAwaySince && t - s.hostAwaySince > 20000) {
    const next = connectedIds(s)[0];
    if (next) { s.hostId = next; s.hostAwaySince = null; changed = true; }
  }
  if (s.phase === 'answering' && s.deadline && t >= s.deadline) {
    reveal(s);
    changed = true;
  }
  if (changed) s.seq++;
  return changed;
}

// What a given phone is allowed to see. Answers stay secret until reveal
// (you only see your own), and tokens never leave the server.
export function view(s, forId) {
  const hidden = s.phase === 'answering';
  const players = s.order.filter(id => s.players[id]).map(id => {
    const p = s.players[id];
    return {
      id, name: p.name, avatar: p.avatar, color: p.color, score: p.score, connected: p.connected,
      answered: !!s.answers[id],
    };
  });
  return {
    code: s.code,
    seq: s.seq,
    phase: s.phase,
    hostId: s.hostId,
    askerId: s.askerId,
    you: forId || null,
    settings: s.settings,
    players,
    round: s.round,
    category: s.category,
    deadline: s.deadline,
    serverNow: now(),
    yourAnswer: forId ? s.answers[forId] || '' : '',
    answers: hidden ? {} : s.answers,
    groups: hidden ? [] : s.groups,
    roundPoints: s.roundPoints,
    history: s.phase === 'over' ? s.history : s.history.slice(-1),
  };
}
