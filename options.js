(() => {
  const { DEFAULT_ARCHIVE, isModifierCode, label, fromEvent, problem, fromStorage } = shortcutKeys;
  const button = document.querySelector('#archive-keys');
  const reset = document.querySelector('#archive-reset');
  const status = document.querySelector('#status');

  let current = DEFAULT_ARCHIVE;
  let recording = false;

  const say = (text, tone = 'info') => {
    status.textContent = text;
    status.dataset.tone = tone;
  };

  const render = () => {
    button.setAttribute('aria-pressed', String(recording));
    button.textContent = recording ? 'Press new keys…' : label(current);
  };

  const setRecording = (on) => {
    recording = on;
    render();
  };

  button.addEventListener('click', () => {
    setRecording(true);
    say('Press the keys you want. Escape cancels.');
  });

  window.addEventListener(
    'keydown',
    async (e) => {
      if (!recording) return;
      e.preventDefault();
      e.stopPropagation();
      if (isModifierCode(e.code)) return;
      const combo = fromEvent(e);
      if (e.code === 'Escape' && combo.mods.length === 0) {
        setRecording(false);
        say('');
        return;
      }
      const why = problem(combo);
      if (why) {
        say(why, 'error');
        return;
      }
      await chrome.storage.sync.set({ archive: combo });
      current = combo;
      setRecording(false);
      say(`Saved. ${label(combo)} archives the conversation.`, 'ok');
    },
    true,
  );

  reset.addEventListener('click', async () => {
    await chrome.storage.sync.remove('archive');
    current = DEFAULT_ARCHIVE;
    setRecording(false);
    say(`Back to ${label(DEFAULT_ARCHIVE)}.`, 'ok');
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !('archive' in changes) || recording) return;
    current = fromStorage(changes.archive.newValue);
    render();
  });

  chrome.storage.sync.get('archive').then(({ archive }) => {
    current = fromStorage(archive);
    render();
  });
})();
