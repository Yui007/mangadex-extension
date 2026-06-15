// Default settings
const DEFAULTS = {
  downloadAs: 'images',
  concurrentChapters: 3,
  concurrentImages: 5,
  retryCount: 3,
  retryDelay: 1000, // ms
  stabilityChecks: 8, // Number of 250ms intervals
  overallTimeoutSeconds: 30, // seconds
  includeChapterNumber: false
};

// Get settings from storage, providing defaults if not set
async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(DEFAULTS, (settings) => {
      resolve(settings);
    });
  });
}

// Save settings to storage
async function saveSettings(settings) {
  return new Promise((resolve) => {
    chrome.storage.sync.set(settings, () => {
      resolve();
    });
  });
}