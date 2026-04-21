/* ═══════════════════════════════════════════════════════════════
   STUDY-HUB — Helpers Utility
   ═══════════════════════════════════════════════════════════════ */

const Helpers = (() => {

  // ── Markdown Renderer ───────────────────────────────────────
  // Lightweight inline renderer (no external deps)
  const renderMarkdown = (text) => {
    if (!text) return '';

    // Protect code blocks from other processing
    const codeBlocks = [];
    const inlineCodes = [];

    // Extract fenced code blocks first
    let html = text.replace(/```(\w*)\n?([\s\S]*?)```/gm, (_, lang, code) => {
      const idx = codeBlocks.length;
      const escaped = code.trim()
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      codeBlocks.push(`<pre><code class="lang-${lang}">${escaped}</code></pre>`);
      return `\x00CODE${idx}\x00`;
    });

    // Extract inline code
    html = html.replace(/`([^`]+)`/g, (_, code) => {
      const idx = inlineCodes.length;
      const escaped = code
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      inlineCodes.push(`<code>${escaped}</code>`);
      return `\x00INLINE${idx}\x00`;
    });

    // Escape remaining HTML
    html = html
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // Headers — space after # is optional (handles ###Heading and ### Heading)
    html = html.replace(/^######\s*(.+)$/gm, '<h6>$1</h6>');
    html = html.replace(/^#####\s*(.+)$/gm,  '<h5>$1</h5>');
    html = html.replace(/^####\s*(.+)$/gm,   '<h4>$1</h4>');
    html = html.replace(/^###\s*(.+)$/gm,    '<h3>$1</h3>');
    html = html.replace(/^##\s*(.+)$/gm,     '<h2>$1</h2>');
    html = html.replace(/^#\s*(.+)$/gm,      '<h1>$1</h1>');

    // Blockquote (works on already-escaped &gt;)
    html = html.replace(/^&gt;\s*(.+)$/gm, '<blockquote>$1</blockquote>');

    // Horizontal rule
    html = html.replace(/^---+$/gm, '<hr>');
    html = html.replace(/^\*\*\*+$/gm, '<hr>');

    // Unordered list
    html = html.replace(/^([ \t]*[-*+][ \t].+(\n|$))+/gm, (block) => {
      const items = block.trim().split('\n').map(line =>
        `<li>${line.replace(/^[ \t]*[-*+][ \t]/, '').trim()}</li>`
      ).join('');
      return `<ul>${items}</ul>`;
    });

    // Ordered list
    html = html.replace(/^([ \t]*\d+\.[ \t].+(\n|$))+/gm, (block) => {
      const items = block.trim().split('\n').map(line =>
        `<li>${line.replace(/^[ \t]*\d+\.[ \t]/, '').trim()}</li>`
      ).join('');
      return `<ol>${items}</ol>`;
    });

    // Bold+italic (use 's' flag for multiline matches)
    html = html.replace(/\*\*\*(.+?)\*\*\*/gs, '<strong><em>$1</em></strong>');
    // Bold
    html = html.replace(/\*\*(.+?)\*\*/gs, '<strong>$1</strong>');
    html = html.replace(/__(.+?)__/gs,         '<strong>$1</strong>');
    // Italic (don't cross newlines)
    html = html.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    html = html.replace(/_([^_\n]+)_/g,    '<em>$1</em>');

    // Strikethrough
    html = html.replace(/~~(.+?)~~/gs, '<del>$1</del>');

    // Links
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

    // Split on double newlines → paragraphs
    const PARA = '\x00PARA\x00';
    html = html.replace(/\n\n+/g, PARA);
    const parts = html.split(PARA);
    html = parts.map(part => {
      part = part.trim();
      if (!part) return '';
      // If already a block-level element, don't wrap in <p>
      if (/^<(h[1-6]|ul|ol|pre|blockquote|hr|div)/.test(part)) return part;
      // Single newlines become <br>
      part = part.replace(/\n/g, '<br>');
      return `<p>${part}</p>`;
    }).filter(Boolean).join('\n');

    // Remove empty paragraphs
    html = html.replace(/<p>\s*<\/p>/g, '');

    // Restore code blocks and inline code
    html = html.replace(/\x00CODE(\d+)\x00/g, (_, i) => codeBlocks[i]);
    html = html.replace(/\x00INLINE(\d+)\x00/g, (_, i) => inlineCodes[i]);

    return `<div class="md-content">${html}</div>`;
  };

  // ── Date Formatting ──────────────────────────────────────────
  const formatDate = (dateStr) => {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    const now  = new Date();

    const diffMs   = now - date;
    const diffSecs = Math.floor(diffMs / 1000);
    const diffMins = Math.floor(diffSecs / 60);
    const diffHrs  = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHrs / 24);

    if (diffSecs < 60)   return 'just now';
    if (diffMins < 60)   return `${diffMins}m ago`;
    if (diffHrs  < 24)   return `${diffHrs}h ago`;
    if (diffDays === 1)  return 'yesterday';
    if (diffDays < 7)    return `${diffDays}d ago`;

    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  const formatDateLong = (dateStr) => {
    if (!dateStr) return '';
    return new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  };

  const formatFileSize = (bytes) => {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  };

  // ── Toast ────────────────────────────────────────────────────
  const toast = (() => {
    const container = () => document.getElementById('toast-container');

    const show = (message, type = 'info', duration = 3500) => {
      const icons = { success: '✓', error: '✕', info: 'ℹ' };
      const el = document.createElement('div');
      el.className = `toast toast-${type}`;
      el.innerHTML = `
        <span class="toast-icon">${icons[type] || icons.info}</span>
        <span class="toast-msg">${message}</span>
      `;

      container()?.appendChild(el);

      const remove = () => {
        el.classList.add('removing');
        el.addEventListener('animationend', () => el.remove(), { once: true });
        setTimeout(() => el.remove(), 500); // fallback
      };

      setTimeout(remove, duration);
      el.addEventListener('click', remove);
    };

    return {
      success: (msg, dur) => show(msg, 'success', dur),
      error:   (msg, dur) => show(msg, 'error',   dur || 5000),
      info:    (msg, dur) => show(msg, 'info',     dur),
    };
  })();

  // ── Debounce ─────────────────────────────────────────────────
  const debounce = (fn, delay = 300) => {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  };

  // ── Throttle ─────────────────────────────────────────────────
  const throttle = (fn, limit = 300) => {
    let inThrottle;
    return (...args) => {
      if (!inThrottle) {
        fn(...args);
        inThrottle = true;
        setTimeout(() => (inThrottle = false), limit);
      }
    };
  };

  // ── DOM Helpers ──────────────────────────────────────────────
  const qs  = (sel, ctx = document)  => ctx.querySelector(sel);
  const qsa = (sel, ctx = document)  => [...ctx.querySelectorAll(sel)];

  const show = (el) => { if (el) el.classList.remove('hidden'); };
  const hide = (el) => { if (el) el.classList.add('hidden'); };

  const setLoading = (btn, loading) => {
    if (!btn) return;
    const text   = btn.querySelector('.btn-text');
    const loader = btn.querySelector('.btn-loader');
    btn.disabled = loading;
    if (text)   text.classList.toggle('hidden', loading);
    if (loader) loader.classList.toggle('hidden', !loading);
  };

  // ── User initials ────────────────────────────────────────────
  const getInitials = (name = '', email = '') => {
    if (name && name.trim()) {
      const parts = name.trim().split(' ');
      if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
      return parts[0].slice(0, 2).toUpperCase();
    }
    if (email) return email[0].toUpperCase();
    return '?';
  };

  // ── Escape HTML ──────────────────────────────────────────────
  const escHtml = (str) => {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  };

  // ── Auto-resize textarea ─────────────────────────────────────
  const autoResize = (el, maxHeight = 200) => {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, maxHeight) + 'px';
  };

  // ── Truncate text ────────────────────────────────────────────
  const truncate = (str, len = 120) => {
    if (!str) return '';
    return str.length > len ? str.slice(0, len) + '…' : str;
  };

  return {
    renderMarkdown,
    formatDate,
    formatDateLong,
    formatFileSize,
    toast,
    debounce,
    throttle,
    qs, qsa, show, hide,
    setLoading,
    getInitials,
    escHtml,
    autoResize,
    truncate,
  };
})();
