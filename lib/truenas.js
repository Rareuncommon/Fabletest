'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');
const WebSocket = require('ws');

// TrueNAS SCALE speaks two WebSocket dialects depending on version/endpoint:
//   - JSON-RPC 2.0 at  wss://host/api/current   (25.04+)
//   - legacy DDP-style at  wss://host/websocket  (older, still served)
// We detect by URL path and keep a fallback list so a version upgrade or a
// custom-port quirk doesn't strand the app.

const CONNECT_TIMEOUT_MS = 10000;
const CALL_TIMEOUT_MS = 60000;

function candidateUrls(configured) {
  const list = [];
  let host = null;
  try {
    const u = new URL(configured);
    host = u.host; // includes custom port if present
    list.push(configured);
    // Same host/port, alternate endpoint paths.
    if (!configured.endsWith('/api/current')) list.push(`${u.protocol}//${u.host}/api/current`);
    if (!configured.endsWith('/websocket')) list.push(`${u.protocol}//${u.host}/websocket`);
    // Standard port fallbacks.
    list.push(`wss://${u.hostname}/api/current`);
    list.push(`wss://${u.hostname}/websocket`);
  } catch {
    // Bare host or IP.
    host = configured;
    list.push(`wss://${host}/api/current`);
    list.push(`wss://${host}/websocket`);
  }
  return [...new Set(list)];
}

function protocolForUrl(url) {
  return url.endsWith('/websocket') ? 'ddp' : 'jsonrpc';
}

class TrueNASClient extends EventEmitter {
  constructor({ url, apiKey, verifyTls = false, logger = console }) {
    super();
    this.configuredUrl = url;
    this.apiKey = apiKey;
    this.verifyTls = verifyTls;
    this.log = logger;

    this.ws = null;
    this.url = null;          // URL that actually worked
    this.protocol = null;     // 'jsonrpc' | 'ddp'
    this.connected = false;
    this.authenticated = false;
    this.pending = new Map(); // id -> {resolve, reject, timer}
    this.nextId = 1;
    this.closing = false;
    this.reconnectDelay = 1000;
  }

  // Try candidates in order; resolve when one connects + authenticates.
  async connect() {
    this.closing = false;
    const candidates = this.url ? [this.url, ...candidateUrls(this.configuredUrl)] : candidateUrls(this.configuredUrl);
    let lastErr = null;
    for (const url of [...new Set(candidates)]) {
      try {
        await this._connectTo(url);
        await this._authenticate();
        this.url = url;
        this.reconnectDelay = 1000;
        this.log.info(`[truenas] connected via ${url} (${this.protocol})`);
        this.emit('connected');
        return;
      } catch (err) {
        lastErr = err;
        this.log.warn(`[truenas] ${url}: ${err.message}`);
        this._teardown();
      }
    }
    throw lastErr || new Error('no TrueNAS endpoint reachable');
  }

  _connectTo(url) {
    return new Promise((resolve, reject) => {
      const proto = protocolForUrl(url);
      const ws = new WebSocket(url, { rejectUnauthorized: this.verifyTls, handshakeTimeout: CONNECT_TIMEOUT_MS });
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('connect timeout'));
      }, CONNECT_TIMEOUT_MS);

      ws.on('open', () => {
        if (proto === 'ddp') {
          ws.send(JSON.stringify({ msg: 'connect', version: '1', support: ['1'] }));
          // resolution happens on the 'connected' DDP message below
        } else {
          clearTimeout(timer);
          this._adopt(ws, url, proto);
          resolve();
        }
      });
      ws.on('message', (data) => {
        if (proto === 'ddp' && !this.connected) {
          let msg;
          try { msg = JSON.parse(data); } catch { return; }
          if (msg.msg === 'connected') {
            clearTimeout(timer);
            this._adopt(ws, url, proto);
            resolve();
          } else if (msg.msg === 'failed') {
            clearTimeout(timer);
            reject(new Error('DDP handshake rejected'));
          }
        }
      });
      ws.on('error', (err) => { clearTimeout(timer); reject(err); });
      ws.on('close', () => { clearTimeout(timer); reject(new Error('closed during handshake')); });
    });
  }

  _adopt(ws, url, proto) {
    // Handshake listeners are replaced with steady-state ones.
    ws.removeAllListeners('message');
    ws.removeAllListeners('error');
    ws.removeAllListeners('close');
    this.ws = ws;
    this.protocol = proto;
    this.connected = true;
    ws.on('message', (data) => this._onMessage(data));
    ws.on('error', (err) => this.log.warn(`[truenas] socket error: ${err.message}`));
    ws.on('close', () => this._onClose());
  }

  async _authenticate() {
    if (!this.apiKey) throw new Error('TRUENAS_API_KEY not set');
    const ok = await this.call('auth.login_with_api_key', [this.apiKey]);
    if (ok !== true) throw new Error('API key rejected');
    this.authenticated = true;
  }

  _onClose() {
    const wasConnected = this.connected;
    this._teardown();
    if (this.closing) return;
    if (wasConnected) this.emit('disconnected');
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this.closing) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
    this.log.warn(`[truenas] disconnected, reconnecting in ${delay}ms`);
    const t = setTimeout(() => {
      if (this.closing) return;
      this.connect().catch((err) => {
        this.log.warn(`[truenas] reconnect failed: ${err.message}`);
        this._scheduleReconnect();
      });
    }, delay);
    t.unref?.();
  }

  _teardown() {
    this.connected = false;
    this.authenticated = false;
    if (this.ws) {
      this.ws.removeAllListeners();
      try { this.ws.terminate(); } catch { /* already dead */ }
      this.ws = null;
    }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('connection lost'));
    }
    this.pending.clear();
  }

  _onMessage(data) {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    if (this.protocol === 'jsonrpc') {
      if (msg.id === undefined || msg.id === null) return; // notification
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new TrueNASError(msg.error));
      else p.resolve(msg.result);
    } else {
      if (msg.msg !== 'result' || msg.id === undefined) return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new TrueNASError(msg.error));
      else p.resolve(msg.result);
    }
  }

  call(method, params = []) {
    if (!this.connected || !this.ws) return Promise.reject(new Error('not connected'));
    return new Promise((resolve, reject) => {
      let id, payload;
      if (this.protocol === 'jsonrpc') {
        id = this.nextId++;
        payload = { jsonrpc: '2.0', id, method, params };
      } else {
        id = crypto.randomUUID();
        payload = { id, msg: 'method', method, params };
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`call ${method} timed out`));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(payload), (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  close() {
    this.closing = true;
    this._teardown();
  }
}

class TrueNASError extends Error {
  constructor(raw) {
    const reason = raw?.data?.reason || raw?.reason || raw?.message || raw?.error || JSON.stringify(raw);
    super(String(reason).trim());
    this.name = 'TrueNASError';
    this.raw = raw;
  }
}

module.exports = { TrueNASClient, TrueNASError, candidateUrls, protocolForUrl };
