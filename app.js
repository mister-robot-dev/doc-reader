(function () {
  'use strict';

  const API = 'https://api.github.com';
  const LS_KEY = 'docreader.config';
  const FONT_KEY = 'docreader.fontsize';
  const FONT_MIN = 12, FONT_MAX = 28, FONT_STEP = 1, FONT_DEFAULT = 16;
  const THEME_KEY = 'docreader.theme';
  const THEMES = ['light', 'dark', 'auto'];
  const $ = (id) => document.getElementById(id);

  const els = {
    setup: $('setup'), setupForm: $('setupForm'), setupError: $('setupError'),
    reader: $('reader'), docTitle: $('docTitle'),
    list: $('fileList'), content: $('content'), filter: $('filter'),
    sidebar: $('sidebar'), backdrop: $('backdrop'),
    menuBtn: $('menuBtn'), authBtn: $('authBtn'),
    settingsToggle: $('settingsToggle'), settingsPanel: $('settingsPanel'),
    fontDec: $('fontDec'), fontInc: $('fontInc'), fontVal: $('fontVal'),
    themeControls: $('themeControls'), themeColor: $('themeColor'),
    mdLight: $('mdLight'), mdDark: $('mdDark'), hlLight: $('hlLight'), hlDark: $('hlDark'),
  };

  marked.setOptions({ gfm: true, breaks: false });

  let cfg = null;     // { owner, repo, branch, path, token }
  let files = [];     // [{ path, sha, name, group }]

  // ---------- config ----------
  function loadCfg() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (_) { return null; }
  }
  function saveCfg(c) { localStorage.setItem(LS_KEY, JSON.stringify(c)); }

  function show(which) {
    els.setup.classList.toggle('hidden', which !== 'setup');
    els.reader.classList.toggle('hidden', which !== 'reader');
  }

  // ---------- font size ----------
  function loadFontSize() {
    const n = parseInt(localStorage.getItem(FONT_KEY), 10);
    return Number.isFinite(n) ? Math.min(FONT_MAX, Math.max(FONT_MIN, n)) : FONT_DEFAULT;
  }
  function applyFontSize(px) {
    els.content.style.setProperty('--md-font-size', px + 'px');
    localStorage.setItem(FONT_KEY, String(px));
    els.fontDec.disabled = px <= FONT_MIN;
    els.fontInc.disabled = px >= FONT_MAX;
    els.fontVal.textContent = px + 'px';
  }
  function bumpFontSize(delta) {
    const next = Math.min(FONT_MAX, Math.max(FONT_MIN, loadFontSize() + delta));
    applyFontSize(next);
  }

  // ---------- theme ----------
  function loadTheme() {
    const t = localStorage.getItem(THEME_KEY);
    return THEMES.includes(t) ? t : 'auto';
  }
  function applyTheme(theme) {
    if (!THEMES.includes(theme)) theme = 'auto';
    const root = document.documentElement;
    if (theme === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);

    // Toggle the github-markdown + highlight.js stylesheets to match.
    const light = [els.mdLight, els.hlLight], dark = [els.mdDark, els.hlDark];
    if (theme === 'auto') {
      light.forEach((l) => { l.media = '(prefers-color-scheme: light)'; });
      dark.forEach((l) => { l.media = '(prefers-color-scheme: dark)'; });
    } else {
      const isDark = theme === 'dark';
      light.forEach((l) => { l.media = isDark ? 'not all' : 'all'; });
      dark.forEach((l) => { l.media = isDark ? 'all' : 'not all'; });
    }

    const sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const effectiveDark = theme === 'dark' || (theme === 'auto' && sysDark);
    els.themeColor.setAttribute('content', effectiveDark ? '#0d1117' : '#ffffff');

    localStorage.setItem(THEME_KEY, theme);
    els.themeControls.querySelectorAll('.seg-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.theme === theme);
    });
  }

  // ---------- github api ----------
  async function ghApi(path) {
    const res = await fetch(API + path, {
      headers: {
        'Authorization': 'Bearer ' + cfg.token,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (res.status === 401) throw new Error('Invalid token (401). Check the token.');
    if (res.status === 404) throw new Error('Not found (404). Check owner / repo / branch / folder.');
    if (res.status === 403) throw new Error('Access denied or rate limit exceeded (403).');
    if (!res.ok) throw new Error('GitHub API: HTTP ' + res.status);
    return res.json();
  }

  function b64ToText(b64) {
    const bin = atob((b64 || '').replace(/\s/g, ''));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
  }

  async function resolveBranch() {
    if (cfg.branch) return cfg.branch;
    const repo = await ghApi(`/repos/${cfg.owner}/${cfg.repo}`);
    cfg.branch = repo.default_branch || 'main';
    saveCfg(cfg);
    return cfg.branch;
  }

  async function fetchFileList() {
    const branch = await resolveBranch();
    const tree = await ghApi(`/repos/${cfg.owner}/${cfg.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
    const prefix = (cfg.path || '').replace(/^\/+|\/+$/g, '');
    const items = (tree.tree || [])
      .filter((t) => t.type === 'blob' && /\.(md|markdown)$/i.test(t.path))
      .filter((t) => !prefix || t.path === prefix || t.path.startsWith(prefix + '/'))
      .map((t) => {
        const rel = prefix ? t.path.slice(prefix.length + 1) : t.path;
        const parts = rel.split('/');
        const name = parts.pop().replace(/\.(md|markdown)$/i, '');
        return { path: t.path, sha: t.sha, name, group: parts.join('/') };
      });
    items.sort((a, b) => (a.group + '/' + a.name).localeCompare(b.group + '/' + b.name, 'en'));
    return items;
  }

  // ---------- rendering ----------
  function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  async function loadDoc(item) {
    els.content.innerHTML = '<p class="muted">Loading…</p>';
    try {
      const blob = await ghApi(`/repos/${cfg.owner}/${cfg.repo}/git/blobs/${item.sha}`);
      const md = b64ToText(blob.content);
      els.content.innerHTML = DOMPurify.sanitize(marked.parse(md));
      // Highlight only blocks with an explicit language (```kotlin etc.).
      // Plain ``` without a language (e.g. ASCII diagrams) stays as readable text.
      els.content.querySelectorAll('pre code').forEach((el) => {
        if ([...el.classList].some((c) => c.startsWith('language-'))) {
          try { hljs.highlightElement(el); } catch (_) {}
        }
      });
      els.docTitle.textContent = item.name;
      window.scrollTo(0, 0);
      renderList(els.filter.value);
      openSidebar(false);
    } catch (e) {
      els.content.innerHTML = '<p class="error">' + escapeHtml(e.message) + '</p>';
    }
  }

  function openSidebar(open) {
    els.sidebar.classList.toggle('open', open);
    els.backdrop.classList.toggle('show', open);
  }

  function toggleSettings(open) {
    const willOpen = open === undefined ? els.settingsPanel.classList.contains('hidden') : open;
    els.settingsPanel.classList.toggle('hidden', !willOpen);
    els.settingsToggle.classList.toggle('open', willOpen);
    els.settingsToggle.setAttribute('aria-expanded', String(willOpen));
  }

  function renderList(q) {
    q = (q || '').toLowerCase().trim();
    els.list.innerHTML = '';
    const cur = decodeURIComponent(location.hash.slice(1));
    const groups = {};
    for (const f of files) {
      if (q && !((f.name + ' ' + f.path).toLowerCase().includes(q))) continue;
      (groups[f.group] = groups[f.group] || []).push(f);
    }
    const names = Object.keys(groups).sort((a, b) => a.localeCompare(b, 'en'));
    if (!names.length) { els.list.innerHTML = '<p class="muted small">Nothing found</p>'; return; }
    for (const g of names) {
      if (g) {
        const h = document.createElement('div');
        h.className = 'group-title'; h.textContent = g;
        els.list.appendChild(h);
      }
      for (const f of groups[g]) {
        const a = document.createElement('a');
        a.className = 'file-link' + (f.path === cur ? ' active' : '');
        a.textContent = f.name;
        a.href = '#' + encodeURIComponent(f.path);
        els.list.appendChild(a);
      }
    }
  }

  function onRoute() {
    const p = decodeURIComponent(location.hash.slice(1));
    if (!p) return;
    const item = files.find((f) => f.path === p);
    if (item) loadDoc(item);
  }

  async function startReader() {
    show('reader');
    els.content.innerHTML = '<p class="muted">Loading list…</p>';
    try {
      files = await fetchFileList();
    } catch (e) {
      els.setupError.textContent = e.message;
      show('setup');
      return;
    }
    if (!files.length) {
      els.content.innerHTML = '<p class="muted">No .md files in the repository'
        + (cfg.path ? ' in folder “' + escapeHtml(cfg.path) + '”' : '') + '.</p>';
      renderList('');
      return;
    }
    renderList('');
    if (location.hash.slice(1)) onRoute();
    else location.hash = encodeURIComponent(files[0].path);
  }

  // ---------- events ----------
  els.setupForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(els.setupForm);
    cfg = {
      owner: (fd.get('owner') || '').trim(),
      repo: (fd.get('repo') || '').trim(),
      branch: (fd.get('branch') || '').trim(),
      path: (fd.get('path') || '').trim(),
      token: (fd.get('token') || '').trim(),
    };
    els.setupError.textContent = '';
    saveCfg(cfg);
    startReader();
  });

  els.authBtn.addEventListener('click', () => {
    els.setupForm.owner.value = cfg.owner || '';
    els.setupForm.repo.value = cfg.repo || '';
    els.setupForm.branch.value = cfg.branch || '';
    els.setupForm.path.value = cfg.path || '';
    els.setupForm.token.value = cfg.token || '';
    els.setupError.textContent = '';
    toggleSettings(false);
    openSidebar(false);
    show('setup');
  });

  els.menuBtn.addEventListener('click', () => openSidebar(!els.sidebar.classList.contains('open')));
  els.backdrop.addEventListener('click', () => openSidebar(false));
  els.filter.addEventListener('input', () => renderList(els.filter.value));
  els.fontDec.addEventListener('click', () => bumpFontSize(-FONT_STEP));
  els.fontInc.addEventListener('click', () => bumpFontSize(FONT_STEP));
  els.themeControls.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (btn) applyTheme(btn.dataset.theme);
  });
  els.settingsToggle.addEventListener('click', (e) => { e.stopPropagation(); toggleSettings(); });
  document.addEventListener('click', (e) => {
    if (els.settingsPanel.classList.contains('hidden')) return;
    if (els.settingsPanel.contains(e.target) || els.settingsToggle.contains(e.target)) return;
    toggleSettings(false);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggleSettings(false); });
  window.addEventListener('hashchange', onRoute);

  // ---------- init ----------
  applyTheme(loadTheme());
  applyFontSize(loadFontSize());
  cfg = loadCfg();
  if (cfg && cfg.token && cfg.owner && cfg.repo) startReader();
  else show('setup');
})();
