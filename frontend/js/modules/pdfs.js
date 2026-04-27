/* ═══════════════════════════════════════════════════════════════
   STUDY-HUB — PDFs Module
   Drag+drop upload, grid view, viewer, folders, delete, search
   ═══════════════════════════════════════════════════════════════ */

window.PDFs = (() => {
  const { toast, show, hide, debounce, formatDate, formatFileSize,
          escHtml, truncate, setLoading } = Helpers;

  // ── State ─────────────────────────────────────────────────────
  let state = {
    pdfs:          [],
    folders:       [],
    activeFolder:  'all',
    searchQuery:   '',
    dragCounter:   0,
    isUploading:   false,
    newFolderParentId: null,
    folderColor:   '',
  };

  let dragSourceId = null;

  const el = (id) => document.getElementById(id);

  const FOLDER_COLORS = [
    { name: 'none',   hex: '' },
    { name: 'red',    hex: '#ff5858' },
    { name: 'orange', hex: '#ff9644' },
    { name: 'yellow', hex: '#ffd60a' },
    { name: 'green',  hex: '#4cde80' },
    { name: 'teal',   hex: '#24c6c8' },
    { name: 'blue',   hex: '#4895ef' },
    { name: 'purple', hex: '#9b5de5' },
    { name: 'pink',   hex: '#f15bb5' },
    { name: 'gray',   hex: '#8a8480' },
  ];

  // ── Nested folder helpers ──────────────────────────────────────
  const COLLAPSED_KEY = 'pdf_collapsed_folders';
  const getCollapsed = () => new Set(JSON.parse(sessionStorage.getItem(COLLAPSED_KEY) || '[]'));
  const setCollapsed = (s) => sessionStorage.setItem(COLLAPSED_KEY, JSON.stringify([...s]));
  const toggleCollapsed = (id) => { const s = getCollapsed(); s.has(id) ? s.delete(id) : s.add(id); setCollapsed(s); };

  const buildFolderTree = (folders) => {
    const map = {};
    folders.forEach(f => { map[f.id] = { ...f, children: [] }; });
    const roots = [];
    folders.forEach(f => {
      if (f.parent_id && map[f.parent_id]) map[f.parent_id].children.push(map[f.id]);
      else roots.push(map[f.id]);
    });
    return roots;
  };

  const getAncestors = (id, folders) => {
    const map = {};
    folders.forEach(f => { map[f.id] = f; });
    const chain = [];
    let cur = map[id];
    while (cur) { chain.unshift(cur); cur = cur.parent_id ? map[cur.parent_id] : null; }
    return chain;
  };

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
    card.style.animationDelay = `${index * 55}ms`;

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
        } catch (err) { toast.error('Failed to move PDF: ' + err.message); }
      });
    });
    document.addEventListener('mousedown', function outsideClose(e) {
      if (!card.contains(e.target)) card.querySelector('.pdf-move-dropdown')?.classList.add('hidden');
    });
    card.addEventListener('click', () => openViewer(pdf));
    return card;
  };

  // ── PDF folder context menu (⋯ button) ───────────────────────
  let activePdfContextMenu = null;

  const openPdfFolderContextMenu = (e, folder, depth = 0) => {
    if (activePdfContextMenu) activePdfContextMenu.remove();

    const menu = document.createElement('div');
    menu.className = 'folder-context-menu';
    const subDisabled = depth >= 2 ? ' style="opacity:0.4;pointer-events:none"' : '';
    menu.innerHTML = `
      <button class="folder-ctx-item" data-action="subfolder"${subDisabled}>📁 New Subfolder</button>
      <button class="folder-ctx-item" data-action="edit">✏️ Edit folder</button>
      <button class="folder-ctx-item danger" data-action="delete">🗑 Delete folder</button>
    `;
    document.body.appendChild(menu);
    activePdfContextMenu = menu;

    const rect = e.currentTarget.getBoundingClientRect();
    const menuW = 170;
    let left = rect.left - menuW + rect.width;
    let top  = rect.bottom + 4;
    if (left < 4) left = 4;
    if (top + 120 > window.innerHeight) top = rect.top - 124;
    menu.style.left = left + 'px';
    menu.style.top  = top  + 'px';

    menu.querySelector('[data-action="subfolder"]')?.addEventListener('click', () => {
      menu.remove(); activePdfContextMenu = null;
      if (depth < 2) openFolderModal('create', null, folder.id);
    });
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

    const collapsed = getCollapsed();
    const tree = buildFolderTree(state.folders);

    const renderNode = (node, depth, target) => {
      const isActive    = state.activeFolder === String(node.id);
      const hasKids     = node.children.length > 0;
      const isCollapsed = collapsed.has(String(node.id));
      const dotStyle    = node.color ? `background:${escHtml(node.color)};` : 'background:var(--text-3);';

      const wrap = document.createElement('div');
      wrap.className = 'folder-item-wrap';
      wrap.style.setProperty('--folder-depth', depth);
      wrap.dataset.depth = depth;
      wrap.dataset.id = node.id;
      wrap.draggable = true;

      const btn = document.createElement('button');
      btn.className = `folder-item${isActive ? ' active' : ''}`;
      btn.dataset.id = node.id;
      btn.innerHTML = `
        <span class="folder-expand-btn${hasKids ? (isCollapsed ? '' : ' open') : ' invisible'}" data-eid="${escHtml(String(node.id))}">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M3 2l4 3-4 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </span>
        <span class="folder-color-dot" style="${dotStyle}"></span>
        <span class="folder-icon">${escHtml(node.icon || '📁')}</span>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;">${escHtml(node.name)}</span>
      `;
      btn.addEventListener('click', (e) => {
        if (e.target.closest('.folder-expand-btn')) {
          e.stopPropagation(); toggleCollapsed(String(node.id)); renderFolderSidebar(); return;
        }
        setActiveFolder(String(node.id));
      });

      const menuBtn = document.createElement('button');
      menuBtn.className = 'folder-menu-btn';
      menuBtn.title = 'Folder options';
      menuBtn.innerHTML = '⋯';
      menuBtn.addEventListener('click', (e) => { e.stopPropagation(); openPdfFolderContextMenu(e, node, depth); });

      wrap.appendChild(btn); wrap.appendChild(menuBtn);

      wrap.addEventListener('dragstart', (e) => { dragSourceId = String(node.id); e.dataTransfer.effectAllowed = 'move'; setTimeout(() => wrap.classList.add('dragging'), 0); });
      wrap.addEventListener('dragend',   () => { dragSourceId = null; wrap.classList.remove('dragging'); document.querySelectorAll('.folder-item-wrap.drag-over').forEach(w => w.classList.remove('drag-over')); });
      wrap.addEventListener('dragover',  (e) => { if (!dragSourceId || dragSourceId === String(node.id)) return; e.preventDefault(); wrap.classList.add('drag-over'); });
      wrap.addEventListener('dragleave', () => wrap.classList.remove('drag-over'));
      wrap.addEventListener('drop',      (e) => { e.preventDefault(); wrap.classList.remove('drag-over'); dragSourceId = null; });

      target.appendChild(wrap);

      if (hasKids) {
        const childBox = document.createElement('div');
        childBox.className = 'folder-tree-children' + (isCollapsed ? ' collapsed' : '');
        node.children.forEach(child => renderNode(child, depth + 1, childBox));
        target.appendChild(childBox);
      }
    };

    tree.forEach(node => renderNode(node, 0, list));

    // Keep static All/Uncategorized active state
    el('pdf-folder-list')?.querySelectorAll('[data-folder]').forEach(b => {
      b.classList.toggle('active', b.dataset.folder === state.activeFolder);
    });
  };

  const renderFolderSelect = () => {
    const sel = el('pdf-folder-select');
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = '<option value="">No Folder</option>';
    const tree = buildFolderTree(state.folders);
    const flatten = (nodes, depth) => {
      nodes.forEach(f => {
        const opt = document.createElement('option');
        opt.value = f.id;
        opt.textContent = '\u00a0\u00a0'.repeat(depth) + (depth > 0 ? '↳ ' : '') + f.name;
        sel.appendChild(opt);
        if (f.children && f.children.length) flatten(f.children, depth + 1);
      });
    };
    flatten(tree, 0);
    sel.value = current;
  };

  const setActiveFolder = (folderId) => {
    state.activeFolder = folderId;
    renderFolderSidebar();

    el('pdf-folder-list')?.querySelectorAll('[data-folder]').forEach(b => {
      b.classList.toggle('active', b.dataset.folder === folderId);
    });

    const titleEl = el('pdfs-view-title');
    if (titleEl) {
      if (folderId === 'all') titleEl.textContent = 'PDF Library';
      else if (folderId === 'uncategorized') titleEl.textContent = 'Uncategorized';
      else {
        const folder = state.folders.find(f => String(f.id) === String(folderId));
        titleEl.textContent = folder ? folder.name : 'PDF Library';
      }
    }

    renderPdfBreadcrumb();
    loadPDFs();
  };

  // ── PDF Breadcrumb ─────────────────────────────────────────────
  const renderPdfBreadcrumb = () => {
    const bc = el('pdfs-breadcrumb');
    if (!bc) return;
    const id = state.activeFolder;
    if (!id || id === 'all' || id === 'uncategorized') {
      bc.innerHTML = ''; bc.classList.add('hidden'); return;
    }
    const ancestors = getAncestors(id, state.folders);
    if (!ancestors.length) { bc.innerHTML = ''; bc.classList.add('hidden'); return; }
    bc.classList.remove('hidden');
    bc.innerHTML = '';
    const allItem = document.createElement('span');
    allItem.className = 'pdfs-breadcrumb-item';
    allItem.textContent = 'All PDFs';
    allItem.addEventListener('click', () => setActiveFolder('all'));
    bc.appendChild(allItem);
    ancestors.forEach((f, i) => {
      const sep = document.createElement('span'); sep.className = 'pdfs-breadcrumb-sep'; sep.textContent = '›'; bc.appendChild(sep);
      const item = document.createElement('span');
      item.className = 'pdfs-breadcrumb-item' + (i === ancestors.length - 1 ? ' current' : '');
      item.textContent = f.name;
      if (i < ancestors.length - 1) item.addEventListener('click', () => setActiveFolder(String(f.id)));
      bc.appendChild(item);
    });
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

    // Prevent duplicate uploads
    if (state.isUploading) {
      console.warn('Upload already in progress, ignoring duplicate request.');
      return;
    }
    state.isUploading = true;

    const btn = el('upload-pdf-btn');
    setLoading(btn, true);

    // Reset file input immediately to prevent re-triggering
    const fileInput = el('pdf-file-input');
    if (fileInput) fileInput.value = '';

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
      state.isUploading = false;
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
      if (state.isUploading) return; // Prevent duplicate uploads from repeated drops
      const files = [...(e.dataTransfer.files || [])];
      const pdfs  = files.filter(f => f.type === 'application/pdf');
      if (pdfs.length === 0) { toast.error('Drop PDF files only.'); return; }
      // Upload only the first PDF to prevent accidental duplicates
      uploadFile(pdfs[0]);
    });
  };

  // ─────────────────────────────────────────────────────────────
  // Viewer
  // ─────────────────────────────────────────────────────────────

  // ── PDF.js renderer setup (mobile only) ───────────────────────
  if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }

  let _currentPdfDoc = null;

  const isMobile = () =>
    /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
    ('ontouchstart' in window && window.innerWidth < 1024);

  const openViewer = async (pdf) => {
    const overlay     = el('pdf-viewer-overlay');
    const iframe      = el('pdf-iframe');
    const container   = el('pdf-canvas-container');
    const loading     = el('pdf-loading');
    const pageCounter = el('pdf-page-counter');
    const title       = el('pdf-viewer-title');
    const dlBtn       = el('pdf-download-btn');
    const chatBtn     = el('pdf-chat-btn');
    if (!overlay) return;

    title.textContent = pdf.original_name || pdf.filename || 'PDF';
    dlBtn.onclick  = () => downloadPDF(pdf);
    chatBtn.onclick = () => {
      closeViewer();
      window.dispatchEvent(new CustomEvent('chat:attach-pdf', { detail: { pdf } }));
    };

    show(overlay);
    document.body.style.overflow = 'hidden';

    if (!isMobile()) {
      // ── Desktop: native iframe with full PDF controls ─────────
      iframe.classList.remove('hidden');
      container.classList.add('hidden');
      loading.classList.add('hidden');
      pageCounter.classList.add('hidden');
      iframe.src = API.pdfs.streamUrl(pdf.id);
    } else {
      // ── Mobile: PDF.js canvas renderer ────────────────────────
      iframe.classList.add('hidden');
      iframe.src = '';
      container.classList.remove('hidden');
      container.innerHTML = '';
      pageCounter.classList.add('hidden');
      loading.classList.remove('hidden');

      try {
        if (!window.pdfjsLib) throw new Error('PDF.js not loaded');

        const response = await fetch(API.pdfs.streamUrl(pdf.id));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const arrayBuffer = await response.arrayBuffer();

        const loadingTask = window.pdfjsLib.getDocument({ data: arrayBuffer });
        const pdfDoc = await loadingTask.promise;
        _currentPdfDoc = pdfDoc;

        loading.classList.add('hidden');
        pageCounter.textContent = `${pdfDoc.numPages} page${pdfDoc.numPages !== 1 ? 's' : ''}`;
        pageCounter.classList.remove('hidden');

        const containerWidth = container.clientWidth - 32;

        for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
          const page = await pdfDoc.getPage(pageNum);
          const baseViewport = page.getViewport({ scale: 1 });
          const scale = Math.min(containerWidth / baseViewport.width, 2.5);
          const viewport = page.getViewport({ scale });

          const canvas = document.createElement('canvas');
          canvas.width  = viewport.width;
          canvas.height = viewport.height;
          canvas.style.width  = '100%';
          canvas.style.height = 'auto';
          container.appendChild(canvas);

          await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        }
      } catch (err) {
        loading.classList.add('hidden');
        container.innerHTML = `<div style="padding:2rem;text-align:center;color:var(--text-3)">
          <div style="font-size:2rem;margin-bottom:1rem">📄</div>
          <div>Could not render PDF.</div>
          <div style="font-size:12px;margin-top:.5rem;opacity:.6">${err.message}</div>
        </div>`;
      }
    }
  };

  const closeViewer = () => {
    const overlay     = el('pdf-viewer-overlay');
    const iframe      = el('pdf-iframe');
    const container   = el('pdf-canvas-container');
    const loading     = el('pdf-loading');
    const pageCounter = el('pdf-page-counter');
    if (overlay)     hide(overlay);
    if (iframe)      { iframe.src = ''; iframe.classList.add('hidden'); }
    if (container)   { container.innerHTML = ''; container.classList.add('hidden'); }
    if (loading)     loading.classList.add('hidden');
    if (pageCounter) pageCounter.classList.add('hidden');
    if (_currentPdfDoc) { _currentPdfDoc.destroy(); _currentPdfDoc = null; }
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

  // ── Render folder color swatches ──────────────────────────────
  const renderFolderColorSwatches = () => {
    const container = el('folder-color-swatches');
    if (!container) return;
    container.innerHTML = '';

    FOLDER_COLORS.forEach(c => {
      const swatch = document.createElement('div');
      swatch.className = 'color-swatch folder-color-swatch' + (state.folderColor === c.hex ? ' selected' : '');
      swatch.title = c.name;
      swatch.style.background = c.hex || 'var(--bg-3)';
      if (!c.hex) swatch.style.border = '2px solid var(--border-2)';
      swatch.addEventListener('click', () => {
        state.folderColor = c.hex;
        renderFolderColorSwatches();
      });
      container.appendChild(swatch);
    });
  };

  const openFolderModal = (mode = 'create', folder = null, parentId = null) => {
    folderEditTarget = folder;
    state.newFolderParentId = folder ? null : (parentId || null);
    const overlay = el('folder-modal-overlay');
    const title   = el('folder-modal-title');
    const nameIn  = el('folder-name-input');
    const saveBtn = el('save-folder-btn');
    if (!overlay) return;

    overlay.dataset.context = 'pdf';

    if (mode === 'edit' && folder) {
      title.textContent = 'Rename Folder';
      nameIn.value = folder.name || '';
      saveBtn.textContent = 'Save';
    } else {
      title.textContent = parentId ? 'New Subfolder' : 'New PDF Folder';
      nameIn.value = '';
      saveBtn.textContent = 'Create';
    }

    // Reset icon picker
    const iconSel = folder?.icon || '📁';
    document.querySelectorAll('.icon-option').forEach(opt => {
      opt.classList.toggle('selected', opt.dataset.icon === iconSel);
    });

    // Reset color picker
    state.folderColor = folder?.color || '';
    renderFolderColorSwatches();

    show(overlay);
    setTimeout(() => nameIn.focus(), 50);
  };

  let isSavingFolder = false;

  const saveFolder = async () => {
    if (isSavingFolder) return; // prevent duplicate submissions

    const nameIn = el('folder-name-input');
    const name   = nameIn?.value.trim();
    if (!name) { toast.error('Folder name required.'); return; }

    const overlay = el('folder-modal-overlay');
    if (overlay?.dataset.context !== 'pdf') return; // handled by Notes module

    const icon = document.querySelector('#icon-picker .icon-option.selected')?.dataset.icon || '📁';

    isSavingFolder = true;
    const saveBtn = el('save-folder-btn');
    if (saveBtn) saveBtn.disabled = true;

    try {
      if (folderEditTarget) {
        await API.pdfs.updateFolder(folderEditTarget.id, { name, icon, color: state.folderColor || null });
        toast.success('Folder renamed.');
      } else {
        await API.pdfs.createFolder({ name, icon, color: state.folderColor || null, parent_id: state.newFolderParentId || null });
        toast.success('Folder created.');
      }
      closeFolderModal();
      await loadFolders();
    } catch (err) {
      toast.error('Failed to save folder: ' + err.message);
    } finally {
      isSavingFolder = false;
      if (saveBtn) saveBtn.disabled = false;
    }
  };

  const closeFolderModal = () => {
    const overlay = el('folder-modal-overlay');
    if (overlay) { overlay.dataset.context = ''; hide(overlay); }
    folderEditTarget = null;
  };

  const deleteFolderConfirm = async (folder) => {
    if (!confirm(`Delete folder "${folder.name}"?\n\nAll subfolders and PDFs inside will also be deleted.`)) return;
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
