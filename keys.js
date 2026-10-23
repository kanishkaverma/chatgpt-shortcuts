globalThis.shortcutKeys = (() => {
  const MODIFIERS = ['ctrlKey', 'altKey', 'shiftKey', 'metaKey'];
  const DEFAULT_ARCHIVE = { code: 'KeyA', mods: ['ctrlKey', 'shiftKey'] };
  const SIDEBAR_KEYS = [
    { code: 'KeyJ', mods: ['ctrlKey', 'metaKey'], step: 1 },
    { code: 'KeyK', mods: ['ctrlKey', 'metaKey'], step: -1 },
    { code: 'KeyJ', mods: ['ctrlKey', 'shiftKey'], step: 1 },
    { code: 'KeyK', mods: ['ctrlKey', 'shiftKey'], step: -1 },
    { code: 'ArrowDown', mods: ['ctrlKey', 'shiftKey'], step: 1 },
    { code: 'ArrowUp', mods: ['ctrlKey', 'shiftKey'], step: -1 },
  ];

  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  const MOD_NAMES = { ctrlKey: 'Ctrl', altKey: isMac ? 'Option' : 'Alt', shiftKey: 'Shift', metaKey: isMac ? 'Cmd' : 'Win' };
  const KEY_NAMES = {
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
    Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
  };

  const isModifierCode = (code) => /^(Shift|Control|Alt|Meta|OS)(Left|Right)?$|^(CapsLock|Fn|FnLock)$/.test(code);
  const keyName = (code) =>
    /^Key[A-Z]$/.test(code) ? code.slice(3) : /^Digit\d$/.test(code) ? code.slice(5) : (KEY_NAMES[code] ?? code);
  const canonical = (mods) => MODIFIERS.filter((m) => mods.includes(m));
  const label = ({ code, mods }) => [...canonical(mods).map((m) => MOD_NAMES[m]), keyName(code)].join('+');
  const same = (a, b) => a.code === b.code && canonical(a.mods).join() === canonical(b.mods).join();
  const fromEvent = (e) => ({ code: e.code, mods: MODIFIERS.filter((m) => e[m]) });

  const problem = (combo) => {
    const wellFormed =
      typeof combo?.code === 'string' &&
      combo.code !== '' &&
      Array.isArray(combo.mods) &&
      combo.mods.every((m) => MODIFIERS.includes(m));
    if (!wellFormed) return 'That is not a key combination.';
    if (isModifierCode(combo.code)) return 'Press a key together with the modifiers.';
    if (!combo.mods.some((m) => m !== 'shiftKey')) {
      return `Hold Ctrl, ${MOD_NAMES.altKey} or ${MOD_NAMES.metaKey} as well, or the key would type text.`;
    }
    if (SIDEBAR_KEYS.some((k) => same(k, combo))) return `${label(combo)} already moves through the sidebar.`;
    return null;
  };

  const fromStorage = (value) => (problem(value) ? DEFAULT_ARCHIVE : { code: value.code, mods: canonical(value.mods) });

  return { MODIFIERS, DEFAULT_ARCHIVE, SIDEBAR_KEYS, isModifierCode, label, fromEvent, problem, fromStorage };
})();
