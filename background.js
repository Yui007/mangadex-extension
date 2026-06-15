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
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  (async () => {
    console.log(`[msg] Received action: "${request.action}" from`, sender.tab ? `tab ${sender.tab.id}` : 'extension');
    if (request.action === 'downloadAllChapters') {
      await loadSettings(); // Ensure settings are fresh
      // Add new chapters to the front of the queue
      chapterQueue.unshift(...request.chapters);
      console.log(`[queue] Added ${request.chapters.length} chapters to the queue. Total: ${chapterQueue.length}, downloadAs: ${settings.downloadAs}`);
      processChapterQueue();
    } else if (request.action === 'queueImageDownload') {
      console.log(`[download] queueImageDownload: ${request.filename}`);
      if (settings.downloadAs === 'images') {
        // This action will be called from the content script for each image
        downloadImageWithRetry(request.url, request.filename, settings.retryCount);
      } else {
        console.warn(`[download] Ignoring queueImageDownload because downloadAs is "${settings.downloadAs}", not "images"`);
      }
    } else if (request.action === 'downloadPdf') {
      console.log(`[pdf] downloadPdf: ${request.filename}`);
      if (!request.url || !request.filename) {
        throw new Error('PDF download request is missing a URL or filename.');
      }

      chrome.downloads.download({
        url: request.url,
        filename: request.filename,
        conflictAction: 'overwrite'
      }, (downloadId) => {
        if (chrome.runtime.lastError) {
          console.error('[pdf] Failed to start PDF download:', chrome.runtime.lastError.message);
          return;
        }
        console.log(`[pdf] Started PDF download: ${request.filename} (${downloadId})`);
      });

      // Close the offscreen document after the download is initiated.
      if (chrome.offscreen?.hasDocument && await chrome.offscreen.hasDocument()) {
        await chrome.offscreen.closeDocument();
      }
    } else if (request.action === 'createPdfOffscreen') {
      console.log(`[pdf] createPdfOffscreen received with ${request.imageUrls?.length || 0} images`);
      // This is received by the offscreen document, but in case it arrives here, forward it
    }
  })().catch(error => {
    console.error('Message handling failed:', error);
  });
  return true; // Indicate async response
});

function processChapterQueue() {
  console.log(`[queue] Processing. Workers: ${activeChapterWorkers}/${settings.concurrentChapters}. Queue size: ${chapterQueue.length}, downloadAs: ${settings.downloadAs}`);
  while (activeChapterWorkers < settings.concurrentChapters && chapterQueue.length > 0) {
    activeChapterWorkers++;
    const chapter = chapterQueue.pop();
    console.log(`[queue] Starting worker for: ${chapter.url} (worker ${activeChapterWorkers}/${settings.concurrentChapters})`);
    processChapter(chapter);
  }

  if (chapterQueue.length === 0 && activeChapterWorkers === 0) {
    console.log('[queue] All chapters processed.');
  }
}

async function processChapter(chapter) {
    console.log(`[worker] Starting chapter: ${chapter.url}, downloadAs: ${settings.downloadAs}`);
    try {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        console.log(`[worker] Active tab: ${activeTab?.id}, url: ${activeTab?.url?.substring(0, 80)}`);

        // If the active tab is the one we want to process, use it directly.
        // Otherwise, open a new background tab.
        const shouldUseActiveTab = activeTab && activeTab.url.includes(chapter.url);
        console.log(`[worker] shouldUseActiveTab: ${shouldUseActiveTab}`);

        const tabToUse = shouldUseActiveTab
            ? activeTab
            : await new Promise(resolve => {
                console.log(`[worker] Creating new background tab for: ${chapter.url}`);
                chrome.tabs.create({ url: chapter.url, active: false }, (tab) => {
                  console.log(`[worker] New tab created: ${tab.id}`);
                  resolve(tab);
                });
              });

        const processAndCleanup = (tabId) => {
            console.log(`[worker] Setting up message listener for tab ${tabId}`);
            const messageListener = (request, sender, sendResponse) => {
                if (sender.tab && sender.tab.id === tabId) {
                    console.log(`[worker] Received "${request.action}" from tab ${tabId}`);
                    if (request.action === 'getChapterDetails') {
                        console.log(`[worker] Responding to getChapterDetails for tab ${tabId}`);
                        sendResponse({
                            mangaTitle: chapter.mangaTitle,
                            chapterTitle: chapter.name,
                            chapterNumber: chapter.chapterNumber,
                            settings: settings
                        });
                        return true;
                    } else if (request.action === 'chapterProcessingComplete') {
                        try {
                            console.log(`[worker] Chapter processing complete for tab ${tabId}. Images: ${request.imageUrls?.length || 0}`);
                            const imageUrls = Array.isArray(request.imageUrls) ? request.imageUrls.filter(source => typeof source === 'string' && source.trim()) : [];
                            const chapterWithDetectedNumber = { ...chapter, chapterNumber: request.chapterNumber || chapter.chapterNumber };

                            if (imageUrls.length === 0) {
                                console.warn(`[worker] No usable images found for ${chapter.url}; skipping ${settings.downloadAs} export.`);
                            } else if (settings.downloadAs === 'zip') {
                                console.log(`[worker] Starting ZIP creation with ${imageUrls.length} images`);
                                createArchive(imageUrls, chapter.mangaTitle, chapterWithDetectedNumber, 'zip');
                            } else if (settings.downloadAs === 'pdf') {
                                console.log(`[worker] Starting PDF creation with ${imageUrls.length} images`);
                                createPdfOffscreen(imageUrls, chapter.mangaTitle, chapterWithDetectedNumber);
                            } else {
                                console.log(`[worker] downloadAs is "${settings.downloadAs}", no post-processing needed (images already queued)`);
                            }
                        } catch (error) {
                            console.error(`[worker] Failed to finish chapter ${chapter.url}:`, error);
                        } finally {
                            // Only close the tab if we created a new one
                            if (!shouldUseActiveTab) {
                                console.log(`[worker] Closing tab ${tabId}`);
                                chrome.tabs.remove(tabId);
                            }
                            chrome.runtime.onMessage.removeListener(messageListener);

                            activeChapterWorkers--;
                            console.log(`[worker] Worker done. Active workers: ${activeChapterWorkers}`);
                            processChapterQueue();
                        }
                    }
                }
            };
            chrome.runtime.onMessage.addListener(messageListener);

            console.log(`[worker] Injecting content.js into tab ${tabId}`);
            chrome.scripting.executeScript({
                target: { tabId: tabId },
                files: ['content.js'],
            }, (results) => {
              if (chrome.runtime.lastError) {
                console.error(`[worker] Failed to inject content.js:`, chrome.runtime.lastError.message);
                activeChapterWorkers--;
                processChapterQueue();
              } else {
                console.log(`[worker] content.js injected successfully into tab ${tabId}`);
              }
            });
        };

        if (shouldUseActiveTab) {
            console.log(`[worker] Using active tab ${tabToUse.id} for processing.`);
            processAndCleanup(tabToUse.id);
        } else {
            // Listen for the new tab to finish loading before injecting script
            const tabUpdateListener = (tabId, info) => {
                if (tabId === tabToUse.id && info.status === 'complete') {
                    console.log(`[worker] Tab ${tabId} loaded. Injecting content script.`);
                    processAndCleanup(tabId);
                    chrome.tabs.onUpdated.removeListener(tabUpdateListener);
                }
            };
            chrome.tabs.onUpdated.addListener(tabUpdateListener);
            // Safety: if tab is already complete (cached), process immediately
            if (tabToUse.status === 'complete') {
                console.log(`[worker] Tab ${tabToUse.id} already complete, injecting immediately.`);
                processAndCleanup(tabToUse.id);
                chrome.tabs.onUpdated.removeListener(tabUpdateListener);
            }
        }

    } catch (error) {
        console.error(`[worker] Error processing chapter ${chapter.url}:`, error);
        activeChapterWorkers--;
        processChapterQueue();
    }
}

function dataUrlToBlob(dataUrl) {
    const [header, base64Data = ''] = dataUrl.split(',');
    const mimeType = header.match(/^data:(.*?);base64$/i)?.[1] || 'application/octet-stream';
    const binary = atob(base64Data);
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }

    return new Blob([bytes], { type: mimeType });
}

async function imageSourceToBlob(source) {
    if (source.startsWith('data:')) {
        return dataUrlToBlob(source);
    }

    const response = await fetch(source, { mode: 'cors' });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }

    return response.blob();
}

function getBlobExtension(blob, source) {
    const mimeType = blob.type || '';
    const mimeExtension = mimeType.split('/')[1];

    if (mimeExtension) {
        return mimeExtension === 'jpeg' ? 'jpg' : mimeExtension;
    }

    try {
        const extension = new URL(source).pathname.split('.').pop();
        if (extension && extension.length <= 5) {
            return extension.toLowerCase();
        }
    } catch (error) {
        // Ignore non-URL sources.
    }

    return 'bin';
}

function downloadBlob(blob, filename) {
    const reader = new FileReader();
    reader.onload = function() {
        chrome.downloads.download({
            url: reader.result,
            filename,
            conflictAction: 'overwrite'
        }, (downloadId) => {
            if (chrome.runtime.lastError) {
                console.error(`Failed to download ${filename}:`, chrome.runtime.lastError.message);
                return;
            }
            console.log(`Started download: ${filename} (${downloadId})`);
        });
    };
    reader.onerror = function() {
        console.error(`Failed to prepare ${filename} for download:`, reader.error);
    };
    reader.readAsDataURL(blob);
}

async function createArchive(imageUrls, mangaTitle, chapter, type) {
    console.log(`[zip] Starting archive creation. ${imageUrls.length} images, manga: ${mangaTitle}`);
    try {
        const zip = new JSZip();
        const chapterFolderName = buildChapterFolderName(chapter.name, chapter.chapterNumber, settings.includeChapterNumber);
        const chapterFolder = zip.folder(chapterFolderName);
        const sources = Array.isArray(imageUrls) ? imageUrls.filter(source => typeof source === 'string' && source.trim()) : [];

        if (sources.length === 0) {
            console.warn(`[zip] No image sources provided for ${chapter.url}; skipping ZIP export.`);
            return;
        }

        console.log(`[zip] Downloading ${sources.length} images...`);
        const imagePromises = sources.map(async (source, index) => {
            const blob = await imageSourceToBlob(source);
            const extension = getBlobExtension(blob, source);
            const filename = `${String(index + 1).padStart(3, '0')}.${extension}`;
            chapterFolder.file(filename, blob);
            console.log(`[zip]   Added image ${index + 1}/${sources.length}: ${filename}`);
        });

        const settled = await Promise.allSettled(imagePromises);
        const failedCount = settled.filter(result => result.status === 'rejected').length;
        const successCount = settled.filter(result => result.status === 'fulfilled').length;

        if (failedCount > 0) {
            console.warn(`[zip] ZIP export completed with ${failedCount} failed image(s).`);
        } else {
            console.log(`[zip] All ${successCount} images added to ZIP.`);
        }

        console.log(`[zip] Generating ZIP blob...`);
        const zipBlob = await zip.generateAsync({ type: 'blob' });
        const filename = `${sanitizeFilenamePart(mangaTitle)} - ${chapterFolderName}.${type}`;
        console.log(`[zip] Downloading ZIP: ${filename} (${zipBlob.size} bytes)`);

        downloadBlob(zipBlob, filename);
    } catch (error) {
        console.error(`[zip] Failed to create archive:`, error);
    }
}

// A global promise to manage the offscreen document lifecycle
let creating;

async function createPdfOffscreen(imageUrls, mangaTitle, chapter) {
    const sources = Array.isArray(imageUrls) ? imageUrls.filter(source => typeof source === 'string' && source.trim()) : [];
    console.log(`[pdf] Starting PDF creation. ${sources.length} images`);
    if (sources.length === 0) {
        console.warn(`[pdf] No image sources provided for ${chapter.url}; skipping PDF export.`);
        return;
    }

    const chapterFolderName = buildChapterFolderName(chapter.name, chapter.chapterNumber, settings.includeChapterNumber);

    if (!chrome.offscreen?.createDocument || !chrome.offscreen?.hasDocument) {
        console.error('[pdf] PDF export requires Chrome offscreen document API. Your browser may not support it.');
        return;
    }

    try {
        // Check if an offscreen document is already available.
        if (await chrome.offscreen.hasDocument()) {
            console.log("[pdf] Offscreen document already exists. Sending message.");
            chrome.runtime.sendMessage({
                action: 'createPdfOffscreen',
                imageUrls: sources,
                mangaTitle,
                chapter,
                chapterFolderName,
            });
            return;
        }

        // If we're in the process of creating a document, wait for it to finish.
        if (creating) {
            console.log("[pdf] Waiting for offscreen document creation...");
            await creating;
        } else {
            console.log("[pdf] Creating offscreen document...");
            creating = chrome.offscreen.createDocument({
                url: 'offscreen.html',
                reasons: ['BLOBS'],
                justification: 'Needed to convert images to PDF format.',
            }).catch(error => {
                creating = null;
                throw error;
            });
            await creating;
            creating = null; // Reset the promise
        }

        console.log("[pdf] Offscreen document created. Sending message with", sources.length, "images.");
        // Now that the document is confirmed to exist, send the message
        chrome.runtime.sendMessage({
            action: 'createPdfOffscreen',
            imageUrls: sources,
            mangaTitle,
            chapter,
            chapterFolderName,
        });
    } catch (error) {
        console.error('[pdf] Failed to create offscreen document:', error);
    }
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