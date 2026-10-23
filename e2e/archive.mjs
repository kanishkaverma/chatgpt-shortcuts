#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'e2e', 'artifacts');
const CDP = process.env.CDP ?? join(process.env.HOME, '.pi/agent/skills/helium-cdp/scripts/cdp.mjs');
const RUNS = Number(process.env.ARCHIVE_RUNS ?? 3);
const contentScript = readFileSync(join(root, 'content.js'), 'utf8');

const COMPOSER = '[data-composer-input] [contenteditable="true"]';
const SIDEBAR_CHAT = 'nav[aria-label="Chat history"] a[href*="/c/"]';
const CONVO_PATH = /^\/c\/([0-9a-f-]{36})$/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cli = (...args) => execFileSync('node', [CDP, ...args], { encoding: 'utf8' }).trim();

let tabSocket;
const cdp = (cmd, ...args) =>
  new Promise((resolve, reject) => {
    const conn = net.connect(tabSocket);
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
const raw = async (method, params = {}) => JSON.parse(await cdp('evalraw', method, JSON.stringify(params)));
const page = async (fn, ...args) =>
  JSON.parse(await cdp('eval', `Promise.resolve((${fn})(...${JSON.stringify(args)})).then((v) => JSON.stringify(v))`));
const until = async (probe, ms) => {
  const end = Date.now() + ms;
  let value;
  while (Date.now() < end) {
    value = await probe();
    if (value) return value;
    await sleep(200);
  }
  return value;
};

const results = [];
const check = (scenario, name, ok, detail = '') => {
  results.push({ scenario, name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${scenario}: ${name}${ok || !detail ? '' : `  (${detail})`}`);
};

const pressCtrlShiftA = async () => {
  const base = { modifiers: 10, key: 'A', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 0 };
  await raw('Input.dispatchKeyEvent', { ...base, type: 'rawKeyDown' });
  await raw('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
};

const injectContentScript = async () => {
  const frameId = (await raw('Page.getFrameTree')).frameTree.frame.id;
  const { executionContextId } = await raw('Page.createIsolatedWorld', { frameId, worldName: 'chatgpt-shortcuts' });
  const run = await raw('Runtime.evaluate', { expression: contentScript, contextId: executionContextId });
  if (run.exceptionDetails) throw new Error(`content.js threw: ${JSON.stringify(run.exceptionDetails)}`);
  await page(() => {
    window.__keydowns = [];
    window.addEventListener('keydown', (e) => window.__keydowns.push({ key: e.key, defaultPrevented: e.defaultPrevented }));
    return true;
  });
};

const backend = (id, init) =>
  page(
    async (convoId, body) => {
      const { accessToken } = await (await fetch('/api/auth/session')).json();
      const res = await fetch(`/backend-api/conversation/${convoId}`, {
        method: body ? 'PATCH' : 'GET',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json().catch(() => null);
      return { status: res.status, is_archived: json?.is_archived ?? null };
    },
    id,
    init ?? null,
  );

const state = () =>
  page(
    (chatSel) => ({
      path: location.pathname,
      sidebar: [...document.querySelectorAll(chatSel)].map((a) => new URL(a.href).pathname),
      menuOpen: document.querySelectorAll('[role="menuitem"]').length > 0,
      lastKeydown: window.__keydowns?.at(-1) ?? null,
    }),
    SIDEBAR_CHAT,
  );

const openHome = async () => {
  await cdp('nav', 'https://chatgpt.com/');
  if (!(await until(() => page((sel) => Boolean(document.querySelector(sel)), COMPOSER), 20000))) throw new Error('composer never appeared');
};

const createThrowawayChat = async (n) => {
  await openHome();
  const draft = await page((sel) => document.querySelector(sel).textContent.trim(), COMPOSER);
  if (draft) throw new Error(`home composer has a draft, clear it by hand and rerun: "${draft.slice(0, 40)}"`);
  await cdp('click', COMPOSER);
  await cdp('type', `archive shortcut e2e ${n}, reply with just ok`);
  await cdp('key', 'Enter');
  const path = await until(async () => {
    const p = (await state()).path;
    return CONVO_PATH.test(p) && p;
  }, 60000);
  if (!path) throw new Error('the throwaway chat never got a server id');
  const done = await until(() => page(() => Boolean(document.querySelector('button[aria-label="Copy"]'))), 60000);
  if (!done) throw new Error('the throwaway chat never finished answering');
  return path;
};

const negativeOnHome = async () => {
  const S = 'home-page';
  await openHome();
  await injectContentScript();
  await cdp('click', COMPOSER);
  await pressCtrlShiftA();
  await sleep(700);
  const s = await state();
  check(S, 'Ctrl+Shift+A outside a conversation is not default-prevented', s.lastKeydown?.defaultPrevented === false, JSON.stringify(s.lastKeydown));
  check(S, 'no menu opens', !s.menuOpen);
};

const archiveOnce = async (n) => {
  const S = `archive-run-${n}`;
  const path = await createThrowawayChat(n);
  const id = path.match(CONVO_PATH)[1];
  try {
    await injectContentScript();
    check(S, 'precondition: the chat is not archived', (await backend(id)).is_archived === false);
    await cdp('click', COMPOSER);
    const started = Date.now();
    await pressCtrlShiftA();
    const after = await until(async () => {
      const s = await state();
      return s.path !== path && s;
    }, 5000);
    check(S, 'leaves the archived chat', Boolean(after), `still on ${path}`);
    const s = after || (await state());
    console.log(`      left ${path} for ${s.path} after ${Date.now() - started}ms`);
    check(S, 'keydown was default-prevented', s.lastKeydown?.defaultPrevented === true, JSON.stringify(s.lastKeydown));
    const gone = await until(async () => !(await state()).sidebar.includes(path), 5000);
    check(S, 'the chat is gone from the sidebar', gone);
    check(S, 'no menu is left open', !s.menuOpen);
    const server = await until(async () => {
      const b = await backend(id);
      return b.is_archived === true && b;
    }, 5000);
    check(S, 'the server marks the chat archived', Boolean(server), JSON.stringify(await backend(id)));
    if (n === 1) {
      mkdirSync(outDir, { recursive: true });
      const { data } = await raw('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(outDir, 'archive-after.png'), Buffer.from(data, 'base64'));
    }
  } finally {
    await backend(id, { is_visible: false });
  }
};

const anyTab = cli('list').split('\n')[0].slice(0, 8);
const { targetId } = JSON.parse(cli('evalraw', anyTab, 'Target.createTarget', JSON.stringify({ url: 'https://chatgpt.com/' })));
cli('list');
cli('eval', targetId.slice(0, 8), '1');
tabSocket = `/tmp/cdp-${targetId}.sock`;

try {
  await negativeOnHome();
  for (let n = 1; n <= RUNS; n++) {
    try {
      await archiveOnce(n);
    } catch (error) {
      check(`archive-run-${n}`, 'scenario ran to completion', false, error.message.split('\n')[0]);
    }
  }
  const build = await page(() => document.documentElement.dataset.build ?? null);
  const failed = results.filter((r) => !r.ok);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, 'archive-result.json'),
    `${JSON.stringify({ chatgptBuild: build, runs: RUNS, passed: results.length - failed.length, failed: failed.length, results }, null, 2)}\n`,
  );
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  await cdp('stop').catch(() => {});
  cli('evalraw', anyTab, 'Target.closeTarget', JSON.stringify({ targetId }));
}
