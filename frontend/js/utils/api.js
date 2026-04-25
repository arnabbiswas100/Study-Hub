/* ═══════════════════════════════════════════════════════════════
   STUDY-HUB — API Utility (fetch wrapper with JWT auth)
   ═══════════════════════════════════════════════════════════════ */

const API = (() => {
  const BASE = '/api';

  // ── Core request ────────────────────────────────────────────
  const request = async (method, path, body = null, options = {}) => {
    const token = Storage.getToken();

    const headers = {
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    };

    const config = {
      method,
      headers,
      ...(body && method !== 'GET' ? { body: JSON.stringify(body) } : {}),
    };

    try {
      const res = await fetch(BASE + path, config);

      // Handle 401 — token expired/invalid
      if (res.status === 401) {
        Storage.removeToken();
        Storage.removeUser();
        // Trigger re-auth (app.js listens)
        window.dispatchEvent(new CustomEvent('auth:expired'));
        throw new Error('Session expired. Please sign in again.');
      }

      const data = await res.json();

      if (!res.ok) {
        const msg = data.error || data.message || `Request failed (${res.status})`;
        throw new Error(msg);
      }

      return data;
    } catch (err) {
      if (err.name === 'TypeError' && err.message.includes('fetch')) {
        throw new Error('Network error. Please check your connection.');
      }
      throw err;
    }
  };

  // ── Upload (multipart) ───────────────────────────────────────
  const upload = async (path, formData, onProgress) => {
    const token = Storage.getToken();

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();

      xhr.open('POST', BASE + path);
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);

      // 120-second timeout for large file uploads
      xhr.timeout = 120000;

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      };

      xhr.onload = () => {
        try {
          const data = JSON.parse(xhr.responseText);
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(data);
          } else {
            reject(new Error(data.error || 'Upload failed'));
          }
        } catch {
          reject(new Error('Invalid response'));
        }
      };

      xhr.onerror = () => reject(new Error('Network error during upload'));
      xhr.ontimeout = () => reject(new Error('Upload timed out. The file may be too large or the connection is slow. Please try again.'));
      xhr.send(formData);
    });
  };

  // ── Shorthand methods ────────────────────────────────────────
  const get    = (path, opts) => request('GET',    path, null, opts);
  const post   = (path, body) => request('POST',   path, body);
  const put    = (path, body) => request('PUT',    path, body);
  const patch  = (path, body) => request('PATCH',  path, body);
  const del    = (path)       => request('DELETE', path);

  // ── Auth ─────────────────────────────────────────────────────
  const auth = {
    login:    (body) => post('/auth/login',    body),
    register: (body) => post('/auth/register', body),
    profile:  ()     => get('/auth/profile'),
    update:   (body) => put('/auth/profile',   body),
  };

  // ── Notes ────────────────────────────────────────────────────
  const notes = {
    getFolders:    ()            => get('/notes/folders'),
    createFolder:  (body)        => post('/notes/folders', body),
    updateFolder:  (id, body)    => put(`/notes/folders/${id}`, body),
    deleteFolder:  (id)          => del(`/notes/folders/${id}`),

    getAll:        (params = {}) => {
      const q = new URLSearchParams(params).toString();
      return get('/notes' + (q ? '?' + q : ''));
    },
    getOne:        (id)          => get(`/notes/${id}`),
    create:        (body)        => post('/notes', body),
    update:        (id, body)    => put(`/notes/${id}`, body),
    delete:        (id)          => del(`/notes/${id}`),
  };

  // ── PDFs ─────────────────────────────────────────────────────
  const pdfs = {
    getFolders:   ()          => get('/pdfs/folders'),
    createFolder: (body)      => post('/pdfs/folders', body),
    updateFolder: (id, body)  => put(`/pdfs/folders/${id}`, body),
    deleteFolder: (id)        => del(`/pdfs/folders/${id}`),

    getAll:       (params={}) => {
      const q = new URLSearchParams(params).toString();
      return get('/pdfs' + (q ? '?' + q : ''));
    },
    getOne:       (id)        => get(`/pdfs/${id}`),
    uploadFile:   (formData, onProgress) => upload('/pdfs/upload', formData, onProgress),
    streamUrl:    (id)        => `/api/pdfs/${id}/stream?token=${Storage.getToken()}`,
    downloadUrl:  (id)        => `/api/pdfs/${id}/download?token=${Storage.getToken()}`,
    update:       (id, body)  => put(`/pdfs/${id}`, body),
    delete:       (id)        => del(`/pdfs/${id}`),
  };

  // ── Chat ─────────────────────────────────────────────────────
  const chat = {
    getSessions:    ()           => get('/chat/sessions'),
    createSession:  (body)       => post('/chat/sessions', body),
    updateSession:  (id, body)   => put(`/chat/sessions/${id}`, body),
    deleteSession:  (id)         => del(`/chat/sessions/${id}`),
    getMessages:    (id)         => get(`/chat/sessions/${id}/messages`),
    sendMessage:    (id, body)   => post(`/chat/sessions/${id}/messages`, body),
  };

  return { get, post, put, patch, del, upload, auth, notes, pdfs, chat };
})();
