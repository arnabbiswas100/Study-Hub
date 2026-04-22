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
    const { content, contextType, contextRefId } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({ success: false, error: 'Message content is required' });
    }

    // Verify session ownership
    const session = await query(
      'SELECT * FROM chat_sessions WHERE id=$1 AND user_id=$2',
      [sessionId, req.user.id]
    );
    if (!session.rows.length) return res.status(404).json({ success: false, error: 'Session not found' });

    // Save user message
    const userMsg = await query(
      `INSERT INTO chat_messages (session_id, user_id, role, content, context_type, context_ref_id)
       VALUES ($1,$2,'user',$3,$4,$5) RETURNING *`,
      [sessionId, req.user.id, content.trim(), contextType || null, contextRefId || null]
    );

    // Gather context
    const context = await buildContext(req.user.id, content, contextType, contextRefId);

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

    // Check if AI wants to create a note
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
          aiResponse = aiResponse.replace(/\[\[CREATE_NOTE\]\][\s\S]*?\[\[\/CREATE_NOTE\]\]/, '').trim();
          aiResponse += '\n\n✅ **Note saved to your Notes library!**';
        } catch (e) {
          console.error('Failed to save AI note:', e.message);
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

async function buildContext(userId, userMessage, contextType, contextRefId) {
  const context = { notes: [], pdfs: [], specificContent: null };
  const msg = userMessage.toLowerCase();

  // Detect intent keywords
  const wantsNotes = msg.includes('note') || msg.includes('notes');
  const wantsPdf = msg.includes('pdf') || msg.includes('document') || msg.includes('summarize');

  if (contextType === 'pdf' && contextRefId) {
    const result = await query(
      'SELECT original_name, extracted_text, page_count FROM pdfs WHERE id=$1 AND user_id=$2',
      [contextRefId, userId]
    );
    if (result.rows.length) {
      context.specificContent = { type: 'pdf', ...result.rows[0] };
    }
  } else if (contextType === 'note' && contextRefId) {
    const result = await query(
      'SELECT title, content FROM notes WHERE id=$1 AND user_id=$2',
      [contextRefId, userId]
    );
    if (result.rows.length) {
      context.specificContent = { type: 'note', ...result.rows[0] };
    }
  }

  // Include recent notes if relevant
  if (wantsNotes && !context.specificContent) {
    const notes = await query(
      'SELECT title, content FROM notes WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 5',
      [userId]
    );
    context.notes = notes.rows;
  }

  // Include PDF list if relevant
  if (wantsPdf && !context.specificContent) {
    const pdfs = await query(
      'SELECT id, original_name, page_count, extracted_text FROM pdfs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 3',
      [userId]
    );
    context.pdfs = pdfs.rows;
  }

  return context;
}

module.exports = { getSessions, createSession, updateSession, deleteSession, getMessages, sendMessage };
