const fs = require('fs');

const extractText = async (filePath) => {
  try {
    const pdfParse = require('pdf-parse');
    const buffer = fs.readFileSync(filePath);
    const data = await pdfParse(buffer);
    return {
      text: data.text || '',
      pageCount: data.numpages || 0,
      info: data.info || {}
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
      const pdfParse = require('pdf-parse');
      const buffer = fs.readFileSync(filePath);

      // Set a timeout for extraction — abort if it takes > 60s
      const extractionPromise = pdfParse(buffer);
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Text extraction timed out after 60s')), 60000)
      );

      const data = await Promise.race([extractionPromise, timeoutPromise]);
      const extractedText = (data.text || '').slice(0, 100000); // cap at 100k chars
      const pageCount = data.numpages || 0;

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
