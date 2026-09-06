/* popup.js — settings and standalone launcher. */
(function () {
  'use strict';
  const depth = document.getElementById('depth');
  const hkCtrl = document.getElementById('hkCtrl');
  const hkShift = document.getElementById('hkShift');
  const hkAlt = document.getElementById('hkAlt');
  const hkKey = document.getElementById('hkKey');

  chrome.storage.local.get(['depth', 'hotkey'], (v) => {
    if (v.depth) depth.value = String(v.depth);
    if (v.hotkey) {
      hkCtrl.checked = !!v.hotkey.ctrl;
      hkShift.checked = !!v.hotkey.shift;
      hkAlt.checked = !!v.hotkey.alt;
      hkKey.value = (v.hotkey.key || 'E').toUpperCase();
    }
  });

  function saveHotkey() {
    chrome.storage.local.set({
      hotkey: { ctrl: hkCtrl.checked, shift: hkShift.checked, alt: hkAlt.checked, key: (hkKey.value || 'E').toUpperCase() },
    });
  }

  depth.addEventListener('change', () => chrome.storage.local.set({ depth: parseInt(depth.value, 10) }));
  [hkCtrl, hkShift, hkAlt].forEach((c) => c.addEventListener('change', saveHotkey));
  hkKey.addEventListener('input', saveHotkey);

  document.getElementById('openStandalone').addEventListener('click', () => {
    chrome.runtime.sendMessage({ channel: 'ui', type: 'OPEN_STANDALONE' });
  });
})();
