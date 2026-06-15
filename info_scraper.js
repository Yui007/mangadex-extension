// This script is injected into the MangaDex title page to scrape chapter info.

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

function findChapterNumberFromDOM(row) {
  // 1. Try to extract from the row's title first
  const titleElement = row.querySelector('.chapter-link');
  const titleText = titleElement ? titleElement.textContent.trim() : '';
  let num = extractChapterNumber(titleText);
  if (num) {
    return num;
  }

  // 2. Try to find the nearest preceding .chapter-header in the DOM
  let current = row;
  while (current && current !== document.body) {
    let sibling = current.previousElementSibling;
    while (sibling) {
      const header = sibling.classList.contains('chapter-header') 
        ? sibling 
        : sibling.querySelector('.chapter-header');
      if (header) {
        const span = header.querySelector('span.font-bold') || header.querySelector('.font-bold');
        if (span) {
          const headerText = span.textContent.trim();
          const parsed = extractChapterNumber(headerText) || normalizeChapterNumber(headerText);
          if (parsed) {
            return parsed;
          }
        }
      }
      sibling = sibling.previousElementSibling;
    }
    current = current.parentElement;
  }
  return null;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getChapters') {
    const language = request.language;

    // Use the class name which is more stable than the data attribute
    const chapterRows = document.querySelectorAll('.chapter-grid');

    let chapters = [];
    let seenUrls = new Set(); // Use a Set to prevent any possible duplicates

    chapterRows.forEach(row => {
      const langImg = row.querySelector(`img[src$="/${language}.svg"]`);
      const link = row.querySelector('a[href^="/chapter/"]');

      if (langImg && link && !seenUrls.has(link.href)) {
        const titleElement = row.querySelector('.chapter-link');
        const rawTitle = titleElement ? titleElement.textContent.trim() : 'Unknown Chapter';
        
        // Find the chapter number (checking the title first, then preceding headers)
        const chapterNumber = findChapterNumberFromDOM(row);
        
        let displayTitle = rawTitle;
        if (chapterNumber && !rawTitle.match(/^(?:chapter|ch\.?|c)\.?\s*\d+/i)) {
          displayTitle = `Ch. ${chapterNumber} - ${rawTitle}`;
        }

        chapters.push({
          title: displayTitle,
          url: link.href,
          chapterNumber: chapterNumber
        });
        seenUrls.add(link.href);
      }
    });

    // Try multiple selectors since MangaDex's DOM changes over time
    const mangaTitleElement = document.querySelector('p.mb-1')
      || document.querySelector('div.font-normal.line-clamp-2');
    let mangaTitle;
    if (mangaTitleElement) {
      mangaTitle = mangaTitleElement.textContent.trim().replace(/[<>:"/\\|?*]+/g, '');
    } else {
      const titleTag = document.querySelector('title');
      mangaTitle = titleTag
        ? titleTag.textContent.trim().split(/[-|]/)[0].trim().replace(/[<>:"/\\|?*]+/g, '')
        : 'Manga';
    }

    // Send the structured chapter list back to the popup.
    chrome.runtime.sendMessage({
      action: 'chapterList',
      mangaTitle: mangaTitle,
      chapters: chapters.reverse() // Reverse to show Chapter 1 at the top.
    });
  }
});