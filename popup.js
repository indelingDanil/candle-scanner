document.getElementById('open').addEventListener('click', async () => {
  const err = document.getElementById('err');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) throw new Error('Нет активной вкладки');
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['analyzer.js', 'content.js'],
    });
    window.close();
  } catch (e) {
    err.textContent = 'Не удалось запустить на этой странице: ' + (e.message || e);
  }
});
