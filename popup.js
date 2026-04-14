document.addEventListener('DOMContentLoaded', () => {
  const downloadChapterBtn = document.getElementById('downloadChapterBtn');
  const mangaView = document.getElementById('mangaView');
  const languageSelect = document.getElementById('languageSelect');
  const chapterListDiv = document.getElementById('chapterList');
  const downloadSelectedBtn = document.getElementById('downloadSelectedBtn');
  const statusDiv = document.getElementById('status');
  const selectAllCheckbox = document.getElementById('selectAllCheckbox');
  const selectionCounter = document.getElementById('selectionCounter');

  const downloadAsInput = document.getElementById('downloadAs');
  const concurrentChaptersInput = document.getElementById('concurrentChapters');
  const concurrentImagesInput = document.getElementById('concurrentImages');
  const retryCountInput = document.getElementById('retryCount');
  const retryDelayInput = document.getElementById('retryDelay');
  const stabilityChecksInput = document.getElementById('stabilityChecks');
  const overallTimeoutSecondsInput = document.getElementById('overallTimeoutSeconds');
  const saveSettingsBtn = document.getElementById('saveSettingsBtn');
  const settingsStatusDiv = document.getElementById('settingsStatus');

  const tabLinks = document.querySelectorAll('.tab-link');
  const tabContents = document.querySelectorAll('.tab-content');

  let currentTab;
  let mangaTitle = 'Manga';
  let lastCheckedCheckbox = null;

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    currentTab = tabs[0];
    if (currentTab.url.includes('mangadex.org/chapter/')) {
      downloadChapterBtn.style.display = 'block';
    } else if (currentTab.url.includes('mangadex.org/title/')) {
      mangaView.style.display = 'block';
      requestChaptersFromPage(languageSelect.value);
    } else {
      statusDiv.textContent = 'Not a valid MangaDex page.';
    }
  });

  loadAndDisplaySettings();

  tabLinks.forEach(link => {
    link.addEventListener('click', () => {
      const tabId = link.dataset.tab;

      tabLinks.forEach(l => l.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));

      link.classList.add('active');
      document.getElementById(tabId).classList.add('active');
    });
  });

  downloadChapterBtn.addEventListener('click', () => {
    statusDiv.textContent = 'Starting chapter download...';
    chrome.scripting.executeScript({
        target: { tabId: currentTab.id },
        func: () => {
            const mangaTitleElement = document.querySelector('a.reader--header-manga');
            const chapterTitleElement = document.querySelector('div.reader--header-title');
            const mangaTitle = mangaTitleElement ? mangaTitleElement.textContent.trim().replace(/[<>:"/\\|?*]+/g, '') : 'Manga';
            const chapterTitle = chapterTitleElement ? chapterTitleElement.textContent.trim().replace(/[<>:"/\\|?*]+/g, '') : 'Chapter';
            return { mangaTitle, chapterTitle };
        }
    }, (injectionResults) => {
        for (const frameResult of injectionResults) {
            const { mangaTitle, chapterTitle } = frameResult.result;
            const chapter = { url: currentTab.url, name: chapterTitle, mangaTitle: mangaTitle };
            chrome.runtime.sendMessage({ action: 'downloadAllChapters', chapters: [chapter] });
        }
    });
  });

  languageSelect.addEventListener('change', () => {
    requestChaptersFromPage(languageSelect.value);
  });

  selectAllCheckbox.addEventListener('change', () => {
    const checkboxes = chapterListDiv.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach(cb => { cb.checked = selectAllCheckbox.checked; });
    updateSelectionState();
  });

  chapterListDiv.addEventListener('click', (e) => {
    const checkbox = e.target.closest('input[type="checkbox"]');
    if (!checkbox) return;

    if (e.shiftKey && lastCheckedCheckbox) {
      const checkboxes = Array.from(chapterListDiv.querySelectorAll('input[type="checkbox"]'));
      const start = checkboxes.indexOf(lastCheckedCheckbox);
      const end = checkboxes.indexOf(checkbox);
      if (start !== -1 && end !== -1) {
        const [lo, hi] = start < end ? [start, end] : [end, start];
        for (let i = lo; i <= hi; i++) {
          checkboxes[i].checked = checkbox.checked;
        }
      }
    }

    lastCheckedCheckbox = checkbox;
    updateSelectionState();
  });

  downloadSelectedBtn.addEventListener('click', () => {
    const selectedCheckboxes = Array.from(chapterListDiv.querySelectorAll('input:checked'));
    const selectedChapters = selectedCheckboxes.map(cb => {
        return {
            url: cb.dataset.url,
            name: cb.dataset.title,
        }
    });

    if (selectedChapters.length > 0) {
      statusDiv.textContent = `Queuing ${selectedChapters.length} chapters...`;
      chrome.runtime.sendMessage({
          action: 'downloadAllChapters',
          chapters: selectedChapters.map(chapter => ({ ...chapter, mangaTitle: mangaTitle }))
      });
      downloadSelectedBtn.disabled = true;
    }
  });

  saveSettingsBtn.addEventListener('click', async () => {
    const newSettings = {
      downloadAs: downloadAsInput.value,
      concurrentChapters: parseInt(concurrentChaptersInput.value, 10),
      concurrentImages: parseInt(concurrentImagesInput.value, 10),
      retryCount: parseInt(retryCountInput.value, 10),
      retryDelay: parseInt(retryDelayInput.value, 10),
      stabilityChecks: parseInt(stabilityChecksInput.value, 10),
      overallTimeoutSeconds: parseInt(overallTimeoutSecondsInput.value, 10)
    };
    await saveSettings(newSettings);
    settingsStatusDiv.textContent = 'Settings saved!';
    setTimeout(() => { settingsStatusDiv.textContent = ''; }, 2000);
  });

  async function loadAndDisplaySettings() {
    const settings = await getSettings();
    downloadAsInput.value = settings.downloadAs;
    concurrentChaptersInput.value = settings.concurrentChapters;
    concurrentImagesInput.value = settings.concurrentImages;
    retryCountInput.value = settings.retryCount;
    retryDelayInput.value = settings.retryDelay;
    stabilityChecksInput.value = settings.stabilityChecks;
    overallTimeoutSecondsInput.value = settings.overallTimeoutSeconds;
  }
  
  const messageListener = (request, sender) => {
    if (sender.tab && sender.tab.id === currentTab.id && request.action === 'chapterList') {
      mangaTitle = request.mangaTitle;
      populateChapterList(request.chapters);
      chrome.runtime.onMessage.removeListener(messageListener);
    }
  };
  
  function requestChaptersFromPage(lang) {
    statusDiv.textContent = 'Loading chapters...';
    chapterListDiv.innerHTML = '';
    downloadSelectedBtn.disabled = true;
    selectAllCheckbox.checked = false;
    selectionCounter.textContent = '0 selected';
    lastCheckedCheckbox = null;

    if (chrome.runtime.onMessage.hasListener(messageListener)) {
      chrome.runtime.onMessage.removeListener(messageListener);
    }
    chrome.runtime.onMessage.addListener(messageListener);
    
    chrome.scripting.executeScript({
      target: { tabId: currentTab.id },
      files: ['info_scraper.js'],
    }, () => {
      chrome.tabs.sendMessage(currentTab.id, { action: 'getChapters', language: lang });
    });
  }

  function updateSelectionState() {
    const checkboxes = chapterListDiv.querySelectorAll('input[type="checkbox"]');
    const checkedCount = chapterListDiv.querySelectorAll('input:checked').length;
    const totalCount = checkboxes.length;

    downloadSelectedBtn.disabled = checkedCount === 0;
    selectAllCheckbox.checked = totalCount > 0 && checkedCount === totalCount;
    selectAllCheckbox.indeterminate = checkedCount > 0 && checkedCount < totalCount;
    selectionCounter.textContent = `${checkedCount} of ${totalCount} selected`;
  }

  function populateChapterList(chapters) {
    if (chapters.length === 0) {
      statusDiv.textContent = 'No chapters found for this language.';
      selectionCounter.textContent = '0 selected';
      return;
    }

    chapters.forEach(chapter => {
      const item = document.createElement('div');
      item.className = 'chapter-item';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.id = `chapter-${chapter.url}`;
      checkbox.dataset.url = chapter.url;
      checkbox.dataset.title = chapter.title;
      const label = document.createElement('label');
      label.setAttribute('for', `chapter-${chapter.url}`);
      label.textContent = chapter.title;
      item.appendChild(checkbox);
      item.appendChild(label);
      chapterListDiv.appendChild(item);
    });

    selectionCounter.textContent = `0 of ${chapters.length} selected`;
    statusDiv.textContent = `Found ${chapters.length} chapters.`;
  }
});
