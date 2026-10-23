(() => {
  const { MODIFIERS, DEFAULT_ARCHIVE, SIDEBAR_KEYS, label, fromStorage } = shortcutKeys;

  const SELECTORS = {
    composer: '[data-composer-input] [contenteditable="true"]',
    userTurn: '[data-content-search-unit-key$=":user"]',
    editButton: 'button[aria-label="Edit message"]',
    editor: '[contenteditable="true"]',
    sidebarChat: 'nav[aria-label="Chat history"] a[href*="/c/"]',
    showSidebar: 'button[aria-label="Show sidebar"]',
    hideSidebar: 'button[aria-label="Hide sidebar"]',
    threadMenu: 'header[data-app-shell-titlebar] button[aria-label="More"]',
    menuItem: '[role="menuitem"]',
  };

  const lastUserTurn = () => [...document.querySelectorAll(SELECTORS.userTurn)].at(-1);

  const isEmptyComposer = (el) => {
    const composer = el.closest?.(SELECTORS.composer);
    return Boolean(composer) && composer.textContent.trim() === '';
  };

  const waitFor = (find, timeoutMs = 1500) =>
    new Promise((resolve) => {
      const hit = find();
      if (hit) return resolve(hit);
      const observer = new MutationObserver(() => {
        const el = find();
        if (el) finish(el);
      });
      const timer = setTimeout(() => finish(null), timeoutMs);
      function finish(el) {
        observer.disconnect();
        clearTimeout(timer);
        resolve(el);
      }
      observer.observe(document.body, { childList: true, subtree: true });
    });

  const focusAtEnd = (el) => {
    el.focus();
    const selection = getSelection();
    selection.selectAllChildren(el);
    selection.collapseToEnd();
  };

  const editLastMessage = async () => {
    const findEditor = () => lastUserTurn()?.querySelector(SELECTORS.editor);
    if (!findEditor()) lastUserTurn()?.querySelector(SELECTORS.editButton)?.click();
    const editor = await waitFor(findEditor);
    if (editor) focusAtEnd(editor);
  };

  const isVisible = (el) => el.getClientRects().length > 0;
  const firstVisible = (selector) => [...document.querySelectorAll(selector)].find(isVisible);
  const sidebarChats = () => [...document.querySelectorAll(SELECTORS.sidebarChat)].filter(isVisible);
  const focusedSidebarChat = () => document.activeElement?.closest?.(SELECTORS.sidebarChat);
  const focusComposer = () => firstVisible(SELECTORS.composer)?.focus();

  let weOpenedSidebar = false;

  const openSidebar = async () => {
    if (sidebarChats().length) return sidebarChats();
    firstVisible(SELECTORS.showSidebar)?.click();
    weOpenedSidebar = Boolean(await waitFor(() => sidebarChats()[0]));
    return sidebarChats();
  };

  const restoreSidebar = () => {
    if (weOpenedSidebar) firstVisible(SELECTORS.hideSidebar)?.click();
    weOpenedSidebar = false;
  };

  const moveInSidebar = (step) => async () => {
    const chats = await openSidebar();
    if (!chats.length) return;
    const at = chats.indexOf(focusedSidebarChat());
    const next =
      at === -1
        ? (chats.find((a) => a.getAttribute('aria-current') === 'page') ?? chats[0])
        : chats[Math.min(Math.max(at + step, 0), chats.length - 1)];
    next.focus({ focusVisible: true });
    next.scrollIntoView({ block: 'nearest' });
  };

  const openFocusedChat = () => {
    const link = focusedSidebarChat();
    link.click();
    restoreSidebar();
    keepComposerFocused();
  };

  const keepComposerFocused = (ms = 3000) => {
    const refocus = () => {
      if ((document.activeElement ?? document.body) === document.body) focusComposer();
    };
    const observer = new MutationObserver(refocus);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    setTimeout(() => observer.disconnect(), ms);
    focusComposer();
  };

  const leaveSidebar = () => {
    restoreSidebar();
    focusComposer();
  };

  const inConversation = () => /\/c\/[^/]+/.test(location.pathname);

  const openThreadMenu = (trigger) => {
    const init = { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' };
    trigger.dispatchEvent(new PointerEvent('pointerdown', init));
    trigger.dispatchEvent(new PointerEvent('pointerup', init));
  };

  const archiveThread = async () => {
    const trigger = firstVisible(SELECTORS.threadMenu);
    if (!trigger) return;
    if (trigger.getAttribute('aria-expanded') !== 'true') openThreadMenu(trigger);
    const archive = await waitFor(() =>
      [...document.querySelectorAll(SELECTORS.menuItem)].find((m) => m.innerText.trim() === 'Archive'),
    );
    if (archive) archive.click();
    else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  };

  const inSidebar = () => Boolean(focusedSidebarChat());

  const archive = { ...DEFAULT_ARCHIVE, when: inConversation, run: archiveThread };
  const applyArchiveKeys = (stored) => {
    Object.assign(archive, fromStorage(stored));
    document.documentElement.dataset.chatgptShortcutsArchive = label(archive);
  };
  chrome.storage.sync.get('archive').then(({ archive: stored }) => applyArchiveKeys(stored));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && 'archive' in changes) applyArchiveKeys(changes.archive.newValue);
  });

  const SHORTCUTS = [
    {
      key: 'ArrowUp',
      when: (e) => isEmptyComposer(e.target) && Boolean(lastUserTurn()),
      run: editLastMessage,
    },
    ...SIDEBAR_KEYS.map(({ code, mods, step }) => ({ code, mods, run: moveInSidebar(step) })),
    archive,
    { key: 'Enter', when: inSidebar, run: openFocusedChat },
    { key: 'Escape', when: inSidebar, run: leaveSidebar },
  ];

  const matches = (shortcut, e) =>
    (shortcut.code ? e.code === shortcut.code : e.key === shortcut.key) &&
    MODIFIERS.every((m) => e[m] === (shortcut.mods ?? []).includes(m));

  document.addEventListener(
    'keydown',
    (e) => {
      if (e.isComposing) return;
      const shortcut = SHORTCUTS.find((s) => matches(s, e) && (s.when?.(e) ?? true));
      if (!shortcut) return;
      e.preventDefault();
      shortcut.run(e);
    },
    true,
  );
})();
