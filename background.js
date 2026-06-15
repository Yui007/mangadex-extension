importScripts('lib/jszip.min.js');

// --- Global State ---
let settings = {};
let chapterQueue = [];
let activeChapterWorkers = 0;

// --- Utility Functions ---
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

async function getSettings() {
  return new Promise(resolve => {
    chrome.storage.sync.get(DEFAULTS, settings => resolve(settings));
  });
}

async function loadSettings() {
  settings = await getSettings();
  console.log('Settings loaded:', settings);
}

function sanitizeFilenamePart(text) {
  return (text || '').toString().trim().replace(/[<>:"/\\|?*]+/g, '') || 'Chapter';
}

function extractChapterNumber(title) {
  const normalized = (title || '').toString().trim();
  const patterns = [
    /^(?:chapter|ch\.?|c)\.?\s*(\d+(?:\.\d+)?)/i,
    /(?:^|[\s(])(?:chapter|ch\.?|c)\.?\s*(\d+(?:\.\d+)?)(?=$|[\s):.-])/i
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match) {
      return match[1].replace(/^0+(?=\d)/, '');
    }
  }

  return null;
}

function normalizeChapterNumber(chapterNumber) {
  const match = (chapterNumber || '').toString().match(/\d+(?:\.\d+)?/);
  return match ? match[0].replace(/^0+(?=\d)/, '') : null;
}

function buildChapterFolderName(chapterTitle, chapterNumber, includeChapterNumber) {
  const cleanTitle = sanitizeFilenamePart(chapterTitle);
  if (!includeChapterNumber) {
    return cleanTitle;
  }

  const number = extractChapterNumber(chapterNumber || chapterTitle) || normalizeChapterNumber(chapterNumber);
  if (!number) {
    return cleanTitle;
  }

  const titleWithoutNumber = cleanTitle.replace(/^(?:Chapter|Ch\.?|C)\.?\s*\d+(?:\.\d+)?[:\-\s]*/i, '');
  return `Ch.${number}${titleWithoutNumber ? ` - ${titleWithoutNumber}` : ''}`;
}

// --- Main Logic ---
// Load settings on startup
loadSettings();

// Listen for settings changes
chrome.storage.onChanged.addListener(loadSettings);

// Listen for messages from the popup or content scripts
chrome.runtime.onMessage.addListener(async (request, sender, sendResponse) => {
  if (request.action === 'downloadAllChapters') {
    await loadSettings(); // Ensure settings are fresh
    // Add new chapters to the front of the queue
    chapterQueue.unshift(...request.chapters);
    console.log(`Added ${request.chapters.length} chapters to the queue. Total: ${chapterQueue.length}`);
    processChapterQueue();
  } else if (request.action === 'queueImageDownload') {
    if (settings.downloadAs === 'images') {
        // This action will be called from the content script for each image
        downloadImageWithRetry(request.url, request.filename, settings.retryCount);
    }
  } else if (request.action === 'downloadPdf') {
   chrome.downloads.download({
     url: request.url,
     filename: request.filename
   });
   // Close the offscreen document after the download is initiated
   chrome.offscreen.closeDocument();
  }
  return true; // Indicate async response
});

function processChapterQueue() {
  console.log(`Processing queue. Workers: ${activeChapterWorkers}/${settings.concurrentChapters}. Queue size: ${chapterQueue.length}`);
  while (activeChapterWorkers < settings.concurrentChapters && chapterQueue.length > 0) {
    activeChapterWorkers++;
    const chapter = chapterQueue.pop();
    console.log(`Starting worker for: ${chapter.url}`);
    processChapter(chapter);
  }

  if (chapterQueue.length === 0 && activeChapterWorkers === 0) {
    console.log('All chapters processed.');
  }
}

async function processChapter(chapter) {
    try {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

        // If the active tab is the one we want to process, use it directly.
        // Otherwise, open a new background tab.
        const shouldUseActiveTab = activeTab && activeTab.url.includes(chapter.url);

        const tabToUse = shouldUseActiveTab
            ? activeTab
            : await new Promise(resolve => chrome.tabs.create({ url: chapter.url, active: false }, resolve));

        const processAndCleanup = (tabId) => {
            const messageListener = (request, sender, sendResponse) => {
                if (sender.tab && sender.tab.id === tabId) {
                    if (request.action === 'getChapterDetails') {
                        sendResponse({
                            mangaTitle: chapter.mangaTitle,
                            chapterTitle: chapter.name,
                            chapterNumber: chapter.chapterNumber,
                            settings: settings
                        });
                        return true;
                    } else if (request.action === 'chapterProcessingComplete') {
                        console.log(`Chapter processing complete for tab ${tabId}.`);
                        const chapterWithDetectedNumber = { ...chapter, chapterNumber: request.chapterNumber || chapter.chapterNumber };
                        if (settings.downloadAs === 'zip') {
                            createArchive(request.imageUrls, chapter.mangaTitle, chapterWithDetectedNumber, 'zip');
                        } else if (settings.downloadAs === 'pdf') {
                            createPdfOffscreen(request.imageUrls, chapter.mangaTitle, chapterWithDetectedNumber);
                        }

                        // Only close the tab if we created a new one
                        if (!shouldUseActiveTab) {
                            chrome.tabs.remove(tabId);
                        }
                        chrome.runtime.onMessage.removeListener(messageListener);

                        activeChapterWorkers--;
                        processChapterQueue();
                    }
                }
            };
            chrome.runtime.onMessage.addListener(messageListener);

            chrome.scripting.executeScript({
                target: { tabId: tabId },
                files: ['content.js'],
            });
        };

        if (shouldUseActiveTab) {
            console.log(`Using active tab ${tabToUse.id} for processing.`);
            processAndCleanup(tabToUse.id);
        } else {
            // Listen for the new tab to finish loading before injecting script
            const tabUpdateListener = (tabId, info) => {
                if (tabId === tabToUse.id && info.status === 'complete') {
                    console.log(`Tab ${tabId} loaded. Injecting content script.`);
                    processAndCleanup(tabId);
                    chrome.tabs.onUpdated.removeListener(tabUpdateListener);
                }
            };
            chrome.tabs.onUpdated.addListener(tabUpdateListener);
        }

    } catch (error) {
        console.error(`Error processing chapter ${chapter.url}:`, error);
        activeChapterWorkers--;
        processChapterQueue();
    }
}

async function createArchive(imageUrls, mangaTitle, chapter, type) {
    const zip = new JSZip();
    const chapterFolderName = buildChapterFolderName(chapter.name, chapter.chapterNumber, settings.includeChapterNumber);
    const chapterFolder = zip.folder(chapterFolderName);

    const imagePromises = imageUrls.map(async (url, index) => {
        const response = await fetch(url);
        const blob = await response.blob();
        const filename = `${String(index + 1).padStart(3, '0')}.${blob.type.split('/')[1]}`;
        chapterFolder.file(filename, blob);
    });

    await Promise.all(imagePromises);

    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const filename = `${mangaTitle} - ${chapterFolderName}.${type}`;

    const reader = new FileReader();
    reader.onload = function() {
        chrome.downloads.download({
            url: reader.result,
            filename: filename
        });
    };
    reader.readAsDataURL(zipBlob);
}

// A global promise to manage the offscreen document lifecycle
let creating;

async function createPdfOffscreen(imageUrls, mangaTitle, chapter) {
    const chapterFolderName = buildChapterFolderName(chapter.name, chapter.chapterNumber, settings.includeChapterNumber);
    // Check if an offscreen document is already available.
    if (await chrome.offscreen.hasDocument()) {
        console.log("Offscreen document already exists. Sending message.");
        chrome.runtime.sendMessage({
            action: 'createPdfOffscreen',
            imageUrls,
            mangaTitle,
            chapter,
            chapterFolderName,
        });
        return;
    }

    // If we're in the process of creating a document, wait for it to finish.
    if (creating) {
        await creating;
    } else {
        creating = chrome.offscreen.createDocument({
            url: 'offscreen.html',
            reasons: ['BLOBS'],
            justification: 'Needed to convert images to PDF format.',
        });
        await creating;
        creating = null; // Reset the promise
    }
    
    console.log("Offscreen document created. Sending message.");
    // Now that the document is confirmed to exist, send the message
    chrome.runtime.sendMessage({
        action: 'createPdfOffscreen',
        imageUrls,
        mangaTitle,
        chapter,
        chapterFolderName,
    });
}

async function downloadImageWithRetry(url, filename, retries) {
  try {
    await new Promise((resolve, reject) => {
      chrome.downloads.download({ url, filename, conflictAction: 'overwrite' }, (downloadId) => {
        if (chrome.runtime.lastError) {
          return reject(chrome.runtime.lastError);
        }
        // Monitor download status
        const downloadListener = (delta) => {
          if (delta.id === downloadId && delta.state) {
            if (delta.state.current === 'complete') {
              chrome.downloads.onChanged.removeListener(downloadListener);
              resolve();
            } else if (delta.state.current === 'interrupted') {
              chrome.downloads.onChanged.removeListener(downloadListener);
              reject(new Error(`Download interrupted. Reason: ${delta.error.current}`));
            }
          }
        };
        chrome.downloads.onChanged.addListener(downloadListener);
      });
    });
    console.log(`Successfully downloaded ${filename}`);
  } catch (error) {
    console.error(`Download failed for ${filename}:`, error.message);
    if (retries > 0) {
      console.log(`Retrying... (${retries} attempts left)`);
      await new Promise(resolve => setTimeout(resolve, settings.retryDelay));
      await downloadImageWithRetry(url, filename, retries - 1);
    } else {
      console.error(`All retries failed for ${filename}.`);
    }
  }
}