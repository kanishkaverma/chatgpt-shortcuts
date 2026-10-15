#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'e2e', 'artifacts');
const CDP = process.env.CDP ?? join(process.env.HOME, '.pi/agent/skills/helium-cdp/scripts/cdp.mjs');
const contentScript = readFileSync(join(root, 'content.js'), 'utf8');

const COMPOSER = '[data-composer-input] [contenteditable="true"]';
const USER_TURN = '[data-content-search-unit-key$=":user"]';
const EDITOR = '[aria-label="Edit message"][contenteditable="true"]';

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
const found = (selector, ms = 3000) =>
  cdp('wait', selector, String(ms)).then(
    () => true,
    () => false,
  );

const results = [];
const check = (scenario, name, ok, detail = '') => {
  results.push({ scenario, name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${scenario}: ${name}${ok || !detail ? '' : `  (${detail})`}`);
};

const snapshot = () =>
  page(
    (composerSel, editorSel) => {
      const norm = (s) => s.replace(/\s+/g, ' ').trim();
      const editors = [...document.querySelectorAll(editorSel)];
      const editor = editors[0];
      const composer = document.querySelector(composerSel);
      const sel = getSelection();
      let caretAtEnd = false;
      if (editor && sel.rangeCount && sel.isCollapsed && editor.contains(sel.anchorNode)) {
        const tail = document.createRange();
        tail.selectNodeContents(editor);
        tail.setStart(sel.anchorNode, sel.anchorOffset);
        caretAtEnd = tail.toString() === '';
      }
      return {
        editorCount: editors.length,
        activeIsEditor: Boolean(editor) && document.activeElement === editor,
        activeIsComposer: document.activeElement === composer,
        editorText: editor ? norm(editor.textContent) : null,
        composerText: composer ? norm(composer.textContent) : null,
        caretAtEnd,
        lastKeydown: window.__keydowns.at(-1) ?? null,
      };
    },
    COMPOSER,
    EDITOR,
  );

const lastMessageText = () =>
  page(() => {
    const bubbles = document.querySelectorAll('[data-user-message-bubble]');
    return bubbles.length ? bubbles[bubbles.length - 1].innerText.replace(/\s+/g, ' ').trim() : null;
  });

const resetKeydowns = () => page(() => ((window.__keydowns.length = 0), true));

const injectContentScript = async () => {
  const frameId = (await raw('Page.getFrameTree')).frameTree.frame.id;
  const { executionContextId } = await raw('Page.createIsolatedWorld', { frameId, worldName: 'chatgpt-shortcuts' });
  const run = await raw('Runtime.evaluate', { expression: contentScript, contextId: executionContextId });
  if (run.exceptionDetails) throw new Error(`content.js threw: ${JSON.stringify(run.exceptionDetails)}`);
};

const NEW_CHAT_URL = 'https://chatgpt.com/?temporary-chat=true';
let loaded = null;

const load = async (url, waitFor) => {
  for (let attempt = 1; ; attempt++) {
    await cdp('nav', url);
    if ((await found(COMPOSER, 10000)) && (await found(waitFor, 10000))) break;
    if (attempt === 4) {
      const where = await page(() => ({ href: location.href, title: document.title, body: document.body.innerText.slice(0, 120) }));
      throw new Error(`page not ready after ${attempt} loads (rate limited?): ${JSON.stringify(where)}`);
    }
    console.log(`page not ready (attempt ${attempt}), retrying in ${attempt * 20}s`);
    await sleep(attempt * 20000);
  }
  await injectContentScript();
  await page(() => {
    window.__keydowns = [];
    window.addEventListener('keydown', (e) =>
      window.__keydowns.push({ key: e.key, defaultPrevented: e.defaultPrevented }),
    );
    return true;
  });
  loaded = url;
};

const reset = async () => {
  await cancelEdit();
  const closed = await page(async (editorSel) => {
    for (let i = 0; i < 40 && document.querySelector(editorSel); i++) await new Promise((r) => setTimeout(r, 50));
    document.activeElement?.blur();
    window.__keydowns.length = 0;
    return !document.querySelector(editorSel);
  }, EDITOR);
  if (!closed) throw new Error('an edit field is still open after Cancel');
  const draft = await page((sel) => document.querySelector(sel).textContent.trim(), COMPOSER);
  if (draft) throw new Error(`composer has a stale draft, clear it by hand and rerun: "${draft.slice(0, 40)}"`);
};

const openLastEditorWithoutFocus = () =>
  page(() => {
    const buttons = document.querySelectorAll('button[aria-label="Edit message"]');
    buttons[buttons.length - 1].click();
    return true;
  });

const cancelEdit = () =>
  page((userTurnSel) => {
    const turn = [...document.querySelectorAll(userTurnSel)].at(-1);
    const cancel = turn && [...turn.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Cancel');
    cancel?.click();
    return Boolean(cancel);
  }, USER_TURN);

const clearFocusedField = async () => {
  await cdp('key', 'meta+a');
  await cdp('key', 'Delete');
};

const saveClippedScreenshot = async (file) => {
  const rect = await page((userTurnSel) => {
    const r = [...document.querySelectorAll(userTurnSel)].at(-1).getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, USER_TURN);
  const pad = 16;
  const { zoom } = (await raw('Page.getLayoutMetrics')).cssVisualViewport;
  const { data } = await raw('Page.captureScreenshot', {
    format: 'png',
    clip: {
      x: Math.max(0, rect.x - pad) * zoom,
      y: Math.max(0, rect.y - pad) * zoom,
      width: (rect.width + 2 * pad) * zoom,
      height: (rect.height + 2 * pad) * zoom,
      scale: 1,
    },
  });
  writeFileSync(file, Buffer.from(data, 'base64'));
};

const scenarios = [
  {
    name: 'empty composer: ArrowUp opens the last message in edit mode',
    async run() {
      const S = 'open-last-message';
      const expected = await lastMessageText();
      await cdp('click', COMPOSER);
      await cdp('key', 'up');
      check(S, 'edit field appears', await found(EDITOR));
      await sleep(500);
      const s = await snapshot();
      check(S, 'exactly one edit field is open', s.editorCount === 1, `count=${s.editorCount}`);
      check(S, 'edit field holds the last message text', s.editorText === expected, `expected "${expected}" got "${s.editorText}"`);
      check(S, 'edit field is focused', s.activeIsEditor);
      check(S, 'caret is at the end', s.caretAtEnd);
      check(S, 'keydown was default-prevented', s.lastKeydown?.defaultPrevented === true);
      if (s.activeIsEditor) {
        await cdp('type', '!');
        const typed = await snapshot();
        check(S, 'typing lands at the end of the text', typed.editorText === `${expected}!`, `got "${typed.editorText}"`);
      } else {
        check(S, 'typing lands at the end of the text', false, 'edit field not focused, nothing typed');
      }
      mkdirSync(outDir, { recursive: true });
      await saveClippedScreenshot(join(outDir, 'edit-mode.png'));
      check(S, 'cancel restores the thread', await cancelEdit());
    },
  },

  {
    name: 'composer with text: ArrowUp is left alone',
    async run() {
      const S = 'text-in-composer';
      await cdp('click', COMPOSER);
      await cdp('type', 'abc');
      try {
        await resetKeydowns();
        await cdp('key', 'up');
        await sleep(700);
        const s = await snapshot();
        check(S, 'no edit field opened', s.editorCount === 0);
        check(S, 'composer text is intact and focused', s.composerText === 'abc' && s.activeIsComposer, `text="${s.composerText}"`);
        check(S, 'keydown was not default-prevented', s.lastKeydown?.defaultPrevented === false);
      } finally {
        await cdp('click', COMPOSER);
        await clearFocusedField();
        check(S, 'draft cleaned up', (await snapshot()).composerText === '');
      }
    },
  },

  {
    name: 'modifier keys and IME composition are ignored',
    async run() {
      const S = 'ignored-inputs';
      await cdp('click', COMPOSER);
      for (const combo of ['shift+up', 'alt+up', 'ctrl+up', 'meta+up']) {
        await resetKeydowns();
        await cdp('key', combo);
        await sleep(300);
        const s = await snapshot();
        check(S, `${combo} does nothing`, s.editorCount === 0 && s.lastKeydown?.defaultPrevented === false);
      }
      const notPrevented = await page((composerSel) => {
        const composer = document.querySelector(composerSel);
        composer.focus();
        return composer.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowUp', isComposing: true, bubbles: true, cancelable: true }),
        );
      }, COMPOSER);
      await sleep(300);
      check(S, 'ArrowUp while isComposing does nothing', notPrevented && (await snapshot()).editorCount === 0);
    },
  },

  {
    name: 'last message already in edit mode: ArrowUp refocuses it',
    async run() {
      const S = 'already-editing';
      await openLastEditorWithoutFocus();
      check(S, 'precondition: edit field open', await found(EDITOR));
      await cdp('click', COMPOSER);
      await cdp('key', 'up');
      await sleep(600);
      const s = await snapshot();
      check(S, 'still exactly one edit field (previous message not opened)', s.editorCount === 1, `count=${s.editorCount}`);
      check(S, 'edit field is focused with the caret at the end', s.activeIsEditor && s.caretAtEnd);
    },
  },

  {
    name: 'empty edit field: ArrowUp inside it is ignored',
    async run() {
      const S = 'empty-edit-field';
      await openLastEditorWithoutFocus();
      check(S, 'precondition: edit field open', await found(EDITOR));
      await cdp('click', EDITOR);
      await clearFocusedField();
      check(S, 'precondition: edit field is empty', (await snapshot()).editorText === '');
      await resetKeydowns();
      await cdp('key', 'up');
      await sleep(600);
      const s = await snapshot();
      check(S, 'still exactly one edit field', s.editorCount === 1, `count=${s.editorCount}`);
      check(S, 'keydown was not default-prevented', s.lastKeydown?.defaultPrevented === false);
    },
  },

  {
    name: 'new chat with no messages: ArrowUp is a no-op',
    url: NEW_CHAT_URL,
    async run() {
      const S = 'no-messages';
      check(S, 'precondition: page has no user messages', (await page((sel) => document.querySelectorAll(sel).length, USER_TURN)) === 0);
      await cdp('click', COMPOSER);
      await cdp('key', 'up');
      await sleep(500);
      const s = await snapshot();
      check(S, 'no edit field opened', s.editorCount === 0);
      check(S, 'keydown was not default-prevented', s.lastKeydown?.defaultPrevented === false);
    },
  },
];

const anyTab = cli('list').split('\n')[0].slice(0, 8);
const { targetId } = JSON.parse(cli('evalraw', anyTab, 'Target.createTarget', JSON.stringify({ url: 'https://chatgpt.com/' })));
cli('list');
cli('eval', targetId.slice(0, 8), '1');
tabSocket = `/tmp/cdp-${targetId}.sock`;
let convoUrl = process.env.CONVERSATION_URL;

try {
  if (!convoUrl) {
    if (!(await found('a[href^="/c/"]', 20000))) throw new Error('no conversation in the sidebar');
    const href = await page(() => document.querySelector('a[href^="/c/"]').getAttribute('href'));
    convoUrl = new URL(href, 'https://chatgpt.com').href;
  }
  await load(convoUrl, USER_TURN);
  const userTurns = await page((sel) => document.querySelectorAll(sel).length, USER_TURN);
  check('setup', 'conversation has at least 2 user messages', userTurns >= 2, `userTurns=${userTurns}`);
  const build = await page(() => document.documentElement.dataset.build ?? null);

  for (const { name, url = convoUrl, run } of scenarios) {
    console.log(`\n# ${name}`);
    try {
      if (loaded !== url) await load(url, url === convoUrl ? USER_TURN : COMPOSER);
      await reset();
      await run();
    } catch (error) {
      check(name, 'scenario ran to completion', false, error.message.split('\n')[0]);
    }
  }

  const failed = results.filter((r) => !r.ok);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, 'result.json'),
    `${JSON.stringify({ chatgptBuild: build, userTurns, passed: results.length - failed.length, failed: failed.length, results }, null, 2)}\n`,
  );
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  await cdp('stop').catch(() => {});
  cli('evalraw', anyTab, 'Target.closeTarget', JSON.stringify({ targetId }));
}
