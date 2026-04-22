/* ═══════════════════════════════════════════════════════════════
   STUDY-HUB — Chat Module
   Sessions, message send/receive, streaming, context attach
   ═══════════════════════════════════════════════════════════════ */

const Chat = (() => {
  const { toast, show, hide, debounce, formatDate, escHtml,
          renderMarkdown, autoResize, truncate, setLoading } = Helpers;

  // ── State ─────────────────────────────────────────────────────
  let state = {
    sessions:       [],
    activeSession:  null,   // full session object
    messages:       [],
    isStreaming:    false,
    context: {
      noteIds: [],
      pdfIds:  [],
      notes:   [],   // full objects for display
      pdfs:    [],
    },
  };

  const el = (id) => document.getElementById(id);

  // ─────────────────────────────────────────────────────────────
  // Sessions
  // ─────────────────────────────────────────────────────────────

  const loadSessions = async () => {
    try {
      const data  = await API.chat.getSessions();
      state.sessions = data.sessions || data.data || data || [];
      renderSessionList();

      // Restore last active session
      const savedId = Storage.getActiveChatSession();
      if (savedId) {
        const found = state.sessions.find(s => String(s.id) === String(savedId));
        if (found) { await activateSession(found, false); return; }
      }
    } catch (err) {
      console.error('Failed to load chat sessions:', err);
    }
  };

  const renderSessionList = () => {
    const list = el('chat-session-list');
    if (!list) return;
    list.innerHTML = '';

    state.sessions.forEach(s => {
      const item = document.createElement('div');
      item.className = `session-item folder-item${state.activeSession?.id === s.id ? ' active' : ''}`;
      item.dataset.id = s.id;
      item.innerHTML = `
        <span class="folder-icon">💬</span>
        <span class="folder-name session-title">${escHtml(s.title || 'New Chat')}</span>
        <div class="folder-actions">
          <button class="folder-action-btn del-session" data-id="${s.id}" title="Delete">✕</button>
        </div>
      `;
      item.addEventListener('click', (e) => {
        if (e.target.closest('.folder-actions')) return;
        activateSession(s);
      });
      item.querySelector('.del-session').addEventListener('click', (e) => {
        e.stopPropagation();
        deleteSession(s.id);
      });
      list.appendChild(item);
    });
  };

  const activateSession = async (session, scroll = true) => {
    state.activeSession = session;
    Storage.setActiveChatSession(session.id);
    renderSessionList();
    showMessagesView();
    await loadMessages(session.id, scroll);
  };

  const createSession = async (title = 'New Chat') => {
    try {
      const data    = await API.chat.createSession({ title });
      const session = data.session || data.data || data;
      state.sessions.unshift(session);
      renderSessionList();
      await activateSession(session);
    } catch (err) {
      toast.error('Failed to create chat: ' + err.message);
    }
  };

  const deleteSession = async (id) => {
    if (!confirm('Delete this chat session?')) return;
    try {
      await API.chat.deleteSession(id);
      state.sessions = state.sessions.filter(s => s.id !== id);
      if (state.activeSession?.id === id) {
        state.activeSession = null;
        state.messages = [];
        Storage.setActiveChatSession(null);
        showWelcomeView();
      }
      renderSessionList();
      toast.success('Chat deleted.');
    } catch (err) {
      toast.error('Failed to delete chat: ' + err.message);
    }
  };

  // ─────────────────────────────────────────────────────────────
  // Messages
  // ─────────────────────────────────────────────────────────────

  const loadMessages = async (sessionId, scroll = true) => {
    try {
      const data = await API.chat.getMessages(sessionId);
      state.messages = data.messages || data.data || data || [];
      renderMessages();
      if (scroll) scrollToBottom(true);
    } catch (err) {
      toast.error('Failed to load messages: ' + err.message);
    }
  };

  const renderMessages = () => {
    const list = el('messages-list');
    if (!list) return;
    list.innerHTML = '';

    state.messages.forEach(msg => {
      const bubble = buildMessageBubble(msg);
      list.appendChild(bubble);
    });
  };

  const buildMessageBubble = (msg) => {
    const isUser = msg.role === 'user';
    const wrap   = document.createElement('div');
    wrap.className = `message-wrap ${isUser ? 'user' : 'assistant'}`;
    wrap.dataset.id = msg.id || '';

    const contentHtml = isUser
      ? `<p>${escHtml(msg.content)}</p>`
      : renderMarkdown(msg.content);

    wrap.innerHTML = `
      <div class="message-bubble ${isUser ? 'user-bubble' : 'ai-bubble'}">
        ${!isUser ? '<span class="ai-label">Study-Hub AI</span>' : ''}
        <div class="message-content">${contentHtml}</div>
        <span class="message-time">${msg.created_at ? formatDate(msg.created_at) : ''}</span>
      </div>
    `;
    return wrap;
  };

  const appendMessage = (msg) => {
    state.messages.push(msg);
    const list = el('messages-list');
    if (!list) return;
    const bubble = buildMessageBubble(msg);
    list.appendChild(bubble);
    scrollToBottom();
  };

  const scrollToBottom = (instant = false) => {
    const container = el('chat-messages');
    if (!container) return;
    if (instant) {
      container.scrollTop = container.scrollHeight;
    } else {
      container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
    }
  };

  // ─────────────────────────────────────────────────────────────
  // Send message (with streaming support)
  // ─────────────────────────────────────────────────────────────

  const sendMessage = async () => {
    const input   = el('chat-input');
    const sendBtn = el('chat-send-btn');
    const content = input?.value.trim();
    if (!content || state.isStreaming) return;

    // Auto-create session if none
    if (!state.activeSession) {
      await createSession(content.slice(0, 40) || 'New Chat');
      if (!state.activeSession) return;
    }

    // Clear input
    input.value = '';
    input.style.height = 'auto';
    sendBtn.disabled = true;
    state.isStreaming = true;

    // Show user message immediately
    const userMsg = {
      role: 'user',
      content,
      created_at: new Date().toISOString(),
    };
    appendMessage(userMsg);
    showMessagesView();

    // Show typing indicator
    const typingEl = showTypingIndicator();

    try {
      const body = {
        content:          content,
        context_note_ids: state.context.noteIds,
        context_pdf_ids:  state.context.pdfIds,
      };

      const response = await API.chat.sendMessage(state.activeSession.id, body);

      removeTypingIndicator(typingEl);

      // Handle streaming vs regular response
      if (response && typeof response.getReader === 'function') {
        await handleStreamResponse(response);
      } else {
        // Regular JSON response
        const data = response;
        const aiContent = data.assistantMessage?.content
          || data.message?.content
          || data.content
          || data.reply
          || data.data?.content
          || 'No response.';

        const aiMsg = {
          role: 'assistant',
          content: aiContent,
          created_at: new Date().toISOString(),
          id: data.assistantMessage?.id || data.message?.id || data.id,
        };
        appendMessage(aiMsg);

        // Auto-update session title from first exchange
        if (state.messages.filter(m => m.role === 'user').length === 1) {
          const title = content.slice(0, 50);
          updateSessionTitle(state.activeSession.id, title);
        }
      }
    } catch (err) {
      removeTypingIndicator(typingEl);
      const errMsg = {
        role: 'assistant',
        content: `⚠️ Error: ${err.message}`,
        created_at: new Date().toISOString(),
      };
      appendMessage(errMsg);
      toast.error('Message failed: ' + err.message);
    } finally {
      state.isStreaming = false;
      sendBtn.disabled = false;
      input.focus();
    }
  };

  const handleStreamResponse = async (response) => {
    const reader  = response.getReader();
    const decoder = new TextDecoder();
    let   buffer  = '';

    // Create AI bubble for streaming
    const list = el('messages-list');
    const wrap = document.createElement('div');
    wrap.className = 'message-wrap assistant streaming';
    wrap.innerHTML = `
      <div class="message-bubble ai-bubble">
        <span class="ai-label">Study-Hub AI</span>
        <div class="message-content stream-content"></div>
        <span class="message-time">just now</span>
      </div>
    `;
    list?.appendChild(wrap);
    const contentDiv = wrap.querySelector('.stream-content');

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE or JSON chunks
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') continue;

          const text = trimmed.startsWith('data: ')
            ? trimmed.slice(6)
            : trimmed;

          try {
            const chunk = JSON.parse(text);
            const delta = chunk.choices?.[0]?.delta?.content
              || chunk.content
              || chunk.text
              || '';
            if (delta) {
              contentDiv.innerHTML = renderMarkdown(
                (contentDiv.dataset.raw || '') + delta
              );
              contentDiv.dataset.raw = (contentDiv.dataset.raw || '') + delta;
              scrollToBottom();
            }
          } catch {
            // Plain text chunk
            if (text) {
              contentDiv.innerHTML = renderMarkdown(
                (contentDiv.dataset.raw || '') + text
              );
              contentDiv.dataset.raw = (contentDiv.dataset.raw || '') + text;
              scrollToBottom();
            }
          }
        }
      }
    } finally {
      wrap.classList.remove('streaming');
      state.messages.push({
        role: 'assistant',
        content: contentDiv.dataset.raw || '',
        created_at: new Date().toISOString(),
      });
    }
  };

  const showTypingIndicator = () => {
    const list = el('messages-list');
    const el2  = document.createElement('div');
    el2.className = 'message-wrap assistant typing-wrap';
    el2.id = 'typing-indicator';
    el2.innerHTML = `
      <div class="message-bubble ai-bubble shimmer-bubble">
        <div class="shimmer-line shimmer-line--long"></div>
        <div class="shimmer-line shimmer-line--mid"></div>
        <div class="shimmer-line shimmer-line--short"></div>
      </div>
    `;
    list?.appendChild(el2);
    scrollToBottom();
    return el2;
  };

  const removeTypingIndicator = (el2) => {
    el2?.remove();
  };

  const updateSessionTitle = async (id, title) => {
    try {
      await API.chat.updateSession(id, { title });
      const s = state.sessions.find(s => s.id === id);
      if (s) s.title = title;
      renderSessionList();
    } catch { /* silent */ }
  };

  // ─────────────────────────────────────────────────────────────
  // Context attachment
  // ─────────────────────────────────────────────────────────────

  const openAttachMenu = async () => {
    const menu = el('chat-attach-menu');
    if (!menu) return;

    const isOpen = !menu.classList.contains('hidden');
    if (isOpen) { hide(menu); return; }

    await populateAttachLists();
    show(menu);

    // Close on outside click
    setTimeout(() => {
      const closeMenu = (e) => {
        if (!menu.contains(e.target) && e.target !== el('chat-attach-btn')) {
          hide(menu);
          document.removeEventListener('click', closeMenu);
        }
      };
      document.addEventListener('click', closeMenu);
    }, 10);
  };

  const populateAttachLists = async () => {
    // Notes
    const notesList = el('attach-notes-list');
    if (notesList) {
      try {
        const data  = await API.notes.getAll({ limit: 50 });
        const notes = data.notes || data.data || data || [];
        notesList.innerHTML = notes.length === 0
          ? '<p class="attach-empty">No notes yet</p>'
          : notes.map(n => `
              <label class="attach-item" data-type="note" data-id="${n.id}">
                <input type="checkbox" class="attach-checkbox"
                  value="${n.id}"
                  ${state.context.noteIds.includes(n.id) ? 'checked' : ''}
                />
                <span class="attach-item-name">${escHtml(truncate(n.title || 'Untitled', 36))}</span>
              </label>
            `).join('');

        notesList.querySelectorAll('.attach-checkbox').forEach(cb => {
          cb.addEventListener('change', () => toggleContextItem('note', cb));
        });
      } catch (err) {
        notesList.innerHTML = '<p class="attach-empty">Failed to load notes</p>';
      }
    }

    // PDFs
    const pdfsList = el('attach-pdfs-list');
    if (pdfsList) {
      try {
        const data = await API.pdfs.getAll({ limit: 50 });
        const pdfs = data.pdfs || data.data || data || [];
        pdfsList.innerHTML = pdfs.length === 0
          ? '<p class="attach-empty">No PDFs yet</p>'
          : pdfs.map(p => `
              <label class="attach-item" data-type="pdf" data-id="${p.id}">
                <input type="checkbox" class="attach-checkbox"
                  value="${p.id}"
                  ${state.context.pdfIds.includes(p.id) ? 'checked' : ''}
                />
                <span class="attach-item-name">${escHtml(truncate(p.original_name || p.filename || 'Untitled', 36))}</span>
              </label>
            `).join('');

        pdfsList.querySelectorAll('.attach-checkbox').forEach(cb => {
          cb.addEventListener('change', () => toggleContextItem('pdf', cb));
        });
      } catch {
        pdfsList.innerHTML = '<p class="attach-empty">Failed to load PDFs</p>';
      }
    }
  };

  const toggleContextItem = (type, checkbox) => {
    const id = checkbox.value; // IDs are UUIDs — never parseInt them
    if (type === 'note') {
      if (checkbox.checked) {
        if (!state.context.noteIds.includes(id)) state.context.noteIds.push(id);
      } else {
        state.context.noteIds = state.context.noteIds.filter(x => x !== id);
      }
    } else {
      if (checkbox.checked) {
        if (!state.context.pdfIds.includes(id)) state.context.pdfIds.push(id);
      } else {
        state.context.pdfIds = state.context.pdfIds.filter(x => x !== id);
      }
    }
    updateContextBadge();
  };

  const attachPDF = (pdf) => {
    if (!state.context.pdfIds.includes(pdf.id)) {
      state.context.pdfIds.push(pdf.id);
      state.context.pdfs.push(pdf);
    }
    updateContextBadge();
    // Switch to chat view
    window.dispatchEvent(new CustomEvent('nav:switch', { detail: { view: 'chat' } }));
  };

  const clearContext = () => {
    state.context = { noteIds: [], pdfIds: [], notes: [], pdfs: [] };
    updateContextBadge();
  };

  const updateContextBadge = () => {
    const badge = el('chat-context-badge');
    const label = el('chat-context-label');
    const total = state.context.noteIds.length + state.context.pdfIds.length;

    if (total === 0) {
      hide(badge);
      return;
    }

    show(badge);
    const parts = [];
    if (state.context.noteIds.length) parts.push(`${state.context.noteIds.length} note${state.context.noteIds.length !== 1 ? 's' : ''}`);
    if (state.context.pdfIds.length)  parts.push(`${state.context.pdfIds.length} PDF${state.context.pdfIds.length !== 1 ? 's' : ''}`);
    if (label) label.textContent = '📎 ' + parts.join(', ');
  };

  // ─────────────────────────────────────────────────────────────
  // View helpers
  // ─────────────────────────────────────────────────────────────

  const showWelcomeView = () => {
    show(el('chat-welcome'));
    hide(el('chat-messages'));
  };

  const showMessagesView = () => {
    hide(el('chat-welcome'));
    show(el('chat-messages'));
  };

  // ─────────────────────────────────────────────────────────────
  // Init
  // ─────────────────────────────────────────────────────────────

  const init = () => {
    // New chat button
    el('new-chat-btn')?.addEventListener('click', () => {
      state.activeSession = null;
      state.messages = [];
      Storage.setActiveChatSession(null);
      renderSessionList();
      showWelcomeView();
    });

    // Send button & Enter key
    const sendBtn = el('chat-send-btn');
    const input   = el('chat-input');

    sendBtn?.addEventListener('click', sendMessage);

    if (input) {
      input.addEventListener('input', () => {
        autoResize(input, 160);
        if (sendBtn) sendBtn.disabled = !input.value.trim() || state.isStreaming;
      });

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          if (input.value.trim() && !state.isStreaming) sendMessage();
        }
      });
    }

    // Attach menu
    el('chat-attach-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      openAttachMenu();
    });

    // Clear context
    el('clear-context-btn')?.addEventListener('click', clearContext);

    // Welcome screen suggestion chips
    document.querySelectorAll('.suggestion-chip[data-prompt]').forEach(btn => {
      btn.addEventListener('click', () => {
        const prompt = btn.dataset.prompt;
        if (input && prompt) {
          input.value = prompt;
          input.dispatchEvent(new Event('input'));
          input.focus();
        }
      });
    });

    // Listen for PDF "Ask AI" from viewer
    window.addEventListener('chat:attach-pdf', (e) => {
      attachPDF(e.detail.pdf);
    });

    loadSessions();
  };

  return {
    init,
    loadSessions,
    createSession,
    attachPDF,
    clearContext,
  };
})();
