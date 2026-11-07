// Flock — phone client. Vanilla JS, no build step.
// Rendering is split into keyed sections; a section is only replaced when its
// HTML actually changes, so a text box you're typing in is never rebuilt by
// someone else's update (which would close the phone keyboard).

const AVATARS = ['🐑', '🐮', '🐷', '🐔', '🐴', '🐐', '🦙', '🐶', '🐱', '🦊', '🐸', '🐨',
  '🦘', '🐼', '🐯', '🦁', '🐵', '🐧', '🦉', '🐙', '🦄', '🐝', '🦖', '🐢'];
const DECKS = { classic: 'Classic', places: 'Places', pop: 'Pop culture', aussie: 'Aussie', spicy: 'Opinions' };

const SHEEP = (cls = 'sheep') => `<svg class="${cls}" viewBox="0 0 120 120" aria-hidden="true">
  <g stroke="#1B1A17" stroke-width="5">
  <circle cx="38" cy="58" r="20" fill="#fff"/><circle cx="60" cy="44" r="22" fill="#fff"/>
  <circle cx="82" cy="58" r="20" fill="#fff"/><circle cx="60" cy="70" r="22" fill="#fff"/>
  <ellipse cx="60" cy="64" rx="15" ry="18" fill="#1B1A17"/></g>
  <circle cx="54" cy="62" r="3" fill="#fff"/><circle cx="66" cy="62" r="3" fill="#fff"/>
  <path d="M46 92v16M74 92v16" stroke="#1B1A17" stroke-width="6" stroke-linecap="round"/></svg>`;

// ---------- storage (may be blocked in private mode) ----------
const mem = {};
const store = {
  get(k) { try { return localStorage.getItem('flock.' + k); } catch { return mem[k] ?? null; } },
  set(k, v) { try { localStorage.setItem('flock.' + k, v); } catch { mem[k] = v; } },
  del(k) { try { localStorage.removeItem('flock.' + k); } catch { delete mem[k]; } },
};
function token() {
  let t = store.get('token');
  if (!t || t.length < 16) {
    t = [...crypto.getRandomValues(new Uint8Array(18))].map(b => b.toString(16).padStart(2, '0')).join('');
    store.set('token', t);
  }
  return t;
}

// ---------- app state ----------
const S = {
  screen: 'home', // home | game | tv
  tv: false,
  code: null,
  ws: null,
  connected: false,
  state: null,
  you: null,
  gone: null,
  rejoinOnly: false,
  drafts: { name: store.get('name') || '', code: '' },
  avatar: store.get('avatar') || AVATARS[Math.floor(Math.random() * AVATARS.length)],
  editing: false,
  sel: null,
  sheet: null,
  muted: store.get('muted') === '1',
  offset: 0,
  animatedReveal: null,
  confettiFor: null,
  retry: 0,
  retryTimer: null,
  homeRejoin: null,
};

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const me = () => S.state?.players.find(p => p.id === S.you);
const pl = id => S.state?.players.find(p => p.id === id);
const isHost = () => S.state && S.state.hostId === S.you;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ---------- sound & haptics ----------
let AC = null;
function audio() {
  if (S.muted) return null;
  try {
    AC ||= new (window.AudioContext || window.webkitAudioContext)();
    if (AC.state === 'suspended') AC.resume();
    return AC;
  } catch { return null; }
}
function tone(freq, dur = 0.1, type = 'sine', vol = 0.12, when = 0, slide = 0) {
  const ac = audio(); if (!ac) return;
  const t = ac.currentTime + when;
  const o = ac.createOscillator(), g = ac.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(ac.destination); o.start(t); o.stop(t + dur + 0.02);
}
const sfx = {
  tap: () => tone(520, 0.05, 'triangle', 0.06),
  join: () => { tone(523, 0.09, 'triangle'); tone(784, 0.12, 'triangle', 0.12, 0.08); },
  start: () => [392, 523, 659].forEach((f, i) => tone(f, 0.12, 'square', 0.06, i * 0.07)),
  tick: () => tone(1046, 0.04, 'square', 0.04),
  pop: (i = 0) => tone(440 + i * 60, 0.09, 'triangle', 0.12),
  herd: () => [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.18, 'triangle', 0.12, i * 0.08)),
  baa: () => { tone(330, 0.5, 'sawtooth', 0.05, 0, 0.8); tone(336, 0.5, 'sawtooth', 0.04, 0, 0.78); },
  fanfare: () => [523, 523, 523, 698, 880, 1046].forEach((f, i) => tone(f, i === 5 ? 0.5 : 0.12, 'square', 0.06, i * 0.12)),
};
const vib = p => { try { navigator.vibrate?.(p); } catch {} };
document.addEventListener('pointerdown', () => { if (!S.muted) audio(); }, { once: true });

let wakeLock = null;
async function keepAwake() {
  try { if ('wakeLock' in navigator && !wakeLock && document.visibilityState === 'visible') { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch {}
}

// ---------- toast ----------
let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

// ---------- networking ----------
function connect(code, opts = {}) {
  S.code = code.toUpperCase();
  S.screen = opts.tv ? 'tv' : 'game';
  S.tv = !!opts.tv;
  S.rejoinOnly = !!opts.rejoinOnly;
  S.gone = null;
  document.body.classList.toggle('tv', S.tv);
  const path = (S.tv ? '/tv/' : '/') + S.code;
  if (location.pathname !== path) history.replaceState(null, '', path);
  open();
  render();
}

function open() {
  clearTimeout(S.retryTimer);
  if (S.ws) { S.ws.onclose = null; try { S.ws.close(); } catch {} }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws/${S.code}`);
  S.ws = ws;
  ws.onopen = () => {
    S.connected = true; S.retry = 0;
    ws.send(JSON.stringify(S.tv
      ? { t: 'hello', spectator: true }
      : { t: 'hello', token: token(), name: S.drafts.name || store.get('name') || '', avatar: S.avatar, rejoinOnly: S.rejoinOnly }));
    render();
  };
  ws.onmessage = ev => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.t === 'welcome') { S.you = m.you; S.rejoinOnly = false; store.set('room', S.code); keepAwake(); }
    else if (m.t === 'state') onState(m.state);
    else if (m.t === 'error') { toast(m.msg); vib(80); }
    else if (m.t === 'suggestion') {
      S.drafts.cat = m.text;
      const el = $('#cat'); if (el) { el.value = m.text; el.classList.remove('shake'); }
      sfx.pop(3);
    } else if (m.t === 'gone') {
      store.del('room');
      if (S.rejoinOnly) { goHome(S.code); toast('Pop your name in to join'); return; }
      S.gone = m.msg; S.state = null; render();
    }
  };
  ws.onclose = () => {
    S.connected = false;
    if (S.gone || S.screen === 'home') return;
    render();
    const wait = Math.min(5000, 400 * 2 ** S.retry++);
    S.retryTimer = setTimeout(open, wait);
  };
}
setInterval(() => { if (S.ws?.readyState === 1) S.ws.send('{"t":"ping"}'); }, 20000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  keepAwake();
  if (S.screen !== 'home' && !S.gone && (!S.ws || S.ws.readyState > 1)) { S.retry = 0; open(); }
});
window.addEventListener('online', () => { if (S.screen !== 'home' && !S.gone && !S.connected) { S.retry = 0; open(); } });

function send(action) {
  if (S.ws?.readyState !== 1) { toast('Reconnecting…'); return false; }
  S.ws.send(JSON.stringify({ t: 'action', action }));
  return true;
}

function goHome(prefill = '') {
  if (S.ws) { S.ws.onclose = null; try { S.ws.close(); } catch {} }
  Object.assign(S, { screen: 'home', tv: false, code: null, ws: null, state: null, you: null, gone: null, sheet: null, connected: false });
  S.drafts.code = prefill;
  document.body.classList.remove('tv');
  history.replaceState(null, '', prefill ? '/' + prefill : '/');
  render();
  checkRejoin();
}

// ---------- state transitions: sounds, buzzes, confetti ----------
function onState(next) {
  const prev = S.state;
  S.state = next;
  S.offset = next.serverNow - Date.now();
  const phaseChanged = !prev || prev.phase !== next.phase || prev.round !== next.round;

  if (phaseChanged) {
    S.editing = false; S.sel = null;
    if (S.sheet?.kind === 'split') S.sheet = null;
    if (next.phase === 'category') {
      S.drafts.cat = '';
      if (next.askerId === S.you && prev) { vib([40, 60, 40]); sfx.join(); }
    }
    if (next.phase === 'answering') { S.drafts.ans = ''; if (prev) { sfx.start(); vib(30); } }
    if (next.phase === 'reveal' && prev?.phase === 'answering') playReveal(next);
    if (next.phase === 'over' && S.confettiFor !== next.round) { S.confettiFor = next.round; confetti(); sfx.fanfare(); vib([60, 40, 60, 40, 120]); }
  }
  if (prev && next.phase === 'lobby' && next.players.length > prev.players.length) sfx.join();
  if (prev && next.phase === 'answering' && !phaseChanged) {
    const before = prev.players.filter(p => p.answered).length, after = next.players.filter(p => p.answered).length;
    if (after > before) sfx.tap();
  }
  if (!S.tv && S.you && !next.players.some(p => p.id === S.you)) { S.gone = 'You are no longer in this game.'; }
  render();
}

function playReveal(st) {
  const n = st.groups.length;
  st.groups.forEach((g, i) => setTimeout(() => { sfx.pop(i); vib(15); }, 150 + i * 380));
  if (S.tv) return;
  const pts = st.roundPoints[S.you] || 0;
  setTimeout(() => { if (pts > 0) { sfx.herd(); vib([30, 50, 30]); } else { sfx.baa(); vib(200); } }, 250 + n * 380);
}

// ---------- timer ----------
setInterval(() => {
  const st = S.state; const bar = $('#tbar'), txt = $('#ttxt');
  if (!st || st.phase !== 'answering' || !st.deadline || !bar) return;
  const total = st.settings.timer * 1000;
  const left = Math.max(0, st.deadline - (Date.now() + S.offset));
  const secs = Math.ceil(left / 1000);
  bar.style.transform = `scaleX(${left / total})`;
  bar.parentElement.classList.toggle('low', secs <= 5);
  if (txt.textContent !== String(secs)) {
    txt.textContent = secs;
    if (secs <= 5 && secs > 0 && !st.players.find(p => p.id === S.you)?.answered) { sfx.tick(); vib(10); }
  }
}, 200);

// ---------- rendering ----------
function render() {
  const secs = S.screen === 'home' ? homeView() : gameView();
  if (S.sheet) secs.push(['sheet', sheetView()]);
  patch(secs);
  document.title = S.code ? `Flock · ${S.code}` : 'Flock — think like the herd';
}

function patch(sections) {
  const app = $('#app');
  const ae = document.activeElement;
  const keep = ae && ae.id && /INPUT|TEXTAREA/.test(ae.tagName)
    ? { id: ae.id, s: ae.selectionStart, e: ae.selectionEnd } : null;
  const existing = new Map([...app.children].map(el => [el.dataset.k, el]));
  let prev = null;
  for (const [k, html] of sections) {
    let el = existing.get(k);
    if (!el || el._html !== html) {
      const fresh = document.createElement('div');
      fresh.dataset.k = k; fresh.innerHTML = html; fresh._html = html;
      if (el) el.replaceWith(fresh); else if (prev) prev.after(fresh); else app.prepend(fresh);
      el = fresh;
      el.querySelectorAll('input[data-draft]').forEach(i => { i.value = S.drafts[i.id] ?? ''; });
      afterMount(k, el);
    } else if (prev && prev.nextElementSibling !== el) {
      prev.after(el);
    } else if (!prev && app.firstElementChild !== el) {
      app.prepend(el);
    }
    existing.delete(k);
    prev = el;
  }
  existing.forEach(el => el.remove());
  if (keep && document.activeElement !== $('#' + keep.id)) {
    const el = $('#' + keep.id);
    if (el) { el.focus({ preventScroll: true }); try { el.setSelectionRange(keep.s, keep.e); } catch {} }
  }
}

function afterMount(k, el) {
  if (el.querySelector('#qr')) makeQR();
  const auto = el.querySelector('[data-autofocus]');
  if (auto && !('ontouchstart' in window)) setTimeout(() => auto.focus(), 50);
}

function makeQR() {
  const box = $('#qr'); if (!box) return;
  const url = `${location.origin}/${S.code}`;
  try {
    const qr = window.qrcode(0, 'M'); qr.addData(url); qr.make();
    box.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 0, scalable: true });
  } catch { box.outerHTML = `<div class="pill">${esc(url)}</div>`; }
}

// ----- home -----
function homeView() {
  const avatars = AVATARS.map(a => `<button class="avatar-pick ${a === S.avatar ? 'on' : ''}" data-act="avatar" data-v="${a}" aria-label="Avatar ${a}">${a}</button>`).join('');
  const rejoin = S.homeRejoin ? `<button class="btn sun" data-act="rejoin">↩ Rejoin game ${esc(S.homeRejoin)}</button>` : '';
  return [
    ['hero', `<div class="hero">${SHEEP()}<h1>Flock</h1><p>Think like the herd. Score when your friends say the same thing.</p></div>`],
    ['rejoin', rejoin],
    ['form', `<div class="card stack">
      <label class="lbl" for="name">Your name</label>
      <input id="name" class="input" data-draft maxlength="16" autocomplete="nickname" autocapitalize="words" placeholder="e.g. John" enterkeyhint="done">
      <label class="lbl">Pick your animal</label>
      <div class="avatars">${avatars}</div>
    </div>`],
    ['actions', `<div class="stack">
      <button class="btn primary" data-act="create">✨ Start a new game</button>
      <div class="divider">or join a friend</div>
      <div class="row">
        <input id="code" class="input code grow" data-draft maxlength="4" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="CODE" enterkeyhint="go" ${S.drafts.code ? '' : ''}>
        <button class="btn dark" style="width:auto;padding:0 22px" data-act="join">Join</button>
      </div>
    </div>`],
    ['how', `<button class="btn ghost small" data-act="rules">How to play</button>`],
  ];
}

// ----- game -----
function topbar() {
  const st = S.state;
  const status = S.connected ? '<span class="dot" title="Connected"></span>' : '<span class="dot off" title="Reconnecting"></span>';
  return `<div class="topbar">
    <div class="brand">${SHEEP('logo')}Flock</div>
    <div class="spacer"></div>
    ${S.code ? `<span class="pill code">${status} ${esc(S.code)}</span>` : ''}
    <button class="iconbtn" data-act="mute" aria-label="${S.muted ? 'Unmute' : 'Mute'}">${S.muted ? '🔇' : '🔊'}</button>
    ${S.tv ? '' : `<button class="iconbtn" data-act="menu" aria-label="Menu">☰</button>`}
  </div>${!S.connected && st ? `<div class="banner">📡 Reconnecting… hang tight</div>` : ''}`;
}

function gameView() {
  if (S.gone) return [['top', topbar()], ['gone', `<div class="card stack center">${SHEEP('sheep')}<h2>Game over for you</h2><p class="muted">${esc(S.gone)}</p><button class="btn primary" data-act="home">Back to start</button></div>`]];
  const st = S.state;
  if (!st) return [['top', topbar()], ['wait', `<div class="waiting">${SHEEP()}<h3>Finding the flock…</h3><p class="muted">Connecting to room ${esc(S.code)}</p></div>`], ['cancel', `<button class="btn ghost small" data-act="home">Cancel</button>`]];
  const v = { lobby: lobbyView, category: categoryView, answering: answeringView, reveal: revealView, over: overView }[st.phase];
  return [['top', topbar()], ...v(st)];
}

function face(p, size = '') {
  return `<span class="f ${size}" style="background:${p.color}">${p.avatar}</span>`;
}
function mini(p, extra = '', act = '') {
  return `<span class="mini ${extra} ${p.connected ? '' : 'away'}" ${act}>${face(p)}${esc(p.name)}</span>`;
}

function lobbyView(st) {
  const host = pl(st.hostId);
  const players = st.players.map(p => `<div class="player ${p.id === S.you ? 'me' : ''} ${p.connected ? '' : 'away'} ${(isHost() || p.id === S.you) && !S.tv ? 'tap' : ''}" ${!S.tv && (isHost() || p.id === S.you) ? `data-act="player" data-id="${p.id}"` : ''}>
      ${p.id === st.hostId ? '<span class="crown">👑</span>' : ''}
      <div class="face" style="background:${p.color}">${p.avatar}</div>
      <div class="nm">${esc(p.name)}${p.id === S.you ? ' (you)' : ''}</div></div>`).join('');

  const chip = (k, val, label, on) => `<button class="chip ${on ? 'on' : ''}" ${isHost() ? `data-act="set" data-k="${k}" data-v="${val}"` : 'disabled'}>${label}</button>`;
  const s = st.settings;
  const settings = `<div class="card stack">
    <h3>Game settings ${isHost() ? '' : '<span class="small muted">(host decides)</span>'}</h3>
    <div class="setting"><label class="lbl">Rounds</label><div class="chips">${[5, 10, 15, 20, 0].map(r => chip('rounds', r, r || '∞', s.rounds === r)).join('')}</div></div>
    <div class="setting"><label class="lbl">Answer timer</label><div class="chips">${[0, 30, 45, 60, 90].map(t => chip('timer', t, t ? t + 's' : 'Off', s.timer === t)).join('')}</div></div>
    <div class="setting"><label class="lbl">“Surprise me” decks</label><div class="chips">${Object.entries(DECKS).map(([k, n]) => chip('deck', k, n, s.decks.includes(k))).join('')}</div></div>
    <div class="setting"><label class="lbl">Forgive typos</label><div class="chips">${chip('fuzzy', 1, 'On — “bananna” = “banana”', s.fuzzy)}${chip('fuzzy', 0, 'Exact only', !s.fuzzy)}</div></div>
  </div>`;

  const joinUrl = `${location.host}/${st.code}`;
  if (S.tv) {
    return [
      ['tvlobby', `<div class="tvgrid">
        <div class="stack center"><h2>Join on your phone</h2><div class="muted">${esc(joinUrl)}</div><div class="bigcode">${esc(st.code)}</div><div class="qrwrap"><div id="qr"></div></div></div>
        <div class="stack"><h2>${plural(st.players.length, 'player')}</h2><div class="players">${players || '<p class="muted">Waiting for the flock…</p>'}</div></div>
      </div>`],
    ];
  }
  return [
    ['code', `<div class="card stack center">
      <label class="lbl">Room code</label>
      <div class="bigcode">${esc(st.code)}</div>
      <div class="row"><button class="btn small sun" data-act="share">📲 Invite friends</button><button class="btn small" data-act="tvlink">📺 TV screen</button></div>
    </div>`],
    ['qr', `<div class="qrwrap"><div id="qr"></div></div><p class="center muted small">Friends scan this, or go to <b>${esc(joinUrl)}</b></p>`],
    ['players', `<div class="stack"><h3>${plural(st.players.length, 'player')} in the paddock</h3><div class="players">${players}</div>
      ${isHost() ? '<p class="muted small center">Tap a player to make them host or remove them.</p>' : '<p class="muted small center">Tap yourself to change your name or animal.</p>'}</div>`],
    ['settings', settings],
    ['start', isHost()
      ? `<button class="btn primary" data-act="start" ${st.players.length < 2 ? 'disabled' : ''}>🐑 Start the game</button>${st.players.length < 2 ? '<p class="center muted small">Need at least 2 players. 3+ is way more fun.</p>' : ''}`
      : `<div class="waiting">${SHEEP()}<h3>Waiting for ${esc(host?.name || 'the host')} to start…</h3></div>`],
  ];
}

function roundBar(st, withTimer) {
  const r = st.settings.rounds ? `Round ${st.round} of ${st.settings.rounds}` : `Round ${st.round}`;
  const asker = pl(st.askerId);
  return `<div class="stack"><div class="roundbar"><span class="pill">${r}</span><span class="spacer"></span>${asker ? `<span class="small muted">Category by</span> ${mini(asker)}` : ''}</div>
    ${withTimer ? `<div class="timer-row"><div class="timer"><i id="tbar"></i></div><b id="ttxt">${st.settings.timer}</b></div>` : ''}</div>`;
}

function categoryView(st) {
  const asker = pl(st.askerId);
  const mine = st.askerId === S.you;
  const out = [['round', roundBar(st, false)]];
  if (S.tv) {
    out.push(['wait', `<div class="waiting">${SHEEP()}<h2>${esc(asker?.name || 'Someone')} is choosing a category…</h2></div>`]);
    out.push(['board', boardView(st, false)]);
    return out;
  }
  if (mine || isHost()) {
    out.push(['pick', `<div class="card sun stack">
      <h2>${mine ? 'Your turn! Name a category' : `Pick for ${esc(asker?.name || 'them')}?`}</h2>
      <p class="small" style="margin:0">${mine ? 'Something with an obvious answer, and a few sneaky alternatives.' : `${esc(asker?.name || 'They')} is up, but as host you can type one in.`}</p>
      <input id="cat" class="input" data-draft maxlength="80" placeholder="e.g. A pizza topping" autocomplete="off" enterkeyhint="go" ${mine ? 'data-autofocus' : ''}>
      <div class="row"><button class="btn small" data-act="suggest">🎲 Surprise me</button><button class="btn small dark" data-act="go">Go! →</button></div>
    </div>`]);
  }
  if (!mine) out.push(['wait', `<div class="waiting">${SHEEP()}<h3>${esc(asker?.name || 'Someone')} is choosing a category…</h3><p class="muted small">Get ready to think like everyone else.</p></div>`]);
  if (isHost() && !mine) out.push(['host', `<button class="btn small ghost" data-act="skip">Skip ${esc(asker?.name || 'player')}'s turn</button>`]);
  out.push(['board', boardView(st, false)]);
  return out;
}

function categoryCard(st) {
  return `<div class="card category-card enter"><div class="kicker">Round ${st.round} · everyone name…</div><div class="cat">${esc(st.category)}</div></div>`;
}

function answeringView(st) {
  const done = st.players.filter(p => p.answered).length;
  const strip = `<div class="stack center"><b>${done} of ${st.players.length} locked in</b>
    <div class="answered-strip">${st.players.map(p => mini(p, p.answered ? 'done' : '')).join('')}</div></div>`;
  const out = [['round', roundBar(st, !!st.deadline)], ['cat', categoryCard(st)]];
  if (!S.tv) {
    const locked = st.yourAnswer && !S.editing;
    out.push(['answer', locked
      ? `<div class="card grass locked"><div class="grow"><div class="small">You said</div><div class="ans">${esc(st.yourAnswer)}</div></div><button class="btn small" style="width:auto" data-act="edit">Change</button></div>
         <p class="center muted small">Answers show once everyone's in. Will the herd agree?</p>`
      : `<div class="stack"><input id="ans" class="input" data-draft maxlength="40" placeholder="Type what everyone else will say" autocomplete="off" autocapitalize="sentences" enterkeyhint="send" data-autofocus>
         <button class="btn primary" data-act="answer">🔒 Lock it in</button></div>`]);
  }
  out.push(['status', strip]);
  if (isHost() && !S.tv) out.push(['host', `<button class="btn small ghost" data-act="reveal">Reveal now (don't wait)</button>`]);
  return out;
}

function revealView(st) {
  const animate = S.animatedReveal !== st.round;
  S.animatedReveal = st.round;
  const delay = i => animate ? `style="--d:${(0.15 + i * 0.38).toFixed(2)}s"` : '';
  const myGroup = st.groups.find(g => g.members.includes(S.you));
  const out = [['round', roundBar(st, false)], ['cat', categoryCard(st)]];

  if (!S.tv && S.you) {
    const pts = st.roundPoints[S.you] || 0;
    const others = myGroup ? myGroup.members.length - 1 : 0;
    const verdict = !myGroup || myGroup.none
      ? `<div class="card verdict"><div class="big">You didn't answer</div><div class="pts">+0</div></div>`
      : pts > 0
        ? `<div class="card grass verdict"><div class="big">In the herd! 🐑</div><div class="pts">+${pts}</div><div>You matched ${plural(others, 'other player')}</div></div>`
        : `<div class="card tomato verdict"><div class="big">Black sheep! 🐑</div><div class="pts">+0</div><div>Nobody else said “${esc(myGroup.label)}”</div></div>`;
    out.push(['verdict', verdict.replace('class="card', `${animate ? `style="--d:${(0.3 + st.groups.length * 0.38).toFixed(2)}s" ` : ''}class="card ${animate ? 'enter' : ''}`)]);
  }

  const groups = st.groups.map((g, i) => {
    const herd = !g.none && g.members.length > 1;
    const members = g.members.map(id => pl(id)).filter(Boolean);
    const spellings = [...new Set(g.members.map(id => st.answers[id]).filter(Boolean))];
    const canSplit = isHost() && !S.tv && herd;
    const pts = herd ? g.members.length - 1 : 0;
    const sel = S.sel && g.members.includes(S.sel);
    const cls = ['group', animate ? 'enter' : '', herd ? 'herd' : g.none ? 'none' : 'lone', g.members.includes(S.you) ? 'mine' : '', sel ? 'sel' : '', isHost() && !S.tv && !g.none ? 'tap' : ''].join(' ');
    return `<div class="${cls}" ${delay(i)} ${isHost() && !S.tv && !g.none ? `data-act="group" data-id="${g.members[0]}"` : ''}>
      <div class="head"><div class="label">${g.none ? 'No answer' : esc(g.label)}</div>
        <span class="count">${g.none ? '0 pts' : herd ? `${g.members.length} · +${pts} each` : 'solo · 0'}</span></div>
      ${g.merged ? '<div class="merged">Merged by host</div>' : ''}
      <div class="who">${members.map(p => mini(p, canSplit ? 'tap' : '', canSplit ? `data-act="splitask" data-id="${p.id}"` : '')).join('')}</div>
      ${spellings.length > 1 ? `<div class="raw">Written as: ${spellings.map(esc).join(' · ')}</div>` : ''}
    </div>`;
  }).join('');
  out.push(['groups', `<div class="stack groups">${groups}</div>`]);

  if (isHost() && !S.tv) {
    out.push(['tip', `<p class="hosttip">${S.sel
      ? `Now tap the answer that means the same as “${esc(st.groups.find(g => g.members.includes(S.sel))?.label || '')}”. Tap it again to cancel.`
      : 'Host powers: tap two answers to merge them (Coke = Coca-Cola). Tap a player to split them out.'}</p>`]);
  }
  out.push(['board', boardView(st, true)]);
  const last = st.settings.rounds && st.round >= st.settings.rounds;
  if (!S.tv) out.push(['next', isHost()
    ? `<div class="stack"><button class="btn primary" data-act="next">${last ? '🏆 Final results' : 'Next round →'}</button>${last ? '' : '<button class="btn small ghost" data-act="end">End game now</button>'}</div>`
    : `<p class="center muted">Waiting for ${esc(pl(st.hostId)?.name || 'the host')} to continue…</p>`]);
  return out;
}

function boardView(st, withRound) {
  const rows = [...st.players]
    .map(p => ({ p, total: p.score + (withRound ? st.roundPoints[p.id] || 0 : 0), plus: withRound ? st.roundPoints[p.id] || 0 : 0 }))
    .sort((a, b) => b.total - a.total);
  let rank = 0, lastScore = null;
  return `<div class="stack"><h3>${withRound ? 'Scores' : 'Standings'}</h3><div class="board">${rows.map((r, i) => {
    if (r.total !== lastScore) { rank = i + 1; lastScore = r.total; }
    return `<div class="brow ${r.p.id === S.you ? 'me' : ''}"><span class="rank">${rank}</span>${face(r.p)}<span class="nm">${esc(r.p.name)}</span>${withRound ? `<span class="plus">${r.plus ? '+' + r.plus : ''}</span>` : ''}<span class="sc">${r.total}</span></div>`;
  }).join('')}</div></div>`;
}

function awards(st) {
  const hist = st.history || [];
  if (!hist.length) return '';
  const pairs = {}, solo = {};
  let biggest = null;
  for (const h of hist) {
    for (const g of h.groups) {
      if (g.none) continue;
      if (g.members.length === 1) solo[g.members[0]] = (solo[g.members[0]] || 0) + 1;
      if (!biggest || g.members.length > biggest.n) biggest = { n: g.members.length, label: g.label, cat: h.category };
      for (let i = 0; i < g.members.length; i++) for (let j = i + 1; j < g.members.length; j++) {
        const k = [g.members[i], g.members[j]].sort().join('|');
        pairs[k] = (pairs[k] || 0) + 1;
      }
    }
  }
  const items = [];
  const bestPair = Object.entries(pairs).sort((a, b) => b[1] - a[1])[0];
  if (bestPair) {
    const [a, b] = bestPair[0].split('|').map(pl);
    if (a && b) items.push(['🧠', 'Mind melders', `${esc(a.name)} & ${esc(b.name)} matched ${plural(bestPair[1], 'time')}`]);
  }
  const black = Object.entries(solo).sort((a, b) => b[1] - a[1])[0];
  if (black && pl(black[0])) items.push(['🐑', 'Black sheep award', `${esc(pl(black[0]).name)} went solo ${plural(black[1], 'time')}`]);
  if (biggest && biggest.n > 1) items.push(['📣', 'Biggest herd', `${biggest.n} people said “${esc(biggest.label)}” for <i>${esc(biggest.cat)}</i>`]);
  return `<div class="card stack"><h3>Awards</h3><div class="awards">${items.map(([em, t, d]) => `<div class="award"><span class="em">${em}</span><div><b>${t}</b><span class="small">${d}</span></div></div>`).join('')}</div></div>`;
}

function listNames(ps) {
  const n = ps.map(p => esc(p.name));
  return n.length < 2 ? n.join('') : n.slice(0, -1).join(', ') + ' & ' + n.at(-1);
}

function overView(st) {
  const sorted = [...st.players].sort((a, b) => b.score - a.score);
  const top = sorted[0];
  const tie = sorted.length > 1 && sorted[1].score === top?.score;
  const winners = sorted.filter(p => p.score === top?.score);
  const pod = (p, place) => p ? `<div class="pod p${p.score === top.score ? 1 : place}"><div class="f">${p.avatar}</div><div class="nm">${esc(p.name)}</div><div class="blk">${p.score}</div></div>` : '<div></div>';
  const out = [
    ['winner', `<div class="center stack"><h1>${tie ? "It's a tie!" : `${esc(top?.name)} wins!`}</h1>
      <p class="muted" style="margin:0">${tie ? listNames(winners) + ' think exactly alike' : 'The truest member of the herd'}</p>
      <div class="podium">${pod(sorted[1], 2)}${pod(sorted[0], 1)}${pod(sorted[2], 3)}</div></div>`],
    ['awards', awards(st)],
    ['board', boardView(st, false)],
  ];
  if (!S.tv) out.push(['again', isHost()
    ? `<div class="stack"><button class="btn primary" data-act="start">🔁 Play again</button><button class="btn small" data-act="lobby">Back to lobby (change settings)</button></div>`
    : `<p class="center muted">Waiting for ${esc(pl(st.hostId)?.name || 'the host')} to start another game…</p>`]);
  return out;
}

// ----- bottom sheets -----
function sheetView() {
  const sh = S.sheet; const st = S.state;
  let body = '';
  if (sh.kind === 'player') {
    const p = pl(sh.id);
    if (!p) { S.sheet = null; return ''; }
    if (p.id === S.you) {
      body = `<h3>You</h3>
        <input id="rename" class="input" data-draft maxlength="16" placeholder="Your name">
        <div class="avatars">${AVATARS.map(a => `<button class="avatar-pick ${a === p.avatar ? 'on' : ''}" data-act="reavatar" data-v="${a}">${a}</button>`).join('')}</div>
        <button class="btn primary" data-act="rename">Save</button>`;
      S.drafts.rename ??= p.name;
    } else {
      body = `<h3>${p.avatar} ${esc(p.name)}</h3>
        <button class="btn" data-act="makehost" data-id="${p.id}">👑 Make host</button>
        <button class="btn" style="background:var(--tomato);color:#fff" data-act="kick" data-id="${p.id}">Remove from game</button>`;
    }
  } else if (sh.kind === 'split') {
    const p = pl(sh.id);
    body = `<h3>Split ${esc(p?.name)} out?</h3><p style="margin:0">They wrote “${esc(st.answers[sh.id])}”. Splitting puts them in their own group, so it no longer counts as a match.</p>
      <button class="btn dark" data-act="split" data-id="${sh.id}">Yes, split them out</button>`;
  } else if (sh.kind === 'menu') {
    body = `<h3>Menu</h3>
      <button class="btn" data-act="rules">📖 How to play</button>
      ${S.code ? `<button class="btn" data-act="share">📲 Invite friends</button><button class="btn" data-act="tvlink">📺 Open TV screen</button>` : ''}
      ${S.state && isHost() && S.state.phase !== 'lobby' ? `<button class="btn" data-act="end">🏁 End game</button>` : ''}
      <button class="btn" style="background:var(--tomato);color:#fff" data-act="leave">Leave game</button>`;
  } else if (sh.kind === 'rules') {
    body = `<h3>How to play Flock</h3>
      <ol style="margin:0;padding-left:20px;display:grid;gap:8px">
        <li>Everyone joins on their phone with the room code.</li>
        <li>Each round, one player names a <b>category</b> (or taps 🎲 for one).</li>
        <li>Everyone secretly writes <b>one answer</b>. Don't be clever — guess what the others will say.</li>
        <li>Answers are revealed in groups. You score <b>1 point for every other player who matched you</b>. No match? Zero. You're the black sheep.</li>
        <li>Typos and plurals count as the same answer. The host can merge answers that mean the same thing (Coke / Coca-Cola), or split ones that don't.</li>
        <li>Most points after the last round wins.</li>
      </ol>`;
  }
  return `<div class="sheet-bg" data-act="closesheet"><div class="sheet" data-stop>${body}<button class="btn ghost small" data-act="closesheet">Close</button></div></div>`;
}

// ---------- actions ----------
const actions = {
  avatar(d) { S.avatar = d.v; store.set('avatar', d.v); sfx.tap(); render(); },
  async create() {
    if (!requireName()) return;
    const b = $('[data-act=create]'); if (b) b.disabled = true;
    try {
      const r = await fetch('/api/new', { method: 'POST' });
      const j = await r.json();
      if (!j.code) throw new Error(j.error);
      connect(j.code);
    } catch (e) { toast('Could not create a game. Check your connection.'); if (b) b.disabled = false; }
  },
  async join() {
    const code = (S.drafts.code || '').toUpperCase().replace(/[^A-Z]/g, '');
    if (code.length !== 4) { toast('Room codes are 4 letters'); $('#code')?.focus(); return; }
    if (!requireName()) return;
    try {
      const j = await (await fetch('/api/room/' + code)).json();
      if (!j.exists) { toast(`No game called ${code}. Check the code?`); vib(80); return; }
      connect(code);
    } catch { toast('Could not reach the game. Check your connection.'); }
  },
  rejoin() { connect(S.homeRejoin, { rejoinOnly: true }); },
  rules() { S.sheet = { kind: 'rules' }; render(); },
  menu() { S.sheet = { kind: 'menu' }; render(); },
  closesheet(d, el, ev) { if (ev.target.closest('[data-stop]') && el.classList.contains('sheet-bg')) return; S.sheet = null; delete S.drafts.rename; render(); },
  mute() { S.muted = !S.muted; store.set('muted', S.muted ? '1' : '0'); if (!S.muted) sfx.tap(); render(); },
  async share() {
    const url = `${location.origin}/${S.code}`;
    const text = `Join my Flock game! Code ${S.code}`;
    try {
      if (navigator.share) { await navigator.share({ title: 'Flock', text, url }); return; }
    } catch (e) { if (e?.name === 'AbortError') return; }
    try { await navigator.clipboard.writeText(url); toast('Invite link copied!'); } catch { toast(url); }
  },
  tvlink() {
    const url = `${location.origin}/tv/${S.code}`;
    window.open(url, '_blank');
    toast('Open this on a TV or laptop: ' + url.replace(/^https?:\/\//, ''));
  },
  player(d) { S.sheet = { kind: 'player', id: d.id }; render(); },
  reavatar(d) { send({ type: 'profile', avatar: d.v }); },
  rename() {
    const n = (S.drafts.rename || '').trim();
    if (n) { send({ type: 'profile', name: n }); S.drafts.name = n; store.set('name', n); }
    S.sheet = null; delete S.drafts.rename; render();
  },
  makehost(d) { send({ type: 'makeHost', player: d.id }); S.sheet = null; render(); },
  kick(d) { send({ type: 'kick', player: d.id }); S.sheet = null; render(); },
  set(d) {
    const s = S.state.settings;
    if (d.k === 'rounds') send({ type: 'settings', settings: { rounds: +d.v } });
    if (d.k === 'timer') send({ type: 'settings', settings: { timer: +d.v } });
    if (d.k === 'fuzzy') send({ type: 'settings', settings: { fuzzy: d.v === '1' } });
    if (d.k === 'deck') {
      const decks = s.decks.includes(d.v) ? s.decks.filter(x => x !== d.v) : [...s.decks, d.v];
      if (!decks.length) { toast('Keep at least one deck'); return; }
      send({ type: 'settings', settings: { decks } });
    }
    sfx.tap();
  },
  start() { send({ type: 'start' }); },
  lobby() { send({ type: 'lobby' }); },
  suggest() { send({ type: 'suggest' }); },
  go() {
    const t = (S.drafts.cat || '').trim();
    if (!t) { toast('Type a category, or tap 🎲'); $('#cat')?.focus(); return; }
    send({ type: 'category', text: t });
  },
  skip() { send({ type: 'skipAsker' }); },
  answer() {
    const t = (S.drafts.ans || '').trim();
    if (!t) { toast('Type an answer first'); $('#ans')?.focus(); return; }
    if (send({ type: 'answer', text: t })) { S.editing = false; document.activeElement?.blur(); vib(20); sfx.tap(); }
  },
  edit() { S.editing = true; S.drafts.ans = S.state.yourAnswer; render(); setTimeout(() => $('#ans')?.focus(), 30); },
  reveal() { send({ type: 'reveal' }); },
  group(d) {
    if (!S.sel) { S.sel = d.id; sfx.tap(); render(); return; }
    if (S.sel === d.id) { S.sel = null; render(); return; }
    const gs = S.state.groups;
    const a = gs.findIndex(g => g.members.includes(S.sel));
    const b = gs.findIndex(g => g.members.includes(d.id));
    S.sel = null;
    if (a < 0 || b < 0 || a === b) { render(); return; }
    send({ type: 'merge', a, b }); sfx.herd();
  },
  splitask(d, el, ev) { ev.stopPropagation(); S.sheet = { kind: 'split', id: d.id }; render(); },
  split(d) { send({ type: 'split', player: d.id }); S.sheet = null; render(); },
  next() { send({ type: 'next' }); },
  end() { send({ type: 'end' }); S.sheet = null; render(); },
  leave() { send({ type: 'leave' }); store.del('room'); goHome(); },
  home() { store.del('room'); goHome(); },
};

function requireName() {
  const n = (S.drafts.name || '').trim();
  if (!n) { toast("What's your name?"); $('#name')?.focus(); vib(60); return false; }
  store.set('name', n); store.set('avatar', S.avatar);
  return true;
}

document.addEventListener('click', ev => {
  const el = ev.target.closest('[data-act]');
  if (!el || el.disabled) return;
  if (el.dataset.act === 'closesheet' && el.classList.contains('sheet-bg') && ev.target.closest('[data-stop]')) return;
  actions[el.dataset.act]?.(el.dataset, el, ev);
});
document.addEventListener('input', ev => {
  const el = ev.target;
  if (!el.matches('input[data-draft]')) return;
  if (el.id === 'code') { const v = el.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4); if (v !== el.value) el.value = v; }
  S.drafts[el.id] = el.value;
});
document.addEventListener('keydown', ev => {
  if (ev.key !== 'Enter') return;
  const id = ev.target.id;
  const map = { ans: 'answer', cat: 'go', code: 'join', rename: 'rename', name: S.drafts.code?.length === 4 ? 'join' : null };
  if (map[id]) { ev.preventDefault(); actions[map[id]]({}, ev.target, ev); }
});

// ---------- confetti ----------
function confetti() {
  const c = $('#confetti'); const ctx = c.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  c.width = innerWidth * dpr; c.height = innerHeight * dpr; ctx.scale(dpr, dpr);
  const colors = ['#FFC93C', '#23B26D', '#FF5A36', '#4BB8F2', '#1B1A17', '#ffffff'];
  const bits = Array.from({ length: 160 }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * 80, y: innerHeight * 0.35,
    vx: (Math.random() - 0.5) * 14, vy: -Math.random() * 14 - 4, r: Math.random() * 6 + 4,
    a: Math.random() * 6, va: (Math.random() - 0.5) * 0.4, c: colors[Math.floor(Math.random() * colors.length)],
  }));
  const t0 = performance.now();
  (function frame(t) {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const b of bits) {
      b.vy += 0.35; b.vx *= 0.99; b.x += b.vx; b.y += b.vy; b.a += b.va;
      ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.a); ctx.fillStyle = b.c;
      ctx.fillRect(-b.r / 2, -b.r / 4, b.r, b.r / 2); ctx.restore();
    }
    if (t - t0 < 4500) requestAnimationFrame(frame); else ctx.clearRect(0, 0, innerWidth, innerHeight);
  })(t0);
}

// ---------- boot ----------
async function checkRejoin() {
  const last = store.get('room');
  if (!last) return;
  try {
    const j = await (await fetch('/api/room/' + last)).json();
    if (j.exists && S.screen === 'home') { S.homeRejoin = last; render(); }
    else if (!j.exists) store.del('room');
  } catch {}
}

(function boot() {
  const path = location.pathname.replace(/\/+$/, '');
  const tv = path.match(/^\/tv\/([A-Za-z]{4})$/);
  const room = path.match(/^\/([A-Za-z]{4})$/);
  if (tv) { connect(tv[1], { tv: true }); return; }
  if (room) {
    const code = room[1].toUpperCase();
    if (store.get('room') === code) { connect(code, { rejoinOnly: true }); return; }
    S.drafts.code = code;
  }
  render();
  checkRejoin();
  if (room && !S.drafts.name) setTimeout(() => $('#name')?.focus(), 100);
})();
