chrome.runtime.onMessage.addListener((request) => {
  if (request.action !== 'createPdfOffscreen') {
    return;
  }

  const { imageUrls, mangaTitle, chapter, chapterFolderName } = request;
  const sources = Array.isArray(imageUrls) ? imageUrls.filter(source => typeof source === 'string' && source.trim()) : [];

  if (sources.length === 0) {
    console.error('No image sources provided for PDF export.');
    return;
  }

  (async () => {
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF();
    let addedPages = 0;

    for (let i = 0; i < sources.length; i++) {
      const normalizedImage = await imageToJpegDataUrl(sources[i]);

      if (!normalizedImage) {
        console.warn(`Skipping image ${i + 1} because it could not be loaded.`);
        continue;
      }

      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const ratio = Math.min(pageWidth / normalizedImage.width, pageHeight / normalizedImage.height);
      const imgWidth = normalizedImage.width * ratio;
      const imgHeight = normalizedImage.height * ratio;
      const x = (pageWidth - imgWidth) / 2;
      const y = (pageHeight - imgHeight) / 2;

      if (addedPages > 0) {
        pdf.addPage();
      }

      pdf.addImage(normalizedImage.dataUrl, 'JPEG', x, y, imgWidth, imgHeight);
      addedPages++;
    }

    if (addedPages === 0) {
      console.error('No images could be added to the PDF.');
      return;
    }

    const pdfBlob = pdf.output('blob');
    const pdfFilename = `${sanitizeFilenamePart(mangaTitle)} - ${sanitizeFilenamePart(chapterFolderName || chapter.name)}.pdf`;

    const reader = new FileReader();
    reader.onload = function () {
      // Send the data URL back to the service worker to handle the download
      chrome.runtime.sendMessage({
        action: 'downloadPdf',
        url: reader.result,
        filename: pdfFilename
      });
    };
    reader.onerror = function () {
      console.error('Failed to prepare PDF for download:', reader.error);
    };
    reader.readAsDataURL(pdfBlob);
  })().catch(error => {
    console.error('Failed to create PDF:', error);
  });
});

function imageToJpegDataUrl(source) {
  return new Promise(resolve => {
    const img = new Image();

    img.onload = function () {
      try {
        const mime = getImageMime(source);

        if (mime === 'image/jpeg') {
          resolve({
            dataUrl: source,
            width: img.naturalWidth || img.width,
            height: img.naturalHeight || img.height
          });
          return;
        }

        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;

        const context = canvas.getContext('2d');
        context.fillStyle = '#fff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(img, 0, 0, canvas.width, canvas.height);

        resolve({
          dataUrl: canvas.toDataURL('image/jpeg', 0.95),
          width: canvas.width,
          height: canvas.height
        });
      } catch (error) {
        console.error('Failed to normalize image for PDF:', error);
        resolve(null);
      }
    };

    img.onerror = function () {
      console.warn(`Image could not be loaded for PDF export: ${source}`);
      resolve(null);
    };

    img.src = source;
  });
}

function getImageMime(source) {
  const match = source.match(/^data:([^;,]+)/i);
  return match ? match[1].toLowerCase() : '';
}

function sanitizeFilenamePart(text) {
  return (text || '').toString().trim().replace(/[<>:"/\\|?*]+/g, '') || 'Chapter';
}
