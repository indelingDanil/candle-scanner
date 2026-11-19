(async () => {
  const I = window.CandleI18n;
  const T = I.dict[await I.load()];
  const btn = document.getElementById('open');
  const err = document.getElementById('err');
  btn.textContent = T.popupOpen;
  document.getElementById('note').textContent = T.popupNote;
  document.documentElement.lang = T === I.dict.ru ? 'ru' : 'en';

  btn.addEventListener('click', async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) throw new Error(T.popupNoTab);
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['i18n.js', 'analyzer.js', 'content.js'],
      });
      window.close();
    } catch (e) {
      err.textContent = T.popupFail(e.message || e);
    }
  });
})();
