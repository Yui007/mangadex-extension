document.addEventListener('DOMContentLoaded', () => {
  const downloadChapterBtn = document.getElementById('downloadChapterBtn');
  const mangaView = document.getElementById('mangaView');
  const languageSelect = document.getElementById('languageSelect');
  const chapterListDiv = document.getElementById('chapterList');
  const downloadSelectedBtn = document.getElementById('downloadSelectedBtn');
  const statusDiv = document.getElementById('status');
  const selectAllCheckbox = document.getElementById('selectAllCheckbox');
  const selectionCounter = document.getElementById('selectionCounter');

  // Progress elements
  const progressContainer = document.getElementById('progressContainer');
  const progressBar = document.getElementById('progressBar');
  const progressText = document.getElementById('progressText');

  const downloadAsInput = document.getElementById('downloadAs');
  const concurrentChaptersInput = document.getElementById('concurrentChapters');
  const concurrentImagesInput = document.getElementById('concurrentImages');
  const retryCountInput = document.getElementById('retryCount');
  const retryDelayInput = document.getElementById('retryDelay');
  const dataSaverInput = document.getElementById('dataSaver');
  const includeChapterNumberInput = document.getElementById('includeChapterNumber');
  const saveSettingsBtn = document.getElementById('saveSettingsBtn');
  const settingsStatusDiv = document.getElementById('settingsStatus');

  const tabButtons = document.querySelectorAll('.tab');
  const panels = document.querySelectorAll('.panel');

  let currentTab;
  let mangaTitle = 'Manga';
  let mangaUuid = null;
  let lastCheckedCheckbox = null;

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    currentTab = tabs[0];
    const url = currentTab.url || '';

    if (url.includes('mangadex.org/chapter/')) {
      downloadChapterBtn.hidden = false;
    } else if (url.includes('mangadex.org/title/')) {
      mangaView.hidden = false;
      mangaUuid = extractMangaUuid(url);
      requestChaptersFromApi(languageSelect.value);
    } else {
      statusDiv.textContent = 'Not a valid MangaDex page.';
    }
  });

  loadAndDisplaySettings();

  // --- Tabs ---
  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const tabId = btn.dataset.tab;
      tabButtons.forEach(b => b.classList.remove('active'));
      panels.forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(tabId).classList.add('active');
    });
  });

  // --- Download Current Chapter ---
  downloadChapterBtn.addEventListener('click', () => {
    statusDiv.textContent = 'Starting chapter download...';
    const chapterId = extractChapterUuid(currentTab.url);
    if (!chapterId) {
      statusDiv.textContent = 'Error: Could not find chapter ID.';
      return;
    }

    chrome.scripting.executeScript({
      target: { tabId: currentTab.id },
      func: () => {
        const el = document.querySelector('a.reader--header-manga');
        const titleEl = document.querySelector('#chaptertitle_undefined span.chapter-link')
          || document.querySelector('div.reader--header-title');
        const numEl = document.querySelector('.chapter-header.two-line span.font-bold');
        const extractCh = (t) => {
          const n = (t || '').toString().trim();
          const p = [/^(?:chapter|ch\.?|c)\.?\s*(\d+(?:\.\d+)?)/i,
                     /(?:^|[\s(])(?:chapter|ch\.?|c)\.?\s*(\d+(?:\.\d+)?)(?=$|[\s):.-])/i];
          for (const rx of p) { const m = n.match(rx); if (m) return m[1].replace(/^0+(?=\d)/,''); }
          return null;
        };
        return {
          mangaTitle: (el ? el.textContent.trim() : 'Manga').replace(/[<>:"/\\|?*]+/g, ''),
          chapterTitle: titleEl ? titleEl.textContent.trim() : 'Chapter',
          chapterNumber: extractCh(titleEl ? titleEl.textContent.trim() : '')
            || (numEl ? extractCh(numEl.textContent.trim()) : null)
            || extractCh(document.title),
        };
      }
    }, (results) => {
      if (!results || !results[0]) {
        statusDiv.textContent = 'Error: Could not extract page info.';
        return;
      }
      const { mangaTitle: mt, chapterTitle, chapterNumber } = results[0].result;
      chrome.runtime.sendMessage({
        action: 'downloadSingleChapter',
        url: currentTab.url,
        mangaTitle: mt,
        chapterTitle,
        chapterNumber,
      }, (resp) => {
        if (resp?.ok) {
          statusDiv.textContent = `Queued: ${chapterTitle}`;
          showProgress();
        } else {
          statusDiv.textContent = `Error: ${resp?.error || 'Unknown'}`;
        }
      });
    });
  });

  // --- Language Select ---
  languageSelect.addEventListener('change', () => {
    requestChaptersFromApi(languageSelect.value);
  });

  // --- Select All ---
  selectAllCheckbox.addEventListener('change', () => {
    const checkboxes = chapterListDiv.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach(cb => { cb.checked = selectAllCheckbox.checked; });
    updateSelectionState();
  });

  // --- Shift+Click Range ---
  chapterListDiv.addEventListener('click', (e) => {
    const checkbox = e.target.closest('input[type="checkbox"]');
    if (!checkbox) return;
    if (e.shiftKey && lastCheckedCheckbox) {
      const checkboxes = Array.from(chapterListDiv.querySelectorAll('input[type="checkbox"]'));
      const start = checkboxes.indexOf(lastCheckedCheckbox);
      const end = checkboxes.indexOf(checkbox);
      if (start !== -1 && end !== -1) {
        const [lo, hi] = start < end ? [start, end] : [end, start];
        for (let i = lo; i <= hi; i++) checkboxes[i].checked = checkbox.checked;
      }
    }
    lastCheckedCheckbox = checkbox;
    updateSelectionState();
  });

  // --- Download Selected ---
  downloadSelectedBtn.addEventListener('click', async () => {
    const selected = Array.from(chapterListDiv.querySelectorAll('input:checked')).map(cb => ({
      id: cb.dataset.chapterId,
      chapter: cb.dataset.chapter,
      title: cb.dataset.title,
      mangaTitle: cb.dataset.mangaTitle || mangaTitle,
    }));

    if (selected.length === 0) return;

    statusDiv.textContent = `Queuing ${selected.length} chapters...`;
    downloadSelectedBtn.disabled = true;
    showProgress();

    chrome.runtime.sendMessage({
      action: 'downloadChapters',
      chapters: selected,
      mangaTitle,
    }, (resp) => {
      if (resp?.ok) {
        statusDiv.textContent = `Queued ${resp.queued} chapters.`;
      } else {
        statusDiv.textContent = `Error: ${resp?.error || 'Unknown'}`;
        downloadSelectedBtn.disabled = false;
      }
    });
  });

  // --- Settings ---
  saveSettingsBtn.addEventListener('click', async () => {
    const newSettings = {
      downloadAs: downloadAsInput.value,
      concurrentChapters: parseInt(concurrentChaptersInput.value, 10),
      concurrentImages: parseInt(concurrentImagesInput.value, 10),
      retryCount: parseInt(retryCountInput.value, 10),
      retryDelay: parseInt(retryDelayInput.value, 10),
      dataSaver: dataSaverInput.checked,
      includeChapterNumber: includeChapterNumberInput.checked,
    };
    await saveSettings(newSettings);
    settingsStatusDiv.textContent = '✓ Settings saved';
    settingsStatusDiv.style.opacity = '1';
    setTimeout(() => { settingsStatusDiv.style.opacity = '0'; }, 2000);
  });

  // --- Progress Listener ---
  chrome.runtime.onMessage.addListener((request) => {
    if (request.action === 'downloadProgress') {
      updateProgressDisplay(request);
    }
  });

  // ============================================================
  //  API-based chapter listing
  // ============================================================
  function requestChaptersFromApi(lang) {
    statusDiv.textContent = 'Loading chapters...';
    chapterListDiv.innerHTML = '';
    downloadSelectedBtn.disabled = true;
    selectAllCheckbox.checked = false;
    updateIndeterminate(selectAllCheckbox, false);
    selectionCounter.textContent = '0 selected';
    lastCheckedCheckbox = null;

    if (!mangaUuid) {
      statusDiv.textContent = 'Error: No manga UUID found.';
      return;
    }

    chrome.runtime.sendMessage({
      action: 'fetchChapterList',
      url: currentTab.url,
      language: lang,
      mangaTitle,
    }, (response) => {
      if (!response || !response.ok) {
        statusDiv.textContent = `API error: ${response?.error || 'No response'}`;
        return;
      }
      mangaTitle = response.mangaTitle || mangaTitle;
      populateChapterList(response.chapters);
    });
  }

  function populateChapterList(chapters) {
    if (chapters.length === 0) {
      statusDiv.textContent = 'No chapters found for this language.';
      selectionCounter.textContent = '0 selected';
      return;
    }

    chapters.forEach(ch => {
      const item = document.createElement('div');
      item.className = 'chapter-item';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.id = `ch-${ch.id}`;
      checkbox.dataset.chapterId = ch.id;
      checkbox.dataset.chapter = ch.chapter;
      checkbox.dataset.title = ch.title;
      checkbox.dataset.mangaTitle = mangaTitle;

      const chkCustom = document.createElement('span');
      chkCustom.className = 'chk-custom';

      const label = document.createElement('label');
      label.className = 'ch-label';
      label.setAttribute('for', `ch-${ch.id}`);
      const volStr = ch.volume && ch.volume !== 'none' ? `[Vol.${ch.volume}] ` : '';
      label.textContent = `${volStr}Ch. ${ch.chapter}${ch.title ? ` - ${ch.title}` : ''}`;

      item.appendChild(checkbox);
      item.appendChild(chkCustom);
      item.appendChild(label);
      chapterListDiv.appendChild(item);
    });

    selectionCounter.textContent = `0 of ${chapters.length} selected`;
    statusDiv.textContent = `Found ${chapters.length} chapters.`;
  }

  // ============================================================
  //  Progress Display
  // ============================================================
  function showProgress() {
    progressContainer.hidden = false;
    progressBar.style.width = '0%';
    progressText.textContent = 'Initializing…';
  }

  function updateProgressDisplay(data) {
    progressContainer.hidden = false;

    switch (data.type) {
      case 'chapterStart':
        progressText.textContent = `Downloading: ${data.chapterTitle || ''}`;
        progressBar.style.width = '0%';
        break;
      case 'chapterImages':
        progressText.textContent = `${data.chapterTitle}: 0/${data.totalImages} pages`;
        break;
      case 'imageProgress':
        progressBar.style.width = `${data.percent}%`;
        progressText.textContent = `${data.completed}/${data.total} pages`;
        break;
      case 'chapterDone':
        progressText.textContent = `✓ ${data.chapterTitle} done`;
        progressBar.style.width = '100%';
        break;
      case 'allDone':
        progressText.textContent = '✓ All downloads complete!';
        progressBar.style.width = '100%';
        setTimeout(() => { progressContainer.hidden = true; }, 3000);
        break;
    }
  }

  // ============================================================
  //  Selection State
  // ============================================================
  function updateSelectionState() {
    const checkboxes = chapterListDiv.querySelectorAll('input[type="checkbox"]');
    const checkedCount = chapterListDiv.querySelectorAll('input:checked').length;
    const totalCount = checkboxes.length;
    downloadSelectedBtn.disabled = checkedCount === 0;
    const allChecked = totalCount > 0 && checkedCount === totalCount;
    selectAllCheckbox.checked = allChecked;
    updateIndeterminate(selectAllCheckbox, !allChecked && checkedCount > 0);
    selectionCounter.textContent = `${checkedCount} of ${totalCount} selected`;
  }

  function updateIndeterminate(checkbox, state) {
    checkbox.indeterminate = state;
    // Style parent's .checkmark based on indeterminate state
    const checkmark = checkbox.parentElement?.querySelector('.checkmark');
    if (checkmark) {
      checkmark.style.setProperty('--indet', state ? '1' : '0');
    }
  }

  // ============================================================
  //  Helpers
  // ============================================================
  function extractMangaUuid(url) {
    const m = url.match(/mangadex\.org\/title\/([a-f0-9-]+)/i);
    return m ? m[1] : null;
  }

  function extractChapterUuid(url) {
    const m = url.match(/mangadex\.org\/chapter\/([a-f0-9-]+)/i);
    return m ? m[1] : null;
  }

  async function loadAndDisplaySettings() {
    const s = await getSettings();
    downloadAsInput.value = s.downloadAs;
    concurrentChaptersInput.value = s.concurrentChapters;
    concurrentImagesInput.value = s.concurrentImages;
    retryCountInput.value = s.retryCount;
    retryDelayInput.value = s.retryDelay;
    dataSaverInput.checked = s.dataSaver;
    includeChapterNumberInput.checked = s.includeChapterNumber;
  }
});
