const DEFAULTS = {
  downloadAs: 'images',
  concurrentChapters: 3,
  concurrentImages: 5,
  retryCount: 3,
  retryDelay: 1000,
  dataSaver: false,
  includeChapterNumber: false,
};

async function getSettings() {
  return new Promise(resolve => {
    chrome.storage.sync.get(DEFAULTS, settings => resolve(settings));
  });
}

async function saveSettings(settings) {
  return new Promise(resolve => {
    chrome.storage.sync.set(settings, () => resolve());
  });
}
