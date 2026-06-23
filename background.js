importScripts('lib/jszip.min.js');

// ============================================================
//  MangaDex API Constants
// ============================================================
const API_BASE = 'https://api.mangadex.org';
const API_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Origin': 'https://mangadex.org',
  'Referer': 'https://mangadex.org/',
};

// ============================================================
//  Settings
// ============================================================
const DEFAULTS = {
  downloadAs: 'images',
  concurrentChapters: 3,
  concurrentImages: 5,
  retryCount: 3,
  retryDelay: 1000,
  dataSaver: false,
  includeChapterNumber: false,
};

let settings = { ...DEFAULTS };
let chapterQueue = [];
let activeChapterWorkers = 0;

async function getSettings() {
  return new Promise(resolve => {
    chrome.storage.sync.get(DEFAULTS, s => resolve(s));
  });
}

async function loadSettings() {
  settings = await getSettings();
}

loadSettings();
chrome.storage.onChanged.addListener(loadSettings);

// ============================================================
//  Declarative Net Request (DNR) Rules
// ============================================================
const RULES = [
  {
    id: 1,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        {
          header: 'Referer',
          operation: 'set',
          value: 'https://mangadex.org/'
        }
      ]
    },
    condition: {
      urlFilter: '*://*.mangadex.network/*',
      resourceTypes: ['xmlhttprequest', 'main_frame', 'sub_frame', 'other', 'image']
    }
  },
  {
    id: 2,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        {
          header: 'Referer',
          operation: 'set',
          value: 'https://mangadex.org/'
        }
      ]
    },
    condition: {
      urlFilter: '*://uploads.mangadex.org/*',
      resourceTypes: ['xmlhttprequest', 'main_frame', 'sub_frame', 'other', 'image']
    }
  }
];

async function setupNetRequestRules() {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [1, 2],
      addRules: RULES
    });
    console.log('[bg] DNR rules registered successfully.');
  } catch (err) {
    console.error('[bg] Failed to register DNR rules:', err);
  }
}

setupNetRequestRules();

// ============================================================
//  Utility Functions
// ============================================================
function sanitize(text) {
  return (text || '').toString().trim().replace(/[<>:"/\\|?*]+/g, '') || 'Chapter';
}

function extractChapterNumber(title) {
  const n = (title || '').toString().trim();
  const patterns = [
    /^(?:chapter|ch\.?|c)\.?\s*(\d+(?:\.\d+)?)/i,
    /(?:^|[\s(])(?:chapter|ch\.?|c)\.?\s*(\d+(?:\.\d+)?)(?=$|[\s):.-])/i,
  ];
  for (const p of patterns) {
    const m = n.match(p);
    if (m) return m[1].replace(/^0+(?=\d)/, '');
  }
  return null;
}

function normalizeChapterNumber(n) {
  const m = (n || '').toString().match(/\d+(?:\.\d+)?/);
  return m ? m[0].replace(/^0+(?=\d)/, '') : null;
}

function buildChapterFolderName(chapterTitle, chapterNumber, includeChapterNumber) {
  const clean = sanitize(chapterTitle);
  if (!includeChapterNumber) return clean;
  const num = extractChapterNumber(chapterNumber || chapterTitle) || normalizeChapterNumber(chapterNumber);
  if (!num) return clean;
  const withoutNum = clean.replace(/^(?:Chapter|Ch\.?|C)\.?\s*\d+(?:\.\d+)?[:\-\s]*/i, '');
  return `Ch.${num}${withoutNum ? ` - ${withoutNum}` : ''}`;
}

function sanitizeFilenamePart(text) {
  return sanitize(text);
}

// ============================================================
//  MangaDex API Methods
// ============================================================

/** Extract manga UUID from a MangaDex title URL */
function parseMangaUuid(url) {
  const m = url.match(/mangadex\.org\/title\/([a-f0-9-]+)/i);
  return m ? m[1] : null;
}

/** Extract chapter UUID from a MangaDex chapter URL */
function parseChapterUuid(url) {
  const m = url.match(/mangadex\.org\/chapter\/([a-f0-9-]+)/i);
  return m ? m[1] : null;
}

/** Fetch manga details (title, cover, author, artist) */
async function apiGetManga(mangaUuid) {
  const url = `${API_BASE}/manga/${mangaUuid}?includes[]=artist&includes[]=author&includes[]=cover_art`;
  const res = await fetch(url, { headers: API_HEADERS });
  if (!res.ok) throw new Error(`API manga ${res.status}`);
  const json = await res.json();
  // Extract title (prefer en, fallback to first available)
  const titles = json.data?.attributes?.title || {};
  const title = titles.en || Object.values(titles)[0] || 'Manga';
  return { title };
}

/** Fetch chapter list via aggregate (grouped by volume) */
async function apiGetChapters(mangaUuid, langCode) {
  // Lang code map: gb → en, br → pt-br, etc.
  const langMap = {
    gb: 'en', br: 'pt-br', ru: 'ru', 'es-la': 'es-la',
    fr: 'fr', id: 'id', vn: 'vi',
  };
  const lang = langMap[langCode] || 'en';

  // Step 1: aggregate gives chapter IDs grouped by volume
  const aggUrl = `${API_BASE}/manga/${mangaUuid}/aggregate?translatedLanguage[]=${lang}`;
  const aggRes = await fetch(aggUrl, { headers: API_HEADERS });
  if (!aggRes.ok) throw new Error(`API aggregate ${aggRes.status}`);
  const agg = await aggRes.json();

  const chapters = [];
  for (const vol of Object.values(agg.volumes || {})) {
    for (const [chNum, ch] of Object.entries(vol.chapters || {})) {
      chapters.push({
        id: ch.id,
        chapter: chNum,
        title: ch.chapter || `Chapter ${chNum}`,
        volume: vol.volume,
      });
    }
  }
  // Sort ascending by chapter number
  chapters.sort((a, b) => parseFloat(a.chapter) - parseFloat(b.chapter));
  return chapters;
}

/** Fetch chapter images from MD@Home server */
async function apiGetChapterImages(chapterId) {
  const url = `${API_BASE}/at-home/server/${chapterId}?forcePort443=false`;
  const res = await fetch(url, { headers: API_HEADERS });
  if (!res.ok) throw new Error(`API at-home ${res.status}`);
  const json = await res.json();
  const { baseUrl, chapter } = json;
  const imageList = settings.dataSaver ? chapter.dataSaver : chapter.data;
  const hash = chapter.hash;
  const qualityPath = settings.dataSaver ? 'data-saver' : 'data';
  return imageList.map(f => `${baseUrl}/${qualityPath}/${hash}/${f}`);
}

// ============================================================
//  Message Handlers
// ============================================================
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  (async () => {
    try {
      switch (request.action) {

        // --- Popup requests chapter list for a manga URL ---
        case 'fetchChapterList': {
          const mangaUuid = parseMangaUuid(request.url);
          if (!mangaUuid) throw new Error('Could not extract manga UUID from URL');
          const chapters = await apiGetChapters(mangaUuid, request.language || 'gb');
          sendResponse({ ok: true, chapters, mangaTitle: request.mangaTitle });
          return;
        }

        // --- Popup triggers batch download of selected chapters ---
        case 'downloadChapters': {
          await loadSettings();
          // chapters: [{ id, chapter, title, mangaTitle }]
          chapterQueue.unshift(...request.chapters.map(ch => ({
            ...ch,
            url: `https://mangadex.org/chapter/${ch.id}`,
            name: ch.title,
            mangaTitle: ch.mangaTitle || request.mangaTitle,
          })));
          processChapterQueue();
          sendResponse({ ok: true, queued: request.chapters.length });
          return;
        }

        // --- Download single chapter from current tab (fallback) ---
        case 'downloadSingleChapter': {
          await loadSettings();
          const chapterId = parseChapterUuid(request.url);
          if (!chapterId) throw new Error('Could not extract chapter UUID from URL');
          const chapter = {
            id: chapterId,
            url: request.url,
            name: request.chapterTitle || `Chapter ${chapterId}`,
            mangaTitle: request.mangaTitle || 'Manga',
            chapterNumber: request.chapterNumber || null,
          };
          chapterQueue.unshift(chapter);
          processChapterQueue();
          sendResponse({ ok: true });
          return;
        }

        // --- Handle PDF downloads from offscreen document ---
        case 'downloadPdf': {
          chrome.downloads.download({
            url: request.url,
            filename: request.filename,
            conflictAction: 'overwrite'
          }, (downloadId) => {
            if (chrome.runtime.lastError) {
              console.error('[bg] PDF download error:', chrome.runtime.lastError.message);
              sendResponse({ ok: false, error: chrome.runtime.lastError.message });
            } else {
              sendResponse({ ok: true, downloadId });
            }
          });
          return;
        }
      }
    } catch (err) {
      console.error('[bg] Handler error:', err);
      sendResponse({ ok: false, error: err.message });
    }
  })();
  return true; // keep channel open for async response
});

// ============================================================
//  Queue Processing
// ============================================================
function processChapterQueue() {
  while (activeChapterWorkers < settings.concurrentChapters && chapterQueue.length > 0) {
    activeChapterWorkers++;
    const chapter = chapterQueue.shift();
    processChapter(chapter);
  }
  if (chapterQueue.length === 0 && activeChapterWorkers === 0) {
    broadcastProgress({ type: 'allDone', message: 'All chapters downloaded.' });
  }
}

/** Send progress update to popup */
function broadcastProgress(data) {
  chrome.runtime.sendMessage({ action: 'downloadProgress', ...data }).catch(() => {
    // popup may not be open, ignore
  });
}

// ============================================================
//  Chapter Processing
// ============================================================
async function processChapter(chapter) {
  try {
    broadcastProgress({
      type: 'chapterStart',
      chapterTitle: chapter.name || chapter.chapter,
      mangaTitle: chapter.mangaTitle,
      index: activeChapterWorkers,
    });

    // Get image URLs from API
    const imageUrls = await apiGetChapterImages(chapter.id);
    if (imageUrls.length === 0) {
      console.warn(`[chapter] No images for ${chapter.id}`);
      finishChapter(chapter);
      return;
    }

    broadcastProgress({
      type: 'chapterImages',
      chapterTitle: chapter.name,
      totalImages: imageUrls.length,
    });

    // Normalize chapter number for folder naming
    const chNum = chapter.chapterNumber || extractChapterNumber(chapter.name) || normalizeChapterNumber(chapter.chapter);
    const chapterWithNum = { ...chapter, chapterNumber: chNum };

    if (settings.downloadAs === 'images') {
      await downloadChapterImages(imageUrls, chapter, chNum);
    } else if (settings.downloadAs === 'zip') {
      await createArchive(imageUrls, chapter.mangaTitle, chapterWithNum, 'zip');
    } else if (settings.downloadAs === 'pdf') {
      await createPdfOffscreen(imageUrls, chapter.mangaTitle, chapterWithNum);
    }

    broadcastProgress({
      type: 'chapterDone',
      chapterTitle: chapter.name,
    });
  } catch (err) {
    console.error(`[chapter] Failed ${chapter.id}:`, err);
  } finally {
    finishChapter(chapter);
  }
}

function finishChapter(chapter) {
  activeChapterWorkers--;
  processChapterQueue();
}

// ============================================================
//  Image Download (Individual Mode)
// ============================================================
async function downloadChapterImages(imageUrls, chapter, chapterNumber) {
  const folderName = `${sanitize(chapter.mangaTitle)}/${buildChapterFolderName(chapter.name, chapterNumber, settings.includeChapterNumber)}`;
  const total = imageUrls.length;
  let completedCount = 0;
  let idx = 0;

  const concurrency = settings.concurrentImages || 5;

  const worker = async () => {
    while (idx < total) {
      const i = idx++;
      const pageNum = String(i + 1).padStart(3, '0');
      const ext = imageUrls[i].split('.').pop().split('?')[0];
      const filename = `${folderName}/${pageNum}.${ext}`;

      try {
        await downloadImageWithRetry(imageUrls[i], filename, settings.retryCount);
      } catch (err) {
        console.error(`[dl] Failed ${filename}:`, err);
      }

      completedCount++;
      broadcastProgress({
        type: 'imageProgress',
        completed: completedCount,
        total,
        percent: Math.round((completedCount / total) * 100),
      });
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, total) }, () => worker());
  await Promise.all(workers);
}

async function downloadImageWithRetry(url, filename, retries) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const blob = await imageSourceToBlob(url);
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });

      await new Promise((resolve, reject) => {
        chrome.downloads.download({
          url: dataUrl,
          filename,
          conflictAction: 'overwrite',
        }, (downloadId) => {
          if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
          const listener = (delta) => {
            if (delta.id === downloadId && delta.state) {
              if (delta.state.current === 'complete') {
                chrome.downloads.onChanged.removeListener(listener);
                resolve();
              } else if (delta.state.current === 'interrupted') {
                chrome.downloads.onChanged.removeListener(listener);
                reject(new Error(`Interrupted: ${delta.error?.current}`));
              }
            }
          };
          chrome.downloads.onChanged.addListener(listener);
        });
      });
      return; // success

    } catch (err) {
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, settings.retryDelay));
      } else {
        throw err;
      }
    }
  }
}

// ============================================================
//  ZIP Archive
// ============================================================
function dataUrlToBlob(dataUrl) {
  const [header, base64 = ''] = dataUrl.split(',');
  const mime = header.match(/^data:(.*?);base64$/i)?.[1] || 'image/jpeg';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function imageSourceToBlob(source) {
  if (source.startsWith('data:')) return dataUrlToBlob(source);
  // CDN images require User-Agent + Referer headers
  const response = await fetch(source, {
    mode: 'cors',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://mangadex.org/',
      'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.blob();
}

function getBlobExtension(blob, source) {
  const mime = blob.type || '';
  const ext = mime.split('/')[1];
  if (ext) return ext === 'jpeg' ? 'jpg' : ext;
  try {
    const e = new URL(source).pathname.split('.').pop();
    if (e && e.length <= 5) return e.toLowerCase();
  } catch (_) {}
  return 'bin';
}

function downloadBlob(blob, filename) {
  const reader = new FileReader();
  reader.onload = function () {
    chrome.downloads.download({
      url: reader.result,
      filename,
      conflictAction: 'overwrite',
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        console.error(`Failed to download ${filename}:`, chrome.runtime.lastError.message);
      }
    });
  };
  reader.onerror = function () {
    console.error(`Failed to prepare ${filename} for download:`, reader.error);
  };
  reader.readAsDataURL(blob);
}

async function createArchive(imageUrls, mangaTitle, chapter, type) {
  try {
    const zip = new JSZip();
    const folderName = buildChapterFolderName(chapter.name, chapter.chapterNumber, settings.includeChapterNumber);
    const folder = zip.folder(folderName);
    const sources = imageUrls.filter(s => typeof s === 'string' && s.trim());

    const concurrency = settings.concurrentImages || 5;
    let idx = 0;

    const processNext = async () => {
      while (idx < sources.length) {
        const i = idx++;
        try {
          const blob = await imageSourceToBlob(sources[i]);
          const ext = getBlobExtension(blob, sources[i]);
          folder.file(`${String(i + 1).padStart(3, '0')}.${ext}`, blob);
        } catch (err) {
          console.warn(`[zip] Failed image ${i + 1}:`, err);
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => processNext()));

    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const filename = `${sanitize(mangaTitle)} - ${folderName}.${type}`;
    downloadBlob(zipBlob, filename);
  } catch (err) {
    console.error(`[zip] Failed:`, err);
  }
}

// ============================================================
//  PDF (Offscreen Document)
// ============================================================
let creating;

async function createPdfOffscreen(imageUrls, mangaTitle, chapter) {
  const sources = imageUrls.filter(s => typeof s === 'string' && s.trim());
  if (sources.length === 0) return;

  const folderName = buildChapterFolderName(chapter.name, chapter.chapterNumber, settings.includeChapterNumber);

  if (!chrome.offscreen?.createDocument || !chrome.offscreen?.hasDocument) {
    console.error('[pdf] Offscreen API not available');
    return;
  }

  try {
    if (await chrome.offscreen.hasDocument()) {
      chrome.runtime.sendMessage({
        action: 'createPdfOffscreen',
        imageUrls: sources,
        mangaTitle,
        chapter,
        chapterFolderName: folderName,
      });
      return;
    }

    if (creating) {
      await creating;
    } else {
      creating = chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['BLOBS'],
        justification: 'Convert images to PDF.',
      }).catch(err => { creating = null; throw err; });
      await creating;
      creating = null;
    }

    chrome.runtime.sendMessage({
      action: 'createPdfOffscreen',
      imageUrls: sources,
      mangaTitle,
      chapter,
      chapterFolderName: folderName,
    });
  } catch (err) {
    console.error('[pdf] Failed:', err);
  }
}
