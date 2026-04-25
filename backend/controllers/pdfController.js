const path = require('path');
const fs = require('fs');
const { query } = require('../config/database');
const pdfService = require('../services/pdfService');

// ── FOLDERS ──────────────────────────────────────────────────────────────────

const getFolders = async (req, res, next) => {
  try {
    const result = await query(
      `SELECT f.*, COUNT(p.id)::int AS pdf_count
       FROM pdf_folders f
       LEFT JOIN pdfs p ON p.folder_id = f.id
       WHERE f.user_id = $1
       GROUP BY f.id
       ORDER BY f.created_at ASC`,
      [req.user.id]
    );
    res.json({ success: true, folders: result.rows });
  } catch (err) { next(err); }
};

const createFolder = async (req, res, next) => {
  try {
    const { name, icon = '📂', color = '#6c63ff' } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'Folder name is required' });
    const result = await query(
      'INSERT INTO pdf_folders (user_id, name, icon, color) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.user.id, name.trim(), icon, color]
    );
    res.status(201).json({ success: true, folder: result.rows[0] });
  } catch (err) { next(err); }
};

const updateFolder = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, icon, color } = req.body;
    const updates = []; const values = []; let idx = 1;
    if (name !== undefined) { updates.push(`name = $${idx++}`); values.push(name.trim()); }
    if (icon !== undefined) { updates.push(`icon = $${idx++}`); values.push(icon); }
    if (color !== undefined) { updates.push(`color = $${idx++}`); values.push(color); }
    if (!updates.length) return res.status(400).json({ success: false, error: 'Nothing to update' });
    values.push(id, req.user.id);
    const result = await query(
      `UPDATE pdf_folders SET ${updates.join(', ')} WHERE id = $${idx++} AND user_id = $${idx} RETURNING *`,
      values
    );
    if (!result.rows.length) return res.status(404).json({ success: false, error: 'Folder not found' });
    res.json({ success: true, folder: result.rows[0] });
  } catch (err) { next(err); }
};

const deleteFolder = async (req, res, next) => {
  try {
    const result = await query(
      'DELETE FROM pdf_folders WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ success: false, error: 'Folder not found' });
    res.json({ success: true, message: 'Folder deleted' });
  } catch (err) { next(err); }
};

// ── PDFs ──────────────────────────────────────────────────────────────────────

const getPdfs = async (req, res, next) => {
  try {
    const { folder, search } = req.query;
    const conditions = ['p.user_id = $1'];
    const values = [req.user.id];
    let idx = 2;

    if (folder === 'uncategorized') {
      conditions.push('p.folder_id IS NULL');
    } else if (folder) {
      conditions.push(`p.folder_id = $${idx++}`);
      values.push(folder);
    }

    if (search) {
      conditions.push(`p.original_name ILIKE $${idx++}`);
      values.push(`%${search}%`);
    }

    const result = await query(
      `SELECT p.*, f.name AS folder_name, f.color AS folder_color
       FROM pdfs p
       LEFT JOIN pdf_folders f ON f.id = p.folder_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY p.created_at DESC`,
      values
    );
    res.json({ success: true, pdfs: result.rows });
  } catch (err) { next(err); }
};

const getPdf = async (req, res, next) => {
  try {
    const result = await query(
      'SELECT * FROM pdfs WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ success: false, error: 'PDF not found' });
    res.json({ success: true, pdf: result.rows[0] });
  } catch (err) { next(err); }
};

const uploadPdf = async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'No PDF file provided' });

    const { folder_id } = req.body;
    const filePath = req.file.path;
    const filename = req.file.filename;
    const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    const fileSize = req.file.size;

    // Save PDF record immediately (with empty text — extraction happens in background)
    const result = await query(
      `INSERT INTO pdfs (user_id, folder_id, filename, original_name, file_size, page_count, extracted_text, file_path)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.user.id, folder_id || null, filename, originalName, fileSize, 0, '', filePath]
    );

    const savedPdf = result.rows[0];

    // Kick off text extraction in the background (fire-and-forget)
    pdfService.extractTextInBackground(filePath, savedPdf.id, query);

    res.status(201).json({ success: true, pdf: savedPdf });
  } catch (err) { next(err); }
};

const downloadPdf = async (req, res, next) => {
  try {
    const result = await query(
      'SELECT * FROM pdfs WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ success: false, error: 'PDF not found' });

    const pdf = result.rows[0];
    if (!fs.existsSync(pdf.file_path)) {
      return res.status(404).json({ success: false, error: 'File not found on disk' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(pdf.original_name)}"`);
    fs.createReadStream(pdf.file_path).pipe(res);
  } catch (err) { next(err); }
};

const streamPdf = async (req, res, next) => {
  try {
    const result = await query(
      'SELECT * FROM pdfs WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ success: false, error: 'PDF not found' });

    const pdf = result.rows[0];
    if (!fs.existsSync(pdf.file_path)) {
      return res.status(404).json({ success: false, error: 'File not found on disk' });
    }

    const stat = fs.statSync(pdf.file_path);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': 'application/pdf',
      });
      fs.createReadStream(pdf.file_path, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${encodeURIComponent(pdf.original_name)}"`,
        'Accept-Ranges': 'bytes',
      });
      fs.createReadStream(pdf.file_path).pipe(res);
    }
  } catch (err) { next(err); }
};

const updatePdf = async (req, res, next) => {
  try {
    const { folder_id } = req.body;
    const result = await query(
      'UPDATE pdfs SET folder_id = $1 WHERE id = $2 AND user_id = $3 RETURNING *',
      [folder_id || null, req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ success: false, error: 'PDF not found' });
    res.json({ success: true, pdf: result.rows[0] });
  } catch (err) { next(err); }
};

const deletePdf = async (req, res, next) => {
  try {
    const result = await query(
      'DELETE FROM pdfs WHERE id = $1 AND user_id = $2 RETURNING *',
      [req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ success: false, error: 'PDF not found' });

    const pdf = result.rows[0];
    if (pdf.file_path && fs.existsSync(pdf.file_path)) {
      fs.unlinkSync(pdf.file_path);
    }

    res.json({ success: true, message: 'PDF deleted' });
  } catch (err) { next(err); }
};

module.exports = {
  getFolders, createFolder, updateFolder, deleteFolder,
  getPdfs, getPdf, uploadPdf, downloadPdf, streamPdf, updatePdf, deletePdf
};
