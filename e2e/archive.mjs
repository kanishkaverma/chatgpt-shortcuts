#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  COMPOSER,
  backend,
  chatState,
  createThrowawayChat,
  loadExtension,
  openHome,
  openTab,
  outDir,
  report,
  sleep,
  until,
} from './lib.mjs';

const RUNS = Number(process.env.ARCHIVE_RUNS ?? 3);
const CTRL_SHIFT_A = ['KeyA', ['ctrlKey', 'shiftKey']];
const { check, write } = report('archive-result.json');

const extensionId = await loadExtension();
const opts = await openTab(`chrome-extension://${extensionId}/options.html`);
const savedKeys = await opts.page(async () => (await chrome.storage.sync.get('archive')).archive ?? null);
await opts.page(() => chrome.storage.sync.remove('archive'));
const tab = await openTab('https://chatgpt.com/');

const negativeOnHome = async () => {
  const S = 'home-page';
  await openHome(tab);
  await tab.cdp('click', COMPOSER);
  await tab.press(...CTRL_SHIFT_A);
  await sleep(700);
  const s = await chatState(tab);
  check(S, 'Ctrl+Shift+A outside a conversation is not default-prevented', s.lastKeydown?.defaultPrevented === false, JSON.stringify(s.lastKeydown));
  check(S, 'no menu opens', !s.menuOpen);
};

const archiveOnce = async (n) => {
  const S = `archive-run-${n}`;
  const { path, id } = await createThrowawayChat(tab, `archive shortcut e2e ${n}`);
  try {
    check(S, 'precondition: the chat is not archived', (await backend(tab, id)).is_archived === false);
    await tab.cdp('click', COMPOSER);
    const started = Date.now();
    await tab.press(...CTRL_SHIFT_A);
    const after = await until(async () => {
      const s = await chatState(tab);
      return s.path !== path && s;
    }, 5000);
    check(S, 'leaves the archived chat', Boolean(after), `still on ${path}`);
    const s = after || (await chatState(tab));
    console.log(`      left ${path} for ${s.path} after ${Date.now() - started}ms`);
    check(S, 'keydown was default-prevented', s.lastKeydown?.defaultPrevented === true, JSON.stringify(s.lastKeydown));
    const gone = await until(async () => !(await chatState(tab)).sidebar.includes(path), 5000);
    check(S, 'the chat is gone from the sidebar', gone);
    check(S, 'no menu is left open', !(await chatState(tab)).menuOpen);
    const server = await until(async () => (await backend(tab, id)).is_archived === true, 5000);
    check(S, 'the server marks the chat archived', server, JSON.stringify(await backend(tab, id)));
    if (n === 1) {
      const { data } = await tab.raw('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(outDir, 'archive-after.png'), Buffer.from(data, 'base64'));
    }
  } finally {
    await backend(tab, id, { is_visible: false });
  }
};

try {
  await negativeOnHome();
  for (let n = 1; n <= RUNS; n++) {
    try {
      await archiveOnce(n);
    } catch (error) {
      check(`archive-run-${n}`, 'scenario ran to completion', false, error.message.split('\n')[0]);
    }
  }
  write({ extensionId, chatgptBuild: await tab.page(() => document.documentElement.dataset.build ?? null), runs: RUNS });
} finally {
  if (savedKeys) await opts.page((v) => chrome.storage.sync.set({ archive: v }), savedKeys);
  await tab.close();
  await opts.close();
}
