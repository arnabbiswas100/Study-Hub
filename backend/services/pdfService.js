const fs = require('fs');

/**
 * Shared helper: extract text from a PDF buffer using pdfjs-dist directly.
 * Uses the legacy ESM build with worker disabled for Node.js compatibility.
 *
 * @param {Buffer} buffer - The raw PDF file bytes
 * @returns {Promise<{ text: string, pageCount: number }>}
 */
const extractTextFromBuffer = async (buffer) => {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');

  // Disable worker — there is no Web Worker in Node.js
  pdfjsLib.GlobalWorkerOptions.workerSrc = '';

  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    disableWorker: true,
    useSystemFonts: true,
  });
  const doc = await loadingTask.promise;

  const pageTexts = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const pageStr = content.items.map(item => item.str).join(' ');
    pageTexts.push(pageStr);
  }

  // Strip null bytes (0x00) — PDFs often contain them but PostgreSQL rejects them in UTF-8 columns
  const text = pageTexts.join('\n').replace(/\0/g, '').trim();
  const pageCount = doc.numPages;

  console.log(`[PDF] Extracted with pdfjs-dist (${pageCount} pages, ${text.length} chars)`);
  return { text, pageCount };
};

const extractText = async (filePath) => {
  try {
    const buffer = fs.readFileSync(filePath);
    const { text, pageCount } = await extractTextFromBuffer(buffer);
    return {
      text: text || '',
      pageCount: pageCount || 0,
      info: {}
    };
  } catch (err) {
    console.error('PDF parse error:', err.message);
    return { text: '', pageCount: 0, info: {} };
  }
};

/**
 * Extract text from a PDF in the background, updating the DB record when done.
 * This is fire-and-forget — the caller does not await it.
 * @param {string} filePath - Path to the PDF on disk
 * @param {string} pdfId - DB id of the PDF record to update
 * @param {Function} queryFn - The DB query function
 */
const extractTextInBackground = (filePath, pdfId, queryFn) => {
  // Intentionally not awaited by the caller — runs async in the background
  (async () => {
    try {
      console.log(`[PDF] Starting background text extraction for PDF ${pdfId}`);
      const buffer = fs.readFileSync(filePath);

      // Set a timeout for extraction — abort if it takes > 60s
      const extractionPromise = extractTextFromBuffer(buffer);
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Text extraction timed out after 60s')), 60000)
      );

      const data = await Promise.race([extractionPromise, timeoutPromise]);
      const extractedText = (data.text || '').slice(0, 100000); // cap at 100k chars
      const pageCount = data.pageCount || 0;

      await queryFn(
        'UPDATE pdfs SET extracted_text = $1, page_count = $2 WHERE id = $3',
        [extractedText, pageCount, pdfId]
      );

      console.log(`[PDF] Background extraction complete for PDF ${pdfId} (${pageCount} pages)`);
    } catch (err) {
      console.error(`[PDF] Background extraction failed for PDF ${pdfId}:`, err.message);
      // Non-fatal — the PDF record already exists, just without extracted text
    }
  })();
};

module.exports = { extractText, extractTextInBackground };
