(() => {
  const MODIFIERS = ['ctrlKey', 'metaKey', 'altKey', 'shiftKey'];

  const SHORTCUTS = [];

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
