/* ═══════════════════════════════════════════════════════════════
   STUDY-HUB — PDFs Module
   Drag+drop upload, grid view, viewer, folders, delete, search
   ═══════════════════════════════════════════════════════════════ */

const PDFs = (() => {
  const { toast, show, hide, debounce, formatDate, formatFileSize,
          escHtml, truncate, setLoading } = Helpers;

  // ── State ─────────────────────────────────────────────────────
  let state = {
    pdfs:          [],
    folders:       [],
    activeFolder:  'all',
    searchQuery:   '',
    dragCounter:   0,
  };

  const el = (id) => document.getElementById(id);

  // ─────────────────────────────────────────────────────────────
  // Data loading
  // ─────────────────────────────────────────────────────────────

  const loadFolders = async () => {
    try {
      const data = await API.pdfs.getFolders();
      state.folders = data.folders || data.data || data || [];
      renderFolderSidebar();
      renderFolderSelect();
    } catch (err) {
      console.error('Failed to load PDF folders:', err);
    }
  };

  const loadPDFs = async () => {
    try {
      const params = {};
      if (state.searchQuery) params.search = state.searchQuery;
      if (state.activeFolder === 'uncategorized') params.folder = 'uncategorized';
      else if (state.activeFolder !== 'all') params.folder = state.activeFolder;

      const data = await API.pdfs.getAll(params);
      state.pdfs = data.pdfs || data.data || data || [];
      renderGrid();
    } catch (err) {
      toast.error('Failed to load PDFs: ' + err.message);
    }
  };

  // ─────────────────────────────────────────────────────────────
  // Rendering
  // ─────────────────────────────────────────────────────────────

  const renderGrid = () => {
    const grid  = el('pdfs-grid');
    const empty = el('pdfs-empty');
    const count = el('pdfs-count');
    if (!grid) return;

    grid.querySelectorAll('.pdf-card').forEach(c => c.remove());

    if (state.pdfs.length === 0) {
      show(empty);
      if (count) count.textContent = '';
      return;
    }

    hide(empty);
    if (count) count.textContent = `${state.pdfs.length} PDF${state.pdfs.length !== 1 ? 's' : ''}`;

    state.pdfs.forEach((pdf, i) => {
      const card = buildPDFCard(pdf, i);
      grid.appendChild(card);
    });
  };

  const buildPDFCard = (pdf, index) => {
    const card = document.createElement('div');
    card.className = 'pdf-card';
    card.dataset.id = pdf.id;
    card.style.animationDelay = `${index * 40}ms`;

    const thumb = pdf.thumbnail_url
      ? `<img src="${escHtml(pdf.thumbnail_url)}" alt="thumbnail" class="pdf-thumb-img" loading="lazy">`
      : `<div class="pdf-thumb-icon">📄</div>`;

    const folderOptions = state.folders.map(f =>
      `<div class="pdf-move-option" data-folder-id="${f.id}">${escHtml(f.icon || '📁')} ${escHtml(f.name)}</div>`
    ).join('');

    card.innerHTML = `
      <div class="pdf-card-thumb">
        ${thumb}
        <div class="pdf-card-hover-actions">
          <button class="pdf-action-btn view-btn" data-id="${pdf.id}" title="Open">👁</button>
          <button class="pdf-action-btn dl-btn"   data-id="${pdf.id}" title="Download">↓</button>
          <button class="pdf-action-btn move-btn" data-id="${pdf.id}" title="Move to folder">📂</button>
          <button class="pdf-action-btn del-btn"  data-id="${pdf.id}" title="Delete">✕</button>
        </div>
      </div>
      <div class="pdf-card-info">
        <div class="pdf-card-name" title="${escHtml(pdf.original_name || pdf.filename || '')}">
          ${escHtml(truncate(pdf.original_name || pdf.filename || 'Untitled', 32))}
        </div>
        <div class="pdf-card-meta">
          ${pdf.folder_name ? `<span class="pdf-folder-badge" style="color:${pdf.folder_color || '#6c63ff'}">${escHtml(pdf.folder_name)}</span> · ` : ''}
          ${pdf.file_size ? formatFileSize(pdf.file_size) : ''}
          ${pdf.file_size && pdf.created_at ? ' · ' : ''}
          ${pdf.created_at ? formatDate(pdf.created_at) : ''}
        </div>
      </div>
      <div class="pdf-move-dropdown hidden">
        <div class="pdf-move-title">Move to folder</div>
        <div class="pdf-move-option" data-folder-id="">No Folder</div>
        ${folderOptions}
      </div>
    `;

    card.querySelector('.view-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      openViewer(pdf);
    });
    card.querySelector('.dl-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      downloadPDF(pdf);
    });
    card.querySelector('.move-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.pdf-move-dropdown').forEach(d => {
        if (d !== card.querySelector('.pdf-move-dropdown')) d.classList.add('hidden');
      });
      card.querySelector('.pdf-move-dropdown').classList.toggle('hidden');
    });
    card.querySelector('.del-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      confirmDelete(pdf);
    });
    card.querySelectorAll('.pdf-move-option').forEach(opt => {
      opt.addEventListener('click', async (e) => {
        e.stopPropagation();
        const folderId = opt.dataset.folderId || null;
        try {
          await API.pdfs.update(pdf.id, { folder_id: folderId });
          toast.success('PDF moved.');
          card.querySelector('.pdf-move-dropdown').classList.add('hidden');
          await loadPDFs();
        } catch (err) {
          toast.error('Failed to move PDF: ' + err.message);
        }
      });
    });
    // Close dropdown when clicking outside the card
    document.addEventListener('mousedown', function outsideClose(e) {
      if (!card.contains(e.target)) {
        card.querySelector('.pdf-move-dropdown')?.classList.add('hidden');
      }
    });
    card.addEventListener('click', () => openViewer(pdf));

    return card;
  };

  // ── PDF folder context menu (⋯ button) ───────────────────────
  let activePdfContextMenu = null;

  const openPdfFolderContextMenu = (e, folder) => {
    if (activePdfContextMenu) activePdfContextMenu.remove();

    const menu = document.createElement('div');
    menu.className = 'folder-context-menu';
    menu.innerHTML = `
      <button class="folder-ctx-item" data-action="edit">✏️ Edit folder</button>
      <button class="folder-ctx-item danger" data-action="delete">🗑 Delete folder</button>
    `;
    document.body.appendChild(menu);
    activePdfContextMenu = menu;

    const rect = e.currentTarget.getBoundingClientRect();
    const menuW = 160;
    let left = rect.left - menuW + rect.width;
    let top  = rect.bottom + 4;
    if (left < 4) left = 4;
    if (top + 100 > window.innerHeight) top = rect.top - 104;
    menu.style.left = left + 'px';
    menu.style.top  = top  + 'px';

    menu.querySelector('[data-action="edit"]').addEventListener('click', () => {
      menu.remove(); activePdfContextMenu = null;
      openFolderModal('edit', folder);
    });
    menu.querySelector('[data-action="delete"]').addEventListener('click', () => {
      menu.remove(); activePdfContextMenu = null;
      deleteFolderConfirm(folder);
    });

    setTimeout(() => {
      document.addEventListener('click', function handler() {
        menu.remove(); activePdfContextMenu = null;
        document.removeEventListener('click', handler);
      });
    }, 0);
  };

  const renderFolderSidebar = () => {
    const list = el('pdf-folder-items');
    if (!list) return;

    list.innerHTML = '';
    state.folders.forEach(f => {
      const wrap = document.createElement('div');
      wrap.className = 'folder-item-wrap';

      const btn = document.createElement('button');
      btn.className = `folder-item${state.activeFolder === String(f.id) ? ' active' : ''}`;
      btn.dataset.id = f.id;
      btn.innerHTML = `
        <span class="folder-color-dot" style="background:${escHtml(f.color || 'var(--text-3)')};"></span>
        <span class="folder-icon">${escHtml(f.icon || '📁')}</span>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;">${escHtml(f.name)}</span>
      `;
      btn.addEventListener('click', () => setActiveFolder(String(f.id)));

      const menuBtn = document.createElement('button');
      menuBtn.className = 'folder-menu-btn';
      menuBtn.title = 'Folder options';
      menuBtn.innerHTML = '⋯';
      menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openPdfFolderContextMenu(e, f);
      });

      wrap.appendChild(btn);
      wrap.appendChild(menuBtn);
      list.appendChild(wrap);
    });

    // Highlight active
    el('pdf-folder-items')?.querySelectorAll('.folder-item').forEach(i => {
      i.classList.toggle('active', i.dataset.id === state.activeFolder);
    });
  };

  const renderFolderSelect = () => {
    const sel = el('pdf-folder-select');
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = '<option value="">No Folder</option>';
    state.folders.forEach(f => {
      const opt = document.createElement('option');
      opt.value = f.id;
      opt.textContent = f.name;
      sel.appendChild(opt);
    });
    sel.value = current;
  };

  const setActiveFolder = (folderId) => {
    state.activeFolder = folderId;
    renderFolderSidebar();

    // Update "All" item active state
    el('pdf-folder-list')?.querySelectorAll('[data-folder]').forEach(b => {
      b.classList.toggle('active', b.dataset.folder === folderId);
    });

    // Update view title to show current folder name
    const titleEl = el('pdfs-view-title');
    if (titleEl) {
      if (folderId === 'all') {
        titleEl.textContent = 'PDF Library';
      } else if (folderId === 'uncategorized') {
        titleEl.textContent = 'Uncategorized';
      } else {
        const folder = state.folders.find(f => String(f.id) === String(folderId));
        titleEl.textContent = folder ? folder.name : 'PDF Library';
      }
    }

    loadPDFs();
  };

  // ─────────────────────────────────────────────────────────────
  // Upload
  // ─────────────────────────────────────────────────────────────

  const uploadFile = async (file) => {
    if (!file || file.type !== 'application/pdf') {
      toast.error('Please upload a valid PDF file.');
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      toast.error('File too large. Max 50 MB.');
      return;
    }

    const btn = el('upload-pdf-btn');
    setLoading(btn, true);

    // Show upload progress toast
    const toastEl = showUploadProgress(file.name);

    const formData = new FormData();
    formData.append('pdf', file);

    const folderId = state.activeFolder !== 'all' ? state.activeFolder : '';
    if (folderId) formData.append('folder_id', folderId);

    try {
      await API.pdfs.uploadFile(formData, (pct) => {
        updateUploadProgress(toastEl, pct);
      });
      removeUploadProgress(toastEl);
      toast.success(`"${truncate(file.name, 30)}" uploaded!`);
      await loadPDFs();
    } catch (err) {
      removeUploadProgress(toastEl);
      toast.error('Upload failed: ' + err.message);
    } finally {
      setLoading(btn, false);
      // Reset file input
      const input = el('pdf-file-input');
      if (input) input.value = '';
    }
  };

  const showUploadProgress = (name) => {
    const container = el('toast-container');
    if (!container) return null;
    const div = document.createElement('div');
    div.className = 'toast toast-info upload-progress-toast';
    div.innerHTML = `
      <span class="toast-icon">↑</span>
      <div class="upload-toast-body">
        <span class="toast-msg">Uploading ${truncate(name, 25)}…</span>
        <div class="upload-progress-bar"><div class="upload-progress-fill" style="width:0%"></div></div>
      </div>
    `;
    container.appendChild(div);
    return div;
  };

  const updateUploadProgress = (toastEl, pct) => {
    if (!toastEl) return;
    const fill = toastEl.querySelector('.upload-progress-fill');
    if (fill) fill.style.width = pct + '%';
  };

  const removeUploadProgress = (toastEl) => {
    if (!toastEl) return;
    toastEl.classList.add('removing');
    setTimeout(() => toastEl.remove(), 400);
  };

  // ─────────────────────────────────────────────────────────────
  // Drag & Drop
  // ─────────────────────────────────────────────────────────────

  const initDragDrop = () => {
    const zone    = el('drop-zone');
    const pdfsView = el('pdfs-view');
    if (!zone || !pdfsView) return;

    const showZone = () => show(zone);
    const hideZone = () => { zone.classList.remove('drag-over'); hide(zone); };

    pdfsView.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      state.dragCounter++;
      if (state.dragCounter === 1) showZone();
    });

    pdfsView.addEventListener('dragleave', () => {
      state.dragCounter--;
      if (state.dragCounter <= 0) { state.dragCounter = 0; hideZone(); }
    });

    pdfsView.addEventListener('dragover', (e) => {
      e.preventDefault();
      zone.classList.add('drag-over');
    });

    pdfsView.addEventListener('drop', (e) => {
      e.preventDefault();
      state.dragCounter = 0;
      hideZone();
      const files = [...(e.dataTransfer.files || [])];
      const pdfs  = files.filter(f => f.type === 'application/pdf');
      if (pdfs.length === 0) { toast.error('Drop PDF files only.'); return; }
      pdfs.forEach(uploadFile);
    });
  };

  // ─────────────────────────────────────────────────────────────
  // Viewer
  // ─────────────────────────────────────────────────────────────

  const openViewer = (pdf) => {
    const overlay = el('pdf-viewer-overlay');
    const iframe  = el('pdf-iframe');
    const title   = el('pdf-viewer-title');
    const dlBtn   = el('pdf-download-btn');
    const chatBtn = el('pdf-chat-btn');
    if (!overlay || !iframe) return;

    title.textContent = pdf.original_name || pdf.filename || 'PDF';
    iframe.src = API.pdfs.streamUrl(pdf.id);

    dlBtn.onclick = () => downloadPDF(pdf);
    chatBtn.onclick = () => {
      closeViewer();
      window.dispatchEvent(new CustomEvent('chat:attach-pdf', { detail: { pdf } }));
    };

    show(overlay);
    document.body.style.overflow = 'hidden';
  };

  const closeViewer = () => {
    const overlay = el('pdf-viewer-overlay');
    const iframe  = el('pdf-iframe');
    if (overlay) hide(overlay);
    if (iframe)  { iframe.src = ''; }
    document.body.style.overflow = '';
  };

  // ─────────────────────────────────────────────────────────────
  // Download / Delete
  // ─────────────────────────────────────────────────────────────

  const downloadPDF = (pdf) => {
    const a = document.createElement('a');
    a.href = API.pdfs.downloadUrl(pdf.id);
    a.download = pdf.original_name || pdf.filename || 'document.pdf';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const confirmDelete = (pdf) => {
    const name = truncate(pdf.original_name || pdf.filename || 'this PDF', 30);
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
    deletePDF(pdf.id);
  };

  const deletePDF = async (id) => {
    try {
      await API.pdfs.delete(id);
      state.pdfs = state.pdfs.filter(p => p.id !== id);
      renderGrid();
      toast.success('PDF deleted.');
    } catch (err) {
      toast.error('Delete failed: ' + err.message);
    }
  };

  // ─────────────────────────────────────────────────────────────
  // Folder Modal
  // ─────────────────────────────────────────────────────────────

  let folderEditTarget = null;

  const openFolderModal = (mode = 'create', folder = null) => {
    folderEditTarget = folder;
    const overlay = el('folder-modal-overlay');
    const title   = el('folder-modal-title');
    const nameIn  = el('folder-name-input');
    const saveBtn = el('save-folder-btn');
    if (!overlay) return;

    // Mark as PDF folder context
    overlay.dataset.context = 'pdf';

    if (mode === 'edit' && folder) {
      title.textContent = 'Rename Folder';
      nameIn.value = folder.name || '';
      saveBtn.textContent = 'Save';
    } else {
      title.textContent = 'New PDF Folder';
      nameIn.value = '';
      saveBtn.textContent = 'Create';
    }

    show(overlay);
    setTimeout(() => nameIn.focus(), 50);
  };

  const saveFolder = async () => {
    const nameIn = el('folder-name-input');
    const name   = nameIn?.value.trim();
    if (!name) { toast.error('Folder name required.'); return; }

    const overlay = el('folder-modal-overlay');
    if (overlay?.dataset.context !== 'pdf') return; // handled by Notes module

    const icon = document.querySelector('#icon-picker .icon-option.selected')?.dataset.icon || '📁';

    try {
      if (folderEditTarget) {
        await API.pdfs.updateFolder(folderEditTarget.id, { name, icon });
        toast.success('Folder renamed.');
      } else {
        await API.pdfs.createFolder({ name, icon });
        toast.success('Folder created.');
      }
      closeFolderModal();
      await loadFolders();
    } catch (err) {
      toast.error('Failed to save folder: ' + err.message);
    }
  };

  const closeFolderModal = () => {
    const overlay = el('folder-modal-overlay');
    if (overlay) { overlay.dataset.context = ''; hide(overlay); }
    folderEditTarget = null;
  };

  const deleteFolderConfirm = async (folder) => {
    if (!confirm(`Delete folder "${folder.name}"? PDFs inside will become uncategorized.`)) return;
    try {
      await API.pdfs.deleteFolder(folder.id);
      if (state.activeFolder === String(folder.id)) {
        state.activeFolder = 'all';
      }
      await loadFolders();
      await loadPDFs();
      toast.success('Folder deleted.');
    } catch (err) {
      toast.error('Failed to delete folder: ' + err.message);
    }
  };

  // ─────────────────────────────────────────────────────────────
  // Public accessors (for Chat context attach)
  // ─────────────────────────────────────────────────────────────

  const getAllPDFs = () => state.pdfs;

  // ─────────────────────────────────────────────────────────────
  // Init
  // ─────────────────────────────────────────────────────────────

  const init = () => {
    // Upload button
    el('upload-pdf-btn')?.addEventListener('click', () => el('pdf-file-input')?.click());
    el('empty-upload-btn')?.addEventListener('click', () => el('pdf-file-input')?.click());

    el('pdf-file-input')?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (file) uploadFile(file);
    });

    // Search
    const searchInput = el('pdfs-search');
    if (searchInput) {
      const doSearch = debounce(() => {
        state.searchQuery = searchInput.value.trim();
        loadPDFs();
      }, 320);
      searchInput.addEventListener('input', doSearch);
    }

    // Folder button
    el('add-pdf-folder-btn')?.addEventListener('click', () => openFolderModal('create'));

    // All folders filter button
    el('pdf-folder-list')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-folder]');
      if (btn) setActiveFolder(btn.dataset.folder);
    });

    // Viewer close
    el('close-pdf-viewer')?.addEventListener('click', closeViewer);
    el('pdf-viewer-overlay')?.addEventListener('click', (e) => {
      if (e.target === el('pdf-viewer-overlay')) closeViewer();
    });

    // Folder modal - only handle save when context is 'pdf'
    el('save-folder-btn')?.addEventListener('click', () => {
      const overlay = el('folder-modal-overlay');
      if (overlay?.dataset.context === 'pdf') saveFolder();
    });
    el('cancel-folder-btn')?.addEventListener('click', () => {
      const overlay = el('folder-modal-overlay');
      if (overlay?.dataset.context === 'pdf') closeFolderModal();
    });

    // ESC to close viewer
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const viewer = el('pdf-viewer-overlay');
        if (viewer && !viewer.classList.contains('hidden')) closeViewer();
      }
    });

    initDragDrop();
    loadFolders();
    loadPDFs();
  };

  return {
    init,
    loadPDFs,
    loadFolders,
    getAllPDFs,
    openViewer,
    openFolderModal,
  };
})();
