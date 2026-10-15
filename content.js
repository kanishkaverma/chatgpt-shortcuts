(() => {
  const SELECTORS = {
    composer: '[data-composer-input] [contenteditable="true"]',
    userTurn: '[data-content-search-unit-key$=":user"]',
    editButton: 'button[aria-label="Edit message"]',
    editor: '[contenteditable="true"]',
  };

  const MODIFIERS = ['ctrlKey', 'metaKey', 'altKey', 'shiftKey'];

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

  const SHORTCUTS = [
    {
      key: 'ArrowUp',
      when: (e) => isEmptyComposer(e.target) && Boolean(lastUserTurn()),
      run: editLastMessage,
    },
  ];

  const matches = (shortcut, e) =>
    e.key === shortcut.key &&
    MODIFIERS.every((m) => e[m] === (shortcut.mods ?? []).includes(m));

  document.addEventListener(
    'keydown',
    (e) => {
      if (e.isComposing) return;
      const shortcut = SHORTCUTS.find((s) => matches(s, e) && s.when(e));
      if (!shortcut) return;
      e.preventDefault();
      shortcut.run(e);
    },
    true,
  );
})();
