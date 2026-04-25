const { query } = require('../config/database');
const llmService = require('../services/llmService');

// ── SESSIONS ──────────────────────────────────────────────────────────────────

const getSessions = async (req, res, next) => {
  try {
    const result = await query(
      `SELECT s.*, 
        (SELECT content FROM chat_messages WHERE session_id = s.id ORDER BY created_at DESC LIMIT 1) AS last_message,
        (SELECT COUNT(*)::int FROM chat_messages WHERE session_id = s.id) AS message_count
       FROM chat_sessions s
       WHERE s.user_id = $1
       ORDER BY s.updated_at DESC`,
      [req.user.id]
    );
    res.json({ success: true, sessions: result.rows });
  } catch (err) { next(err); }
};

const createSession = async (req, res, next) => {
  try {
    const { title = 'New Chat' } = req.body;
    const result = await query(
      'INSERT INTO chat_sessions (user_id, title) VALUES ($1,$2) RETURNING *',
      [req.user.id, title]
    );
    res.status(201).json({ success: true, session: result.rows[0] });
  } catch (err) { next(err); }
};

const updateSession = async (req, res, next) => {
  try {
    const { title } = req.body;
    if (!title) return res.status(400).json({ success: false, error: 'Title is required' });
    const result = await query(
      'UPDATE chat_sessions SET title=$1 WHERE id=$2 AND user_id=$3 RETURNING *',
      [title, req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ success: false, error: 'Session not found' });
    res.json({ success: true, session: result.rows[0] });
  } catch (err) { next(err); }
};

const deleteSession = async (req, res, next) => {
  try {
    const result = await query(
      'DELETE FROM chat_sessions WHERE id=$1 AND user_id=$2 RETURNING id',
      [req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ success: false, error: 'Session not found' });
    res.json({ success: true, message: 'Chat session deleted' });
  } catch (err) { next(err); }
};

const getMessages = async (req, res, next) => {
  try {
    // Verify session ownership
    const session = await query(
      'SELECT id FROM chat_sessions WHERE id=$1 AND user_id=$2',
      [req.params.id, req.user.id]
    );
    if (!session.rows.length) return res.status(404).json({ success: false, error: 'Session not found' });

    const result = await query(
      'SELECT * FROM chat_messages WHERE session_id=$1 ORDER BY created_at ASC',
      [req.params.id]
    );
    res.json({ success: true, messages: result.rows });
  } catch (err) { next(err); }
};

// ── CHAT (send message + get AI response) ─────────────────────────────────────

const sendMessage = async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    // Support both legacy single-item fields and the array fields sent by the frontend
    const {
      content,
      context_note_ids,
      context_pdf_ids,
      // legacy fallback fields (kept for backwards compat)
      contextType,
      contextRefId,
    } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({ success: false, error: 'Message content is required' });
    }

    // Normalise to arrays (frontend sends context_note_ids / context_pdf_ids)
    const noteIds = Array.isArray(context_note_ids) ? context_note_ids
      : (context_note_ids ? [context_note_ids] : []);
    const pdfIds  = Array.isArray(context_pdf_ids)  ? context_pdf_ids
      : (context_pdf_ids  ? [context_pdf_ids]  : []);

    // Legacy single-item support: if arrays are empty but old fields are set, use those
    if (noteIds.length === 0 && contextType === 'note' && contextRefId) noteIds.push(contextRefId);
    if (pdfIds.length  === 0 && contextType === 'pdf'  && contextRefId) pdfIds.push(contextRefId);

    // Verify session ownership
    const session = await query(
      'SELECT * FROM chat_sessions WHERE id=$1 AND user_id=$2',
      [sessionId, req.user.id]
    );
    if (!session.rows.length) return res.status(404).json({ success: false, error: 'Session not found' });

    // Save user message (store first note/pdf id for reference if available)
    const savedContextType   = noteIds.length ? 'note' : (pdfIds.length ? 'pdf' : null);
    const savedContextRefId  = noteIds[0] || pdfIds[0] || null;
    const userMsg = await query(
      `INSERT INTO chat_messages (session_id, user_id, role, content, context_type, context_ref_id)
       VALUES ($1,$2,'user',$3,$4,$5) RETURNING *`,
      [sessionId, req.user.id, content.trim(), savedContextType, savedContextRefId]
    );

    // Gather context
    const context = await buildContext(req.user.id, content, noteIds, pdfIds);

    // Fetch message history (last 20)
    const history = await query(
      `SELECT role, content FROM chat_messages
       WHERE session_id=$1 ORDER BY created_at ASC LIMIT 20`,
      [sessionId]
    );

    // Call LLM
    let aiResponse;
    try {
      aiResponse = await llmService.chat(history.rows, context, req.user);
    } catch (llmErr) {
      console.error('LLM error:', llmErr.message);
      aiResponse = `I encountered an error connecting to the AI service: ${llmErr.message}. Please check your GEMINI_API_KEY configuration.`;
    }

    // Check if AI wants to create a note (only when explicit [[CREATE_NOTE]] tags are used)
    let savedNote = null;
    if (aiResponse.includes('[[CREATE_NOTE]]')) {
      const noteMatch = aiResponse.match(/\[\[CREATE_NOTE\]\]([\s\S]*?)\[\[\/CREATE_NOTE\]\]/);
      if (noteMatch) {
        const noteContent = noteMatch[1].trim();
        const titleMatch = noteContent.match(/^#\s+(.+)/m);
        const noteTitle = titleMatch ? titleMatch[1] : 'AI Generated Note';
        try {
          const noteResult = await query(
            'INSERT INTO notes (user_id, title, content, color) VALUES ($1,$2,$3,$4) RETURNING *',
            [req.user.id, noteTitle, noteContent, '#1a2035']
          );
          savedNote = noteResult.rows[0];
        } catch (e) {
          console.error('Failed to save AI note:', e.message);
        }
        // Strip the raw CREATE_NOTE tags from the response but keep everything else
        const strippedResponse = aiResponse.replace(/\[\[CREATE_NOTE\]\][\s\S]*?\[\[\/CREATE_NOTE\]\]/, '').trim();
        // If stripping left the response empty (AI put everything in tags), use the note content as the response
        if (strippedResponse) {
          aiResponse = strippedResponse + '\n\n✅ **Note saved to your Notes library!**';
        } else {
          aiResponse = noteContent + '\n\n✅ **Note saved to your Notes library!**';
        }
      }
    }

    // Save assistant message
    const assistantMsg = await query(
      `INSERT INTO chat_messages (session_id, user_id, role, content)
       VALUES ($1,$2,'assistant',$3) RETURNING *`,
      [sessionId, req.user.id, aiResponse]
    );

    // Update session title if it's the first message
    if (session.rows[0].title === 'New Chat') {
      const autoTitle = content.trim().slice(0, 60) + (content.length > 60 ? '...' : '');
      await query('UPDATE chat_sessions SET title=$1 WHERE id=$2', [autoTitle, sessionId]);
    }

    res.json({
      success: true,
      userMessage: userMsg.rows[0],
      assistantMessage: assistantMsg.rows[0],
      savedNote
    });
  } catch (err) { next(err); }
};

// ── CONTEXT BUILDER ───────────────────────────────────────────────────────────

async function buildContext(userId, userMessage, noteIds = [], pdfIds = []) {
  const context = { notes: [], pdfs: [] };
  const msg = userMessage.toLowerCase();

  // ── Explicitly attached notes ────────────────────────────────
  if (noteIds.length > 0) {
    // Fetch all selected notes in one query using ANY($2)
    const placeholders = noteIds.map((_, i) => `$${i + 2}`).join(',');
    const result = await query(
      `SELECT title, content FROM notes WHERE user_id=$1 AND id IN (${placeholders})`,
      [userId, ...noteIds]
    );
    context.notes = result.rows;
  }

  // ── Explicitly attached PDFs ─────────────────────────────────
  if (pdfIds.length > 0) {
    const placeholders = pdfIds.map((_, i) => `$${i + 2}`).join(',');
    const result = await query(
      `SELECT original_name, extracted_text, page_count FROM pdfs WHERE user_id=$1 AND id IN (${placeholders})`,
      [userId, ...pdfIds]
    );
    context.pdfs = result.rows;
  }

  // ── Keyword-based fallback (only when nothing is attached) ───
  const hasAttached = noteIds.length > 0 || pdfIds.length > 0;
  if (!hasAttached) {
    const wantsNotes = msg.includes('note') || msg.includes('notes');
    const wantsPdf   = msg.includes('pdf') || msg.includes('document') || msg.includes('summarize');

    if (wantsNotes) {
      const notes = await query(
        'SELECT title, content FROM notes WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 5',
        [userId]
      );
      context.notes = notes.rows;
    }

    if (wantsPdf) {
      const pdfs = await query(
        'SELECT id, original_name, page_count, extracted_text FROM pdfs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 3',
        [userId]
      );
      context.pdfs = pdfs.rows;
    }
  }

  return context;
}

module.exports = { getSessions, createSession, updateSession, deleteSession, getMessages, sendMessage };
