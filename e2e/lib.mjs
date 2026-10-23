import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const outDir = join(root, 'e2e', 'artifacts');
const CDP = process.env.CDP ?? join(process.env.HOME, '.pi/agent/skills/helium-cdp/scripts/cdp.mjs');
const PORT = process.env.CDP_PORT ?? 9223;

export const COMPOSER = '[data-composer-input] [contenteditable="true"]';
export const SIDEBAR_CHAT = 'nav[aria-label="Chat history"] a[href*="/c/"]';
export const CONVO_PATH = /^\/c\/([0-9a-f-]{36})$/;
export const READY_ATTR = 'chatgptShortcutsArchive';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const cli = (...args) => execFileSync('node', [CDP, ...args], { encoding: 'utf8' }).trim();

export const until = async (probe, ms) => {
  const end = Date.now() + ms;
  let value;
  while (Date.now() < end) {
    value = await probe();
    if (value) return value;
    await sleep(200);
  }
  return value;
};

export const browserCall = async (method, params = {}) => {
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  try {
    const reply = await new Promise((resolve) => {
      ws.onmessage = (m) => resolve(JSON.parse(m.data));
      ws.send(JSON.stringify({ id: 1, method, params }));
    });
    if (reply.error) throw new Error(`${method}: ${reply.error.message}`);
    return reply.result;
  } finally {
    ws.close();
  }
};

export const loadExtension = async () => (await browserCall('Extensions.loadUnpacked', { path: root })).id;

const sockCall = (sock, cmd, args) =>
  new Promise((resolve, reject) => {
    const conn = net.connect(sock);
    let buf = '';
    conn.on('connect', () => conn.write(`${JSON.stringify({ id: 1, cmd, args })}\n`));
    conn.on('data', (chunk) => {
      buf += chunk;
      if (!buf.includes('\n')) return;
      conn.end();
      const res = JSON.parse(buf);
      if (res.ok) resolve(res.result);
      else reject(new Error(`${cmd}: ${res.error}`));
    });
    conn.on('error', reject);
  });

const MOD_BITS = { altKey: 1, ctrlKey: 2, metaKey: 4, shiftKey: 8 };

const keyDef = (code) => {
  if (/^Key[A-Z]$/.test(code)) return { key: code.slice(3), vk: code.charCodeAt(3) };
  if (/^Digit\d$/.test(code)) return { key: code.slice(5), vk: code.charCodeAt(5) };
  const named = {
    Escape: 27, Enter: 13, Tab: 9, ArrowUp: 38, ArrowDown: 40,
    ShiftLeft: 16, ControlLeft: 17, AltLeft: 18, MetaLeft: 91,
  };
  const keys = { ShiftLeft: 'Shift', ControlLeft: 'Control', AltLeft: 'Alt', MetaLeft: 'Meta' };
  return { key: keys[code] ?? code, vk: named[code] };
};

export const openTab = async (url) => {
  const anyTab = cli('list').split('\n')[0].slice(0, 8);
  const { targetId } = JSON.parse(cli('evalraw', anyTab, 'Target.createTarget', JSON.stringify({ url })));
  cli('list');
  cli('eval', targetId.slice(0, 8), '1');
  const sock = `/tmp/cdp-${targetId}.sock`;
  const cdp = (cmd, ...args) => sockCall(sock, cmd, args);
  const raw = async (method, params = {}) => JSON.parse(await cdp('evalraw', method, JSON.stringify(params)));
  const page = async (fn, ...args) =>
    JSON.parse(await cdp('eval', `Promise.resolve((${fn})(...${JSON.stringify(args)})).then((v) => JSON.stringify(v ?? null))`));
  const press = async (code, mods = []) => {
    const { key, vk } = keyDef(code);
    const modifiers = mods.reduce((bits, m) => bits | MOD_BITS[m], 0);
    const shown = mods.includes('shiftKey') || key.length > 1 ? key : key.toLowerCase();
    const base = { modifiers, key: shown, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: 0 };
    await raw('Input.dispatchKeyEvent', { ...base, type: 'rawKeyDown' });
    await raw('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
  };
  const close = async () => {
    await cdp('stop').catch(() => {});
    cli('evalraw', anyTab, 'Target.closeTarget', JSON.stringify({ targetId }));
  };
  return { targetId, cdp, raw, page, press, close };
};

export const report = (file) => {
  const results = [];
  const check = (scenario, name, ok, detail = '') => {
    results.push({ scenario, name, ok: Boolean(ok), detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${scenario}: ${name}${ok || !detail ? '' : `  (${detail})`}`);
  };
  const write = (extra = {}) => {
    const failed = results.filter((r) => !r.ok);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      join(outDir, file),
      `${JSON.stringify({ ...extra, passed: results.length - failed.length, failed: failed.length, results }, null, 2)}\n`,
    );
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exitCode = failed.length ? 1 : 0;
  };
  return { check, write };
};

export const waitForContentScript = (tab, ms = 10000) =>
  until(() => tab.page((attr) => document.documentElement.dataset[attr] ?? null, READY_ATTR), ms);

export const openHome = async (tab) => {
  await tab.cdp('nav', 'https://chatgpt.com/');
  if (!(await until(() => tab.page((sel) => Boolean(document.querySelector(sel)), COMPOSER), 20000))) {
    throw new Error('composer never appeared');
  }
  if (!(await waitForContentScript(tab))) throw new Error('the extension content script never attached');
  await tab.page(() => {
    window.__keydowns = [];
    window.addEventListener('keydown', (e) => window.__keydowns.push({ key: e.key, defaultPrevented: e.defaultPrevented }));
    return true;
  });
};

export const backend = (tab, id, body) =>
  tab.page(
    async (convoId, patch) => {
      const { accessToken } = await (await fetch('/api/auth/session')).json();
      const res = await fetch(`/backend-api/conversation/${convoId}`, {
        method: patch ? 'PATCH' : 'GET',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: patch ? JSON.stringify(patch) : undefined,
      });
      const json = await res.json().catch(() => null);
      return { status: res.status, is_archived: json?.is_archived ?? null };
    },
    id,
    body ?? null,
  );

export const chatState = (tab) =>
  tab.page(
    (chatSel) => ({
      path: location.pathname,
      sidebar: [...document.querySelectorAll(chatSel)].map((a) => new URL(a.href).pathname),
      menuOpen: document.querySelectorAll('[role="menuitem"]').length > 0,
      lastKeydown: window.__keydowns?.at(-1) ?? null,
    }),
    SIDEBAR_CHAT,
  );

export const createThrowawayChat = async (tab, label) => {
  await openHome(tab);
  const draft = await tab.page((sel) => document.querySelector(sel).textContent.trim(), COMPOSER);
  if (draft) throw new Error(`home composer has a draft, clear it by hand and rerun: "${draft.slice(0, 40)}"`);
  await tab.cdp('click', COMPOSER);
  await tab.cdp('type', `${label}, reply with just ok`);
  await tab.cdp('key', 'Enter');
  const path = await until(async () => {
    const p = (await chatState(tab)).path;
    return CONVO_PATH.test(p) && p;
  }, 60000);
  if (!path) throw new Error('the throwaway chat never got a server id');
  const done = await until(() => tab.page(() => Boolean(document.querySelector('button[aria-label="Copy"]'))), 60000);
  if (!done) throw new Error('the throwaway chat never finished answering');
  await tab.page(() => ((window.__keydowns.length = 0), true));
  return { path, id: path.match(CONVO_PATH)[1] };
};
