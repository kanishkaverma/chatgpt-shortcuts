# ChatGPT Shortcuts

<img src="icons/icon128.png" width="96" alt="ChatGPT Shortcuts logo">

A Manifest V3 Chrome extension that adds keyboard shortcuts to https://chatgpt.com/.

## Install

1. Download this repo: **Code → Download ZIP** on GitHub, then unzip it (or `git clone`).
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the unzipped folder (the one containing `manifest.json`).
5. Reload any open chatgpt.com tab. The content script only attaches on page load.

## Shortcuts

| Keys | When | What it does |
| --- | --- | --- |
| `ArrowUp` | The composer is focused and empty | Opens your last sent message in edit mode and puts the caret at the end. |
| `Ctrl+Cmd+J`, `Ctrl+Shift+↓` or `Ctrl+Shift+J` | Anywhere | Moves to the next chat in the sidebar. The first press opens the sidebar if it is collapsed and lands on the chat you are in. |
| `Ctrl+Cmd+K`, `Ctrl+Shift+↑` or `Ctrl+Shift+K` | Anywhere | Moves to the previous chat in the sidebar. |
| `Enter` | A sidebar chat is focused | Opens that chat, closes the sidebar if the shortcut opened it, and puts the cursor in the composer. |
| `Escape` | A sidebar chat is focused | Goes back to the composer and closes the sidebar if the shortcut opened it. |
| `Ctrl+Shift+A` | You are in a saved conversation (`/c/<id>`) | Archives the conversation. ChatGPT then drops it from the sidebar and opens a new chat. |

The sidebar shortcuts walk every chat the sidebar shows, in order: Pinned first, then Recents. They stop at the first and last chat.

`Ctrl+Cmd+J/K` is the main vim binding because it reaches the page in Helium, where `Ctrl+J` and `Ctrl+K` do not, and no browser or macOS shortcut uses it. `Ctrl+Shift+J/K` is bound too and works in browsers that pass it through.

`Ctrl+Shift+A` opens the conversation's `⋯` menu in the header and picks **Archive**, so ChatGPT does the archiving and updates its own UI. Outside a conversation, such as the home page or a temporary chat that has no `/c/` URL yet, the key passes through to the page untouched. If the menu has no Archive item, the script closes the menu and does nothing else.

Surfingkeys maps `<Ctrl-a>` in insert mode and swallows it before any other script sees it. A real `Ctrl+Shift+A` reaches the page as key `A`, which Surfingkeys does not map, so the shortcut still works with Surfingkeys installed.

`ArrowUp` is left alone when the composer has text, when any of Ctrl, Cmd, Alt or Shift is held, while an IME is composing, when the thread has no user messages, and inside an edit field. If your last message is already being edited, `ArrowUp` refocuses that edit field instead of opening the previous message.

## Add a shortcut

Append one object to `SHORTCUTS` in `content.js`.

```js
{
  key: 'k',
  mods: ['metaKey', 'shiftKey'],
  when: (e) => true,
  run: (e) => { /* ... */ },
}
```

`key` is `KeyboardEvent.key`. `mods` is the exact set of modifiers that must be held (default none). `when` decides if the shortcut applies to this event. `run` does the work, and the dispatcher calls `preventDefault()` before it. The shortcut is a capture-phase `keydown` listener, so it runs before ProseMirror sees the key.

## Selectors

All page selectors live in `SELECTORS` at the top of `content.js`. They were read from the live chatgpt.com DOM (build `e72a420e234c`), not guessed. `[data-message-author-role]` and `#prompt-textarea` do not exist in that build.

| Name | Selector | Why |
| --- | --- | --- |
| `composer` | `[data-composer-input] [contenteditable="true"]` | The main composer is a ProseMirror `contenteditable`. The edit-message field is also a ProseMirror, so a bare `.ProseMirror` would match it. Only the main composer sits inside `[data-composer-input]`. |
| `userTurn` | `[data-content-search-unit-key$=":user"]` | One wrapper per user message that stays in the DOM in both read and edit mode. `[data-user-message-bubble]` disappears in edit mode. |
| `editButton` | `button[aria-label="Edit message"]` | The pencil. It is always in the DOM and only hidden with `opacity-0` until hover, so `click()` works without synthesizing hover events. |
| `sidebarChat` | `nav[aria-label="Chat history"] a[href*="/c/"]` | Every chat row is a link inside the Chat history nav. The links stay in the DOM when the sidebar is collapsed, so the script only counts visible ones. The open chat has `aria-current="page"`. |
| `showSidebar`, `hideSidebar` | `button[aria-label="Show sidebar"]`, `button[aria-label="Hide sidebar"]` | Several copies exist and only one is visible at a time, so the script clicks the visible one. |
| `threadMenu` | `header[data-app-shell-titlebar] button[aria-label="More"]` | The `⋯` button in the conversation header. Radix opens it on `pointerdown`, not `click`, so the script dispatches a pointer event. |
| `menuItem` | `[role="menuitem"]` | The menu rows. The script matches the one whose text is exactly `Archive`. |
| `editor` | `[contenteditable="true"]` inside the user turn | The edit field is a ProseMirror `contenteditable`, not a `textarea`. ChatGPT does not focus it, so the script does. |

When ChatGPT changes its DOM, update `SELECTORS` and rerun the E2E below.

## E2E verification

`e2e/run.mjs` drives the real, logged-in chatgpt.com in Helium over CDP. It opens its own tab, runs `content.js` in an isolated world the way Chrome does for extensions, presses keys with trusted CDP input events, asserts on the DOM, and closes the tab. It sends no messages.

Requirements are Helium running with `--remote-debugging-port=9223`, a logged-in chatgpt.com session, and the `helium-cdp` skill (set `CDP=/path/to/cdp.mjs` to override its location).

```sh
node e2e/run.mjs
CONVERSATION_URL=https://chatgpt.com/c/<id> node e2e/run.mjs
```

The conversation needs at least 2 user messages and an empty composer draft. The default is the first conversation in the sidebar. The run fails instead of deleting a draft it did not create.

It checks eight behaviors.

- ArrowUp in an empty composer opens the last message in edit mode, focused, with the caret at the end. Typing then appends to the text.
- ArrowUp with text in the composer is not default-prevented and opens nothing.
- Shift, Alt, Ctrl and Meta with ArrowUp, and ArrowUp during IME composition, do nothing.
- ArrowUp when the last message is already in edit mode refocuses it and does not open the previous message.
- ArrowUp inside an empty edit field does nothing.
- ArrowUp on a new chat with no messages is a no-op and is not default-prevented.
- Ctrl+Cmd+J/K, Ctrl+Shift+↓/↑ and Ctrl+Shift+J/K open the collapsed sidebar on the current chat, move one chat at a time, and stop at the first chat. Escape returns to the composer and closes the sidebar. Plain `j` still types.
- Enter on a focused sidebar chat opens it, closes the sidebar, and leaves the cursor in the opened chat's composer.

`e2e/archive.mjs` checks `Ctrl+Shift+A`. It sends one throwaway message per run ("archive shortcut e2e N, reply with just ok") to create a chat it owns, presses `Ctrl+Shift+A` in that chat's composer, and checks that the page leaves the chat, the chat drops out of the sidebar, no menu stays open, and `GET /backend-api/conversation/<id>` reports `is_archived: true`. Then it deletes the chat. It also checks that `Ctrl+Shift+A` on the home page does nothing and is not default-prevented. It refuses to run if the home composer holds a draft, because it would send it.

```sh
node e2e/archive.mjs                 # 3 archive runs
ARCHIVE_RUNS=1 node e2e/archive.mjs
```

It writes `archive-result.json` and `archive-after.png` (the page right after the first archive). The harness sends key `A` with Ctrl and Shift held, as a real keyboard does. The helium-cdp `key ctrl+shift+a` command sends lowercase `a` instead, which Surfingkeys swallows.

Artifacts land in `e2e/artifacts/` (gitignored, since they contain conversation text). `result.json` has every check with the ChatGPT build id. `edit-mode.png` shows the edit field after the shortcut and a typed `!`, with the caret at the end.

Known quirks of the harness.

- Helium swallows `Ctrl+J`/`Ctrl+K` before the page sees them, so the `Ctrl+Shift+J/K` steps dispatch a synthetic `keydown`. Every other key in the sidebar flow is a real CDP key press.
- After a chat switch ChatGPT detaches and remounts the composer and calls `blur()` on it each time. For 3 seconds after Enter the script refocuses the composer whenever focus falls back to `<body>`. During the switch the page briefly holds two composers, a hidden one and the visible one, so the script always targets the visible one.

- ChatGPT answers HTTP 429 on `/backend-api/conversations/<id>` when a conversation is reloaded many times in a short period. A normal run loads the conversation once. `load` retries with backoff if the page shows "Could not load this ChatGPT conversation".
- Per-tab commands go straight to the helium-cdp daemon socket. On this machine the helium-cdp CLI process is killed with SIGKILL when its arguments pass about 1000 characters, and `content.js` is longer than that.
- A global pre-commit hook strips code comments in this repo, so reasoning lives in this README.
