const path = require('path');
const fs = require('fs');
const { query } = require('../config/database');
const pdfService = require('../services/pdfService');

// ── Helpers ───────────────────────────────────────────────────────────────────

const getFolderDepth = async (folderId) => {
  let depth = 0;
  let currentId = folderId;
  while (currentId) {
    const r = await query('SELECT parent_id FROM pdf_folders WHERE id = $1', [currentId]);
    if (!r.rows.length || !r.rows[0].parent_id) break;
    depth++;
    currentId = r.rows[0].parent_id;
    if (depth >= 3) return depth;
  }
  return depth;
};

// ── FOLDERS ──────────────────────────────────────────────────────────────────

const getFolders = async (req, res, next) => {
  try {
    const result = await query(
      `SELECT f.*, COUNT(p.id)::int AS pdf_count
       FROM pdf_folders f
       LEFT JOIN pdfs p ON p.folder_id = f.id
       WHERE f.user_id = $1
       GROUP BY f.id
       ORDER BY f.parent_id NULLS FIRST, f.created_at ASC`,
      [req.user.id]
    );
    res.json({ success: true, folders: result.rows });
  } catch (err) { next(err); }
};

const createFolder = async (req, res, next) => {
  try {
    const { name, icon = '📂', color = '#6c63ff', parent_id = null } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'Folder name is required' });

    if (parent_id) {
      const parentCheck = await query(
        'SELECT id FROM pdf_folders WHERE id = $1 AND user_id = $2',
        [parent_id, req.user.id]
      );
      if (!parentCheck.rows.length) {
        return res.status(404).json({ success: false, error: 'Parent folder not found' });
      }
      const parentDepth = await getFolderDepth(parent_id);
      if (parentDepth >= 2) {
        return res.status(400).json({ success: false, error: 'Maximum folder depth (3 levels) reached' });
      }
    }

    const result = await query(
      'INSERT INTO pdf_folders (user_id, name, icon, color, parent_id) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [req.user.id, name.trim(), icon, color, parent_id || null]
    );
    res.status(201).json({ success: true, folder: result.rows[0] });
  } catch (err) { next(err); }
};

const updateFolder = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, icon, color, parent_id } = req.body;
    const updates = []; const values = []; let idx = 1;

    if (name      !== undefined) { updates.push(`name = $${idx++}`);  values.push(name.trim()); }
    if (icon      !== undefined) { updates.push(`icon = $${idx++}`);  values.push(icon); }
    if (color     !== undefined) { updates.push(`color = $${idx++}`); values.push(color); }
    if (parent_id !== undefined) {
      if (parent_id) {
        let check = parent_id;
        let isCyclic = false;
        while (check) {
          if (String(check) === String(id)) { isCyclic = true; break; }
          const r = await query('SELECT parent_id FROM pdf_folders WHERE id = $1', [check]);
          if (!r.rows.length) break;
          check = r.rows[0].parent_id;
        }
        if (isCyclic) return res.status(400).json({ success: false, error: 'Cannot move a folder into its own descendant' });
        const parentDepth = await getFolderDepth(parent_id);
        if (parentDepth >= 2) return res.status(400).json({ success: false, error: 'Maximum folder depth (3 levels) reached' });
      }
      updates.push(`parent_id = $${idx++}`);
      values.push(parent_id || null);
    }

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
    const { id } = req.params;

    // Collect all descendant folder IDs (including self) via recursive CTE
    const descendants = await query(
      `WITH RECURSIVE desc_tree AS (
         SELECT id FROM pdf_folders WHERE id = $1 AND user_id = $2
         UNION ALL
         SELECT f.id FROM pdf_folders f
         JOIN desc_tree d ON f.parent_id = d.id
       )
       SELECT id FROM desc_tree`,
      [id, req.user.id]
    );

    if (!descendants.rows.length) {
      return res.status(404).json({ success: false, error: 'Folder not found' });
    }

    const allIds = descendants.rows.map(r => r.id);

    // Gather file paths for all PDFs in these folders before cascade delete
    const pdfFiles = await query(
      `SELECT file_path FROM pdfs WHERE folder_id = ANY($1::uuid[]) AND user_id = $2`,
      [allIds, req.user.id]
    );

    // Delete the root folder — DB CASCADE removes all descendants + their PDFs rows
    await query(
      'DELETE FROM pdf_folders WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    // Delete physical files
    for (const pdf of pdfFiles.rows) {
      if (pdf.file_path && fs.existsSync(pdf.file_path)) {
        try { fs.unlinkSync(pdf.file_path); } catch { /* silent */ }
      }
    }

    res.json({ success: true, message: 'Folder and all subfolders deleted.' });
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
      `SELECT p.*, f.name AS folder_name, f.color AS folder_color, f.parent_id AS folder_parent_id
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
    const filePath = path.resolve(req.file.path);
    const filename = req.file.filename;
    const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    const fileSize = req.file.size;

    const result = await query(
      `INSERT INTO pdfs (user_id, folder_id, filename, original_name, file_size, page_count, extracted_text, file_path)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.user.id, folder_id || null, filename, originalName, fileSize, 0, '', filePath]
    );

    const savedPdf = result.rows[0];
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
        'Content-Disposition': `inline; filename="${encodeURIComponent(pdf.original_name)}"`,
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

/**
 * cleanupOrphanedFiles — run at server startup.
 */
const cleanupOrphanedFiles = async (uploadDir) => {
  try {
    console.log('[Storage] Running orphan cleanup...');
    if (!fs.existsSync(uploadDir)) return;
    const dbResult = await query('SELECT filename, file_path FROM pdfs');
    const dbFilenames = new Set(dbResult.rows.map(r => r.filename));
    let deletedFiles = 0;
    const userDirs = fs.readdirSync(uploadDir);
    for (const userDir of userDirs) {
      const userDirPath = path.join(uploadDir, userDir);
      if (!fs.statSync(userDirPath).isDirectory()) continue;
      const files = fs.readdirSync(userDirPath);
      for (const file of files) {
        if (!dbFilenames.has(file)) {
          try { fs.unlinkSync(path.join(userDirPath, file)); deletedFiles++; } catch { /* silent */ }
        }
      }
      try {
        if (fs.readdirSync(userDirPath).length === 0) fs.rmdirSync(userDirPath);
      } catch { /* silent */ }
    }
    if (deletedFiles > 0) console.log(`[Storage] Deleted ${deletedFiles} orphaned file(s) from disk.`);
    const allPdfs = await query('SELECT id, file_path FROM pdfs');
    const staleIds = allPdfs.rows.filter(r => r.file_path && !fs.existsSync(r.file_path)).map(r => r.id);
    if (staleIds.length > 0) {
      await query('DELETE FROM pdfs WHERE id = ANY($1::uuid[])', [staleIds]);
      console.log(`[Storage] Removed ${staleIds.length} stale DB record(s) with missing files.`);
    }
    console.log('[Storage] Orphan cleanup complete.');
  } catch (err) {
    console.error('[Storage] Cleanup error:', err.message);
  }
};

module.exports = {
  getFolders, createFolder, updateFolder, deleteFolder,
  getPdfs, getPdf, uploadPdf, downloadPdf, streamPdf, updatePdf, deletePdf,
  cleanupOrphanedFiles
};
