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

function getImageElements() {
  // MangaDex changes class names over time. Try multiple selectors from most to least specific.
  const selectors = [
    'img.img.sp.limit-width.limit-height.mx-auto',
    'img.img.ls.limit-width.limit-height',
    'img.img.limit-width.limit-height',
    'img.limit-width.limit-height',
    'img.img',
  ];
  for (const sel of selectors) {
    const found = document.querySelectorAll(sel);
    if (found.length > 0) {
      console.log(`[selector] Matched ${found.length} images with: "${sel}"`);
      return found;
    }
  }
  // Last resort: find images with blob: src
  const blobImgs = document.querySelectorAll('img[src^="blob:"]');
  if (blobImgs.length > 0) {
    console.log(`[selector] Matched ${blobImgs.length} images via blob: src fallback`);
    return blobImgs;
  }
  // Debug: log all img elements to help diagnose selector issues
  const allImgs = document.querySelectorAll('img');
  if (allImgs.length > 0) {
    const info = Array.from(allImgs).slice(0, 10).map(img => `"${img.className}" src=${img.src?.substring(0, 40)}`);
    console.warn(`[selector] No match found. All img elements (${allImgs.length}):`, info.join(' | '));
  } else {
    console.warn('[selector] No img elements found on page at all');
  }
  return [];
}

function startDownloadProcess(settings, chapterInfo) {
  const images = getImageElements();
  console.log(`[startDownload] Found ${images.length} images. downloadAs=${settings.downloadAs}`);

  // Extract chapter info — needed for ALL download modes (images, zip, pdf)
  let mangaTitle, chapterTitle, chapterNumber;

  if (chapterInfo) {
    mangaTitle = sanitizeFilenamePart(chapterInfo.mangaTitle || 'Manga');
    chapterTitle = sanitizeFilenamePart(chapterInfo.chapterTitle || 'Chapter');
    chapterNumber = chapterInfo.chapterNumber;
  } else {
    const mangaTitleElement = document.querySelector('a.reader--header-manga');
    const chapterTitleElement = document.querySelector('#chaptertitle_undefined span.chapter-link')
      || document.querySelector('div.reader--header-title');
    const chapterNumberElement = document.querySelector('.chapter-header.two-line span.font-bold');

    mangaTitle = sanitizeFilenamePart(mangaTitleElement ? mangaTitleElement.textContent.trim() : 'Manga');
    chapterTitle = sanitizeFilenamePart(chapterTitleElement ? chapterTitleElement.textContent.trim() : 'Chapter');
    chapterNumber = extractChapterNumber(chapterTitleElement ? chapterTitleElement.textContent.trim() : '')
      || (chapterNumberElement ? extractChapterNumber(chapterNumberElement.textContent.trim()) : null)
      || extractChapterNumber(document.title);
  }

  console.log(`[startDownload] manga="${mangaTitle}", chapter="${chapterTitle}", number="${chapterNumber}"`);

  if (settings.downloadAs === 'images') {
    console.log('Queuing images for individual download.');

    const chapterFolderName = buildChapterFolderName(chapterTitle, chapterNumber, settings.includeChapterNumber);
    const folderName = `${mangaTitle}/${chapterFolderName}`;

    const queueImageDownloads = async () => {
      console.log(`[images] Processing ${images.length} images for individual download`);
      let queued = 0;
      const imagePromises = Array.from(images).map(async (img, index) => {
        const source = img.currentSrc || img.src;
        if (!source) {
          console.warn(`[images] Image ${index + 1} has no source, skipping`);
          return;
        }
        try {
          let downloadUrl;
          if (source.startsWith('blob:')) {
            console.log(`[images] Converting blob URL to data URL for image ${index + 1}`);
            const response = await fetch(source);
            const blob = await response.blob();
            // Convert blob to data URL so background service worker can download it
            downloadUrl = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result);
              reader.onerror = () => reject(reader.error);
              reader.readAsDataURL(blob);
            });
          } else if (source.startsWith('data:')) {
            downloadUrl = source;
          } else {
            // For http(s) URLs, fetch and convert to data URL to avoid CORS issues in service worker
            console.log(`[images] Fetching remote image ${index + 1}: ${source.substring(0, 80)}...`);
            const response = await fetch(source, { mode: 'cors' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const blob = await response.blob();
            downloadUrl = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result);
              reader.onerror = () => reject(reader.error);
              reader.readAsDataURL(blob);
            });
          }
          const ext = downloadUrl.includes('image/png') ? 'png' : downloadUrl.includes('image/webp') ? 'webp' : 'jpg';
          const filename = `${folderName}/${(index + 1).toString().padStart(3, '0')}.${ext}`;
          chrome.runtime.sendMessage({
            action: 'queueImageDownload',
            url: downloadUrl,
            filename: filename
          });
          queued++;
          console.log(`[images] Queued image ${index + 1}/${images.length}: ${filename}`);
        } catch (error) {
          console.error(`[images] Failed to process image ${index + 1}:`, error);
        }
      });
      await Promise.all(imagePromises);
      console.log(`[images] Done. Queued ${queued}/${images.length} images.`);
      chrome.runtime.sendMessage({ action: 'chapterProcessingComplete', imageUrls: [], chapterNumber });
    };
    queueImageDownloads();

  } else {
    console.log(`[archival] Collecting image data URLs for ${settings.downloadAs}. ${images.length} images found.`);
    if (images.length === 0) {
      console.error('[archival] No images found! Cannot create ' + settings.downloadAs);
      chrome.runtime.sendMessage({ action: 'chapterProcessingComplete', imageUrls: [], chapterNumber });
      return;
    }
    const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('Failed to convert image blob.'));
      reader.readAsDataURL(blob);
    });

    const imagePromises = Array.from(images).map(async (img, index) => {
      const source = img.currentSrc || img.src;
      if (!source) {
        console.warn(`[archival] Image ${index + 1} has no source URL.`);
        return null;
      }

      try {
        console.log(`[archival] Fetching image ${index + 1}/${images.length}: ${source.substring(0, 60)}...`);
        const response = await fetch(source);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const blob = await response.blob();
        const dataUrl = await blobToDataUrl(blob);
        console.log(`[archival] Image ${index + 1} converted (${(dataUrl.length / 1024).toFixed(1)}KB)`);
        return dataUrl;
      } catch (error) {
        console.warn(`[archival] Could not convert image ${index + 1}: ${error.message}`);
        return null;
      }
    });

    Promise.all(imagePromises).then(imageUrls => {
      const validImageUrls = imageUrls.filter(url => Boolean(url));
      console.log(`[archival] Sending ${validImageUrls.length}/${images.length} image data URLs to background script.`);
      chrome.runtime.sendMessage({ action: 'chapterProcessingComplete', imageUrls: validImageUrls, chapterNumber });
    });
  }
}

function init() {
  console.log('[init] Content script loaded. Requesting chapter details from background...');
  chrome.runtime.sendMessage({ action: 'getChapterDetails' }, (response) => {
    let settingsToUse;
    let chapterInfo = null;

    if (response) {
      settingsToUse = response.settings;
      chapterInfo = response;
      console.log(`[init] Got chapter details: manga="${chapterInfo.mangaTitle}", chapter="${chapterInfo.chapterTitle}", downloadAs="${settingsToUse.downloadAs}"`);
    } else {
      console.warn('[init] No response from background script. Will use local settings.');
    }

    const runWithSettings = (settings) => {
      let stableCount = 0;
      let lastImageCount = 0;
      let totalPages = -1;
      let hasStarted = false;

      console.log(`[stability] Starting: stabilityChecks=${settings.stabilityChecks}, timeout=${settings.overallTimeoutSeconds}s`);

      const tryStart = (reason) => {
        if (hasStarted) return;
        const imgs = getImageElements();
        if (imgs.length === 0) {
          console.log(`[stability] ${reason} but 0 images found, waiting...`);
          return;
        }
        hasStarted = true;
        clearInterval(checkInterval);
        clearTimeout(safetyTimeout);
        disconnectObserver();
        console.log(`[stability] ${reason} — ${imgs.length} images found. Starting download.`);
        startDownloadProcess(settings, chapterInfo);
      };

      // MutationObserver to detect when images are added to the DOM
      const observer = new MutationObserver(() => {
        if (hasStarted) return;
        const imgs = getImageElements();
        if (imgs.length > 0) {
          tryStart(`MutationObserver detected ${imgs.length} images`);
        }
      });
      const disconnectObserver = () => observer.disconnect();
      observer.observe(document.body || document.documentElement, { childList: true, subtree: true });

      const checkInterval = setInterval(() => {
        if (hasStarted) {
          clearInterval(checkInterval);
          return;
        }

        if (totalPages === -1) {
          const totalPagesElement = document.querySelector('div.page-number:last-child');
          if (totalPagesElement) {
            totalPages = parseInt(totalPagesElement.textContent, 10);
            console.log(`[stability] Total pages: ${totalPages}`);
          }
        }

        const loadedImages = getImageElements();
        console.log(`[stability] Check: loaded=${loadedImages.length}, total=${totalPages}, stable=${stableCount}/${settings.stabilityChecks}`);

        if (totalPages > 0 && loadedImages.length >= totalPages) {
          tryStart(`All ${loadedImages.length}/${totalPages} images loaded`);
          return;
        }

        if (loadedImages.length > lastImageCount) {
          lastImageCount = loadedImages.length;
          stableCount = 0;
        } else if (loadedImages.length > 0) {
          stableCount++;
        }

        if (stableCount >= settings.stabilityChecks) {
          tryStart(`Stabilized at ${lastImageCount} images`);
        }
      }, 500);

      const safetyTimeout = setTimeout(() => {
        if (hasStarted) return;
        hasStarted = true;
        clearInterval(checkInterval);
        disconnectObserver();
        const loadedImages = getImageElements();
        if (loadedImages.length > 0) {
          console.warn(`[stability] TIMEOUT: ${loadedImages.length} images found, proceeding anyway.`);
          startDownloadProcess(settings, chapterInfo);
        } else {
          console.error('[stability] TIMEOUT: No images found. Aborting.');
          chrome.runtime.sendMessage({ action: 'chapterProcessingComplete' });
        }
      }, settings.overallTimeoutSeconds * 1000);
    };

    if (!settingsToUse) {
      chrome.storage.sync.get({ downloadAs: 'images', stabilityChecks: 8, overallTimeoutSeconds: 30, includeChapterNumber: false }, (settings) => {
        runWithSettings(settings);
      });
    } else {
      runWithSettings(settingsToUse);
    }
  });
}

init();