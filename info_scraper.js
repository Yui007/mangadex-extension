// This script is injected into the MangaDex title page to scrape chapter info.

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
        const title = titleElement ? titleElement.textContent.trim() : 'Unknown Chapter';
        chapters.push({
          title: title,
          url: link.href
        });
        seenUrls.add(link.href);
      }
    });

    const mangaTitleElement = document.querySelector('span.text-2xl.font-bold');
    const mangaTitle = mangaTitleElement ? mangaTitleElement.textContent.trim().replace(/[<>:"/\\|?*]+/g, '') : 'Manga';

    // Send the structured chapter list back to the popup.
    chrome.runtime.sendMessage({
      action: 'chapterList',
      mangaTitle: mangaTitle,
      chapters: chapters.reverse() // Reverse to show Chapter 1 at the top.
    });
  }
});