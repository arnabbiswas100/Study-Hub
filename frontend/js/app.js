/* ═══════════════════════════════════════════════════════════════
   STUDY-HUB — App Entry Point
   SPA router · theme toggle · sidebar · global search · init
   ═══════════════════════════════════════════════════════════════ */

const App = (() => {
  const { toast, show, hide, debounce } = Helpers;

  // ── State ─────────────────────────────────────────────────────
  let state = {
    activeView:    'notes',   // 'notes' | 'pdfs' | 'chat'
    sidebarOpen:   true,
    searchVisible: false,
    initialized:   false,
  };

  const el = (id) => document.getElementById(id);

  // ─────────────────────────────────────────────────────────────
  // Theme
  // ─────────────────────────────────────────────────────────────

  // ── Theme state ─────────────────────────────────────────────
  // style: 'minimal' | 'glass'
  // mode:  'dark'    | 'light'
  // Combined data-theme = style + '-' + mode
  //   e.g. 'minimal-dark', 'glass-light'

  const getThemeAttr = (style, mode) => style + '-' + mode;

  const applyTheme = (style, mode) => {
    const attr = getThemeAttr(style, mode);
    document.documentElement.dataset.theme = attr;

    // Update mode toggle icon
    const modeBtn  = el('theme-mode-btn');
    if (modeBtn) modeBtn.dataset.mode = mode;

    // Update style pill active state
    document.querySelectorAll('.pill-option').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.style === style);
    });

    Storage.set('themeStyle', style);
    Storage.set('themeMode',  mode);
  };

  const toggleMode = () => {
    const style = Storage.get('themeStyle', 'minimal');
    const mode  = Storage.get('themeMode',  'dark');
    applyTheme(style, mode === 'dark' ? 'light' : 'dark');
  };

  const setStyle = (style) => {
    const mode = Storage.get('themeMode', 'dark');
    applyTheme(style, mode);
  };

  const initTheme = () => {
    // Support legacy single-value saves ('dark'/'light'/'glass')
    const legacyTheme = Storage.getTheme();
    let style = Storage.get('themeStyle', null);
    let mode  = Storage.get('themeMode',  null);

    if (!style || !mode) {
      // Migrate from legacy
      if (legacyTheme === 'glass') { style = 'glass';   mode = 'dark'; }
      else if (legacyTheme === 'light') { style = 'minimal'; mode = 'light'; }
      else { style = 'minimal'; mode = 'dark'; }
    }

    applyTheme(style, mode);

    // Mode toggle (moon/sun icon)
    el('theme-mode-btn')?.addEventListener('click', toggleMode);

    // Style pill (Minimal | Glass)
    document.querySelectorAll('.pill-option').forEach(btn => {
      btn.addEventListener('click', () => setStyle(btn.dataset.style));
    });
  };

  // keep toggleTheme in public API for any external callers
  const toggleTheme = toggleMode;

  // ─────────────────────────────────────────────────────────────
  // Sidebar
  // ─────────────────────────────────────────────────────────────

  const setSidebarOpen = (open) => {
    state.sidebarOpen = open;
    const sidebar = el('sidebar');
    const appEl   = el('app');
    if (sidebar) sidebar.classList.toggle('collapsed', !open);
    if (appEl)   appEl.classList.toggle('sidebar-collapsed',   !open);
  };

  const toggleSidebar = () => setSidebarOpen(!state.sidebarOpen);

  const initSidebar = () => {
    el('sidebar-toggle')?.addEventListener('click', toggleSidebar);

    // Collapse sidebar on mobile by default
    if (window.innerWidth < 768) setSidebarOpen(false);

    // Close sidebar when clicking overlay on mobile
    document.addEventListener('click', (e) => {
      if (window.innerWidth < 768 && state.sidebarOpen) {
        const sidebar = el('sidebar');
        const toggle  = el('sidebar-toggle');
        if (sidebar && !sidebar.contains(e.target) && !toggle?.contains(e.target)) {
          setSidebarOpen(false);
        }
      }
    });
  };

  // ─────────────────────────────────────────────────────────────
  // View switching (SPA router)
  // ─────────────────────────────────────────────────────────────

  const VIEWS = ['notes', 'pdfs', 'chat'];

  const switchView = (view) => {
    if (!VIEWS.includes(view)) return;
    state.activeView = view;
    Storage.setActiveView(view);

    // Toggle view sections
    VIEWS.forEach(v => {
      const section = el(`${v}-view`);
      if (section) section.classList.toggle('hidden', v !== view);
    });

    // Update nav items
    document.querySelectorAll('[data-view]').forEach(item => {
      item.classList.toggle('active', item.dataset.view === view);
    });

    // Toggle sidebar sections
    el('notes-folders-section')?.classList.toggle('hidden', view !== 'notes');
    el('pdf-folders-section')?.classList.toggle('hidden',   view !== 'pdfs');
    el('chat-sessions-section')?.classList.toggle('hidden', view !== 'chat');

    // Close sidebar on mobile after switching
    if (window.innerWidth < 768) setSidebarOpen(false);

    // Focus search if open
    if (state.searchVisible && view !== 'chat') {
      setTimeout(() => el(`${view}-search`)?.focus(), 50);
    }
  };

  const initRouter = () => {
    // Nav click
    document.querySelectorAll('[data-view]').forEach(item => {
      item.addEventListener('click', () => switchView(item.dataset.view));
    });

    // Custom event from other modules (e.g. Chat after PDF attach)
    window.addEventListener('nav:switch', (e) => {
      if (e.detail?.view) switchView(e.detail.view);
    });

    // Restore last view
    const saved = Storage.getActiveView();
    switchView(saved && VIEWS.includes(saved) ? saved : 'notes');
  };

  // ─────────────────────────────────────────────────────────────
  // Global Search  (⌘K / Ctrl+K)
  // ─────────────────────────────────────────────────────────────

  const initGlobalSearch = () => {
    const wrap  = el('global-search-wrap');
    const input = el('global-search');
    if (!input) return;

    const toggleSearch = () => {
      state.searchVisible = !state.searchVisible;
      wrap?.classList.toggle('active', state.searchVisible);
      if (state.searchVisible) {
        input.focus();
        input.select();
      } else {
        input.blur();
        input.value = '';
      }
    };

    // ⌘K / Ctrl+K to open
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        toggleSearch();
      }
      if (e.key === 'Escape' && state.searchVisible) {
        toggleSearch();
      }
    });

    // Dispatch search to active module
    const doSearch = debounce(() => {
      const query = input.value.trim();
      const view  = state.activeView;

      if (view === 'notes') {
        const notesInput = el('notes-search');
        if (notesInput) {
          notesInput.value = query;
          notesInput.dispatchEvent(new Event('input'));
        }
      } else if (view === 'pdfs') {
        const pdfsInput = el('pdfs-search');
        if (pdfsInput) {
          pdfsInput.value = query;
          pdfsInput.dispatchEvent(new Event('input'));
        }
      }
    }, 300);

    input.addEventListener('input', doSearch);

    // Enter confirms and closes
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') toggleSearch();
    });
  };

  // ─────────────────────────────────────────────────────────────
  // Responsive handling
  // ─────────────────────────────────────────────────────────────

  const initResponsive = () => {
    const mq = window.matchMedia('(max-width: 767px)');

    // Only collapse/expand when crossing the breakpoint, not on initial load
    mq.addEventListener('change', (e) => {
      if (e.matches) {
        setSidebarOpen(false);
      } else {
        setSidebarOpen(true);
      }
    });
  };

  // ─────────────────────────────────────────────────────────────
  // Keyboard shortcuts
  // ─────────────────────────────────────────────────────────────

  const initKeyboardShortcuts = () => {
    document.addEventListener('keydown', (e) => {
      // Skip if typing in an input/textarea
      const active = document.activeElement;
      const isTyping = active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName);

      if (!isTyping) {
        // 1/2/3 to switch views
        if (e.key === '1') switchView('notes');
        if (e.key === '2') switchView('pdfs');
        if (e.key === '3') switchView('chat');
        // B to toggle sidebar
        if (e.key === 'b' || e.key === 'B') toggleSidebar();
      }
    });
  };

  // ─────────────────────────────────────────────────────────────
  // Post-login init (runs once user is authenticated)
  // ─────────────────────────────────────────────────────────────

  const onLogin = async () => {
    if (state.initialized) return;
    state.initialized = true;

    try {
      // Init all modules in parallel where safe
      await Promise.all([
        Notes.init?.(),
        PDFs.init?.(),
        Chat.init?.(),
      ].filter(Boolean));

      // Load initial data for Notes (folders + notes)
      await Notes.load?.();
    } catch (err) {
      console.error('Module init error:', err);
    }

    initRouter();
    initSidebar();
    initGlobalSearch();
    initKeyboardShortcuts();
    initResponsive();
  };

  const onLogout = () => {
    state.initialized = false;
    state.activeView  = 'notes';
  };

  // ─────────────────────────────────────────────────────────────
  // Boot sequence
  // ─────────────────────────────────────────────────────────────

  const init = async () => {
    initTheme();

    // Wire auth events
    window.addEventListener('auth:login',  () => onLogin());
    window.addEventListener('auth:logout', () => onLogout());

    // Init auth module (handles session check)
    Auth.init();

    // Try to restore existing session
    const loggedIn = await Auth.checkSession();
    if (loggedIn) onLogin();
  };

  return { init, switchView, toggleSidebar, toggleTheme, setStyle };
})();

/* ── Bootstrap ─────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => App.init());
