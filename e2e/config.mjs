#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  COMPOSER,
  READY_ATTR,
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

const { check, write } = report('config-result.json');

const stored = (opts) => opts.page(async () => (await chrome.storage.sync.get('archive')).archive ?? null);
const setStored = (opts, value) =>
  opts.page(async (v) => (v === null ? chrome.storage.sync.remove('archive') : chrome.storage.sync.set({ archive: v })), value);

const ui = (opts) =>
  opts.page(() => {
    const button = document.querySelector('#archive-keys');
    const status = document.querySelector('#status');
    return {
      label: button?.textContent.trim() ?? null,
      recording: button?.getAttribute('aria-pressed') === 'true',
      status: status?.textContent.trim() ?? '',
      tone: status?.dataset.tone ?? null,
      lastKeydown: window.__keydowns?.at(-1) ?? null,
    };
  });

const reloadOptions = async (opts, url) => {
  await opts.cdp('nav', url);
  await until(() => opts.page(() => Boolean(document.querySelector('#archive-keys')?.textContent.trim())), 5000);
  await opts.page(() => {
    window.__keydowns = [];
    window.addEventListener('keydown', (e) => window.__keydowns.push({ key: e.key, defaultPrevented: e.defaultPrevented }), true);
    return true;
  });
};

const startRecording = async (opts) => {
  await opts.cdp('click', '#archive-keys');
  return (await ui(opts)).recording;
};

const marker = (chat) => chat.page((attr) => document.documentElement.dataset[attr] ?? null, READY_ATTR);
const markerBecomes = (chat, want) => until(async () => (await marker(chat)) === want, 3000);

const pressAndStay = async (chat, path, code, mods) => {
  await chat.cdp('click', COMPOSER);
  await chat.press(code, mods);
  await sleep(1500);
  return chatState(chat);
};

const CTRL_ALT_X = { code: 'KeyX', mods: ['ctrlKey', 'altKey'] };
const ALT_SHIFT_Z = { code: 'KeyZ', mods: ['altKey', 'shiftKey'] };

const extensionId = await loadExtension();
const optionsUrl = `chrome-extension://${extensionId}/options.html`;
console.log(`loaded extension ${extensionId}`);
const opts = await openTab(optionsUrl);
let chat;
let before;
let convo;

try {
  before = await stored(opts);
  await setStored(opts, null);
  await reloadOptions(opts, optionsUrl);

  {
    const S = 'settings-page';
    const s = await ui(opts);
    check(S, 'shows Ctrl+Shift+A when nothing is saved', s.label === 'Ctrl+Shift+A', `label=${s.label}`);
    check(S, 'clicking the shortcut starts recording', await startRecording(opts));

    await opts.press('ShiftLeft', ['shiftKey']);
    let r = await ui(opts);
    check(S, 'a lone modifier keeps recording and saves nothing', r.recording && (await stored(opts)) === null);

    for (const [name, code, mods] of [
      ['Shift+A', 'KeyA', ['shiftKey']],
      ['plain A', 'KeyA', []],
    ]) {
      await opts.press(code, mods);
      r = await ui(opts);
      check(S, `${name} is rejected because it would type text`, r.tone === 'error' && r.recording && (await stored(opts)) === null, JSON.stringify(r));
    }

    await opts.press('KeyJ', ['ctrlKey', 'metaKey']);
    r = await ui(opts);
    check(S, 'Ctrl+Cmd+J is rejected because the sidebar uses it', r.tone === 'error' && /sidebar|already/i.test(r.status) && (await stored(opts)) === null, JSON.stringify(r));

    await opts.press('Escape');
    r = await ui(opts);
    check(S, 'Escape cancels recording and keeps Ctrl+Shift+A', !r.recording && r.label === 'Ctrl+Shift+A' && (await stored(opts)) === null, JSON.stringify(r));

    await startRecording(opts);
    await opts.press(CTRL_ALT_X.code, CTRL_ALT_X.mods);
    r = await ui(opts);
    const saved = await stored(opts);
    check(S, 'Ctrl+Option+X is saved', saved?.code === 'KeyX' && [...saved.mods].sort().join() === 'altKey,ctrlKey', JSON.stringify(saved));
    check(S, 'the page shows Ctrl+Option+X and stops recording', r.label === 'Ctrl+Option+X' && !r.recording && r.tone !== 'error', JSON.stringify(r));
    check(S, 'the recorded key press is default-prevented', r.lastKeydown?.defaultPrevented === true, JSON.stringify(r.lastKeydown));

    await reloadOptions(opts, optionsUrl);
    check(S, 'the setting survives a reload of the settings page', (await ui(opts)).label === 'Ctrl+Option+X');
  }

  chat = await openTab('https://chatgpt.com/');
  {
    const S = 'chatgpt-page';
    await openHome(chat);
    check(S, 'a freshly loaded page uses the saved Ctrl+Option+X', (await marker(chat)) === 'Ctrl+Option+X', `marker=${await marker(chat)}`);

    convo = await createThrowawayChat(chat, 'configurable archive key e2e');
    check(S, 'precondition: the chat is not archived', (await backend(chat, convo.id)).is_archived === false);

    let s = await pressAndStay(chat, convo.path, 'KeyA', ['ctrlKey', 'shiftKey']);
    check(S, 'the old Ctrl+Shift+A no longer archives', s.path === convo.path && (await backend(chat, convo.id)).is_archived === false, `path=${s.path}`);
    check(S, 'the old Ctrl+Shift+A is not default-prevented', s.lastKeydown?.defaultPrevented === false, JSON.stringify(s.lastKeydown));

    await startRecording(opts);
    await opts.press(ALT_SHIFT_Z.code, ALT_SHIFT_Z.mods);
    check(S, 'an open ChatGPT tab picks up a new key without a reload', await markerBecomes(chat, 'Option+Shift+Z'), `marker=${await marker(chat)}`);

    s = await pressAndStay(chat, convo.path, CTRL_ALT_X.code, CTRL_ALT_X.mods);
    check(S, 'the replaced Ctrl+Option+X no longer archives', s.path === convo.path && (await backend(chat, convo.id)).is_archived === false, `path=${s.path}`);

    await chat.cdp('click', COMPOSER);
    await chat.press(ALT_SHIFT_Z.code, ALT_SHIFT_Z.mods);
    const left = await until(async () => {
      const st = await chatState(chat);
      return st.path !== convo.path && st;
    }, 5000);
    check(S, 'Option+Shift+Z archives and leaves the chat', Boolean(left), `still on ${convo.path}`);
    const server = await until(async () => (await backend(chat, convo.id)).is_archived === true, 5000);
    check(S, 'the server marks the chat archived', server);
    const { data } = await chat.raw('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(outDir, 'config-after-archive.png'), Buffer.from(data, 'base64'));
  }

  {
    const S = 'bad-and-reset';
    await setStored(opts, 'garbage');
    check(S, 'a corrupt stored value falls back to Ctrl+Shift+A in ChatGPT', await markerBecomes(chat, 'Ctrl+Shift+A'), `marker=${await marker(chat)}`);
    await reloadOptions(opts, optionsUrl);
    check(S, 'a corrupt stored value shows Ctrl+Shift+A on the settings page', (await ui(opts)).label === 'Ctrl+Shift+A');

    await setStored(opts, CTRL_ALT_X);
    await markerBecomes(chat, 'Ctrl+Option+X');
    await reloadOptions(opts, optionsUrl);
    await opts.cdp('click', '#archive-reset');
    await sleep(300);
    const r = await ui(opts);
    check(S, 'Reset clears the saved key', (await stored(opts)) === null, JSON.stringify(await stored(opts)));
    check(S, 'Reset shows Ctrl+Shift+A', r.label === 'Ctrl+Shift+A', `label=${r.label}`);
    check(S, 'Reset reaches the open ChatGPT tab', await markerBecomes(chat, 'Ctrl+Shift+A'), `marker=${await marker(chat)}`);
    const { data } = await opts.raw('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(outDir, 'config-settings.png'), Buffer.from(data, 'base64'));
  }
} catch (error) {
  check('run', 'ran to completion', false, error.message.split('\n')[0]);
} finally {
  if (convo) await backend(chat, convo.id, { is_visible: false }).catch(() => {});
  await setStored(opts, before ?? null).catch(() => {});
  write({ extensionId });
  await chat?.close();
  await opts.close();
}
