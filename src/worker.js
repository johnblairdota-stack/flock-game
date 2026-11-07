// Cloudflare Worker entry + one Durable Object per game room.
// Phones connect over WebSocket to /ws/<CODE>; every room lives in its own
// Durable Object, so all players in a room hit the same single instance.
import { DurableObject } from 'cloudflare:workers';
import { newRoom, addPlayer, apply, view, tick, setConnected, GameError, nextAlarm } from './game.js';

// No vowels -> no accidental rude words. No look-alikes (0/O, 1/I).
const CODE_CHARS = 'BCDFGHJKLMNPQRSTVWXZ';
const CODE_RE = /^[BCDFGHJKLMNPQRSTVWXZ]{4}$/;
const IDLE_MS = 6 * 60 * 60 * 1000; // rooms vanish after 6h idle

function makeCode() {
  const b = crypto.getRandomValues(new Uint8Array(4));
  return [...b].map(x => CODE_CHARS[x % CODE_CHARS.length]).join('');
}

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (err) {
      console.error('route failed', err);
      return json({ error: 'Server error', detail: String(err && err.message || err) }, 500);
    }
  },
};

async function route(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/new' && request.method === 'POST') {
      for (let i = 0; i < 8; i++) {
        const code = makeCode();
        const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
        const res = await stub.fetch(`https://room/init?code=${code}`, { method: 'POST' });
        if (res.status === 200) return json({ code });
      }
      return json({ error: 'Could not create a room, try again' }, 503);
    }

    const ws = url.pathname.match(/^\/ws\/([A-Za-z]{4})$/);
    if (ws) {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
      const code = ws[1].toUpperCase();
      if (!CODE_RE.test(code)) return new Response('Bad code', { status: 400 });
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      return stub.fetch(request);
    }

    const exists = url.pathname.match(/^\/api\/room\/([A-Za-z]{4})$/);
    if (exists) {
      const code = exists[1].toUpperCase();
      if (!CODE_RE.test(code)) return json({ exists: false });
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      return stub.fetch('https://room/info');
    }

    return env.ASSETS.fetch(request);
}

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.state = null;
    ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get('state')) || null;
    });
    // Answer keep-alive pings without waking the object from hibernation.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/init') {
      if (this.state && Object.keys(this.state.players).length) return json({ error: 'taken' }, 409);
      this.state = newRoom(url.searchParams.get('code'));
      await this.save();
      return json({ ok: true });
    }
    if (url.pathname === '/info') {
      const s = this.state;
      if (!s) return json({ exists: false });
      return json({ exists: true, players: Object.keys(s.players).length, phase: s.phase });
    }
    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({});
      if (!this.state) {
        server.send(JSON.stringify({ t: 'gone', msg: "That room doesn't exist (or has ended)." }));
        server.close(4404, 'No such room');
      }
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response('Not found', { status: 404 });
  }

  async webSocketMessage(ws, raw) {
    if (!this.state) return;
    if (typeof raw !== 'string' || raw.length > 2000) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const s = this.state;
    const att = ws.deserializeAttachment() || {};

    try {
      if (msg.t === 'hello') {
        if (msg.spectator) {
          ws.serializeAttachment({ spectator: true });
          ws.send(JSON.stringify({ t: 'state', state: view(s, null) }));
          return;
        }
        const token = String(msg.token || '').slice(0, 64);
        if (token.length < 16) throw new GameError('Bad session');
        let player = Object.values(s.players).find(p => p.token === token);
        if (!player) {
          if (msg.rejoinOnly) { ws.send(JSON.stringify({ t: 'gone', msg: 'You are no longer in this room.' })); return; }
          player = addPlayer(s, { id: crypto.randomUUID().slice(0, 8), token, name: msg.name, avatar: msg.avatar });
        }
        ws.serializeAttachment({ pid: player.id });
        setConnected(s, player.id, true);
        ws.send(JSON.stringify({ t: 'welcome', you: player.id }));
        await this.commit();
        return;
      }

      if (msg.t === 'action' && att.pid) {
        const action = msg.action || {};
        apply(s, att.pid, action);
        if (action.type === 'suggest') {
          ws.send(JSON.stringify({ t: 'suggestion', text: s._suggestion }));
          delete s._suggestion;
          return;
        }
        if (action.type === 'kick' || action.type === 'leave') {
          const target = action.type === 'kick' ? action.player : att.pid;
          for (const other of this.ctx.getWebSockets()) {
            if ((other.deserializeAttachment() || {}).pid === target) {
              other.send(JSON.stringify({ t: 'gone', msg: action.type === 'kick' ? 'The host removed you from the game.' : 'You left the game.' }));
              other.serializeAttachment({});
              try { other.close(4000, 'removed'); } catch {}
            }
          }
        }
        await this.commit();
      }
    } catch (err) {
      if (err instanceof GameError) ws.send(JSON.stringify({ t: 'error', msg: err.message }));
      else { console.error(err); ws.send(JSON.stringify({ t: 'error', msg: 'Something went wrong' })); }
    }
  }

  async webSocketClose(ws, code) {
    await this.dropSocket(ws);
    try { ws.close(code === 1005 ? 1000 : code, 'bye'); } catch {}
  }

  async webSocketError(ws) {
    await this.dropSocket(ws);
  }

  async dropSocket(ws) {
    if (!this.state) return;
    const { pid } = ws.deserializeAttachment() || {};
    if (!pid || !this.state.players[pid]) return;
    // A player may have two tabs open; only mark them offline when all are gone.
    const stillHere = this.ctx.getWebSockets().some(o => o !== ws && (o.deserializeAttachment() || {}).pid === pid);
    if (!stillHere) {
      setConnected(this.state, pid, false);
      await this.commit();
    }
  }

  async alarm() {
    if (!this.state) return;
    const s = this.state;
    const sockets = this.ctx.getWebSockets();
    if (Date.now() - s.lastActivity > IDLE_MS && sockets.length === 0) {
      this.state = null;
      await this.ctx.storage.deleteAll();
      return;
    }
    tick(s);
    await this.commit();
  }

  async commit() {
    await this.save();
    this.broadcast();
  }

  async save() {
    const s = this.state;
    await this.ctx.storage.put('state', s);
    // One alarm drives: round timer, host handover, idle cleanup.
    await this.ctx.storage.setAlarm(nextAlarm(s, Date.now(), IDLE_MS));
  }

  broadcast() {
    const s = this.state;
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() || {};
      if (!att.pid && !att.spectator) continue;
      try { ws.send(JSON.stringify({ t: 'state', state: view(s, att.pid || null) })); } catch {}
    }
  }
}
