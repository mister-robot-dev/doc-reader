(function () {
  'use strict';

  const API = 'https://api.github.com';
  const LS_KEY = 'docreader.config';
  const FONT_KEY = 'docreader.fontsize';
  const FONT_MIN = 12, FONT_MAX = 28, FONT_STEP = 1, FONT_DEFAULT = 16;
  const THEME_KEY = 'docreader.theme';
  const THEMES = ['light', 'dark', 'auto'];
  const $ = (id) => document.getElementById(id);
  const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

  const els = {
    setup: $('setup'), setupForm: $('setupForm'), setupError: $('setupError'),
    reader: $('reader'), docTitle: $('docTitle'),
    list: $('fileList'), content: $('content'), filter: $('filter'),
    sidebar: $('sidebar'), backdrop: $('backdrop'),
    toc: $('toc'), tocList: $('tocList'), tocBtn: $('tocBtn'),
    menuBtn: $('menuBtn'), authBtn: $('authBtn'),
    reloadBtn: $('reloadBtn'), refreshListBtn: $('refreshListBtn'),
    settingsToggle: $('settingsToggle'), settingsPanel: $('settingsPanel'),
    settingsBackdrop: $('settingsBackdrop'), settingsClose: $('settingsClose'),
    fontDec: $('fontDec'), fontInc: $('fontInc'), fontVal: $('fontVal'),
    themeControls: $('themeControls'), themeColor: $('themeColor'),
    mdLight: $('mdLight'), mdDark: $('mdDark'), hlLight: $('hlLight'), hlDark: $('hlDark'),
  };

  marked.setOptions({ gfm: true, breaks: false });

  let cfg = null;     // { owner, repo, branch, path, token }
  let files = [];     // [{ path, sha, name, group, mtime }]  mtime: ISO string | null
  let tocObserver = null;   // IntersectionObserver for the outline scroll-spy

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
        return { path: t.path, sha: t.sha, name, group: parts.join('/'), mtime: null };
      });
    items.sort((a, b) => (a.group + '/' + a.name).localeCompare(b.group + '/' + b.name, 'en'));
    return items;
  }

  // Run `worker` over `items` with at most `limit` tasks in flight at once.
  async function runPool(items, limit, worker) {
    let i = 0;
    const next = async () => {
      while (i < items.length) {
        const idx = i++;
        await worker(items[idx], idx);
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, next));
  }

  // Pull each file's last-commit date in the background and store it on f.mtime.
  // Per-file try/catch keeps one bad/missing file from sinking the whole batch.
  async function fetchMtimes(branch, onProgress) {
    await runPool(files, 6, async (f) => {
      try {
        const commits = await ghApi(`/repos/${cfg.owner}/${cfg.repo}/commits`
          + `?path=${encodeURIComponent(f.path)}&sha=${encodeURIComponent(branch)}&per_page=1`);
        const date = commits && commits[0] && commits[0].commit
          && commits[0].commit.committer && commits[0].commit.committer.date;
        f.mtime = date || null;
      } catch (_) {
        f.mtime = null;
      }
      if (onProgress) onProgress();
    });
  }

  // Sort by last-modified, newest first; undated files sink, then alphabetical tiebreak.
  function byMtimeDesc(a, b) {
    const ta = a.mtime ? Date.parse(a.mtime) : -Infinity;
    const tb = b.mtime ? Date.parse(b.mtime) : -Infinity;
    if (tb !== ta) return tb - ta;
    return a.name.localeCompare(b.name, 'en');
  }

  // Newest mtime among a group's files (for ordering folder headers).
  function groupNewest(items) {
    let max = -Infinity;
    for (const f of items) {
      const t = f.mtime ? Date.parse(f.mtime) : -Infinity;
      if (t > max) max = t;
    }
    return max;
  }

  // Compact local time: 2026-06-18 09:21
  function fmtMtime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
         + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  // ---------- rendering ----------
  function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  // ---------- outline (on this page) ----------
  function slugify(text) {
    return (text || '').toLowerCase().trim()
      .replace(/[^\wЀ-ӿ \-]/g, '')   // keep latin/cyrillic word chars, spaces, hyphens
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function clearOutline() {
    els.tocList.innerHTML = '';
    document.body.classList.remove('has-toc');
    if (tocObserver) { tocObserver.disconnect(); tocObserver = null; }
  }

  // Real headings are mostly letters/digits and reasonably short. This drops
  // ASCII-art / decorative lines that markdown sometimes parses as headings.
  function looksLikeHeading(text) {
    const t = (text || '').trim();
    if (!t || t.length > 120) return false;
    const nonspace = t.replace(/\s/g, '').length;
    const alnum = (t.match(/[\p{L}\p{N}]/gu) || []).length;
    return alnum >= 1 && nonspace > 0 && alnum / nonspace >= 0.4;
  }

  function buildOutline() {
    const MAX_DEPTH = 3;   // show only the top N heading levels of the document
    let real = [...els.content.querySelectorAll('h1, h2, h3, h4, h5, h6')]
      .filter((h) => looksLikeHeading(h.textContent));
    if (real.length < 2) return;   // nothing useful to show

    let minLevel = Math.min(...real.map((h) => +h.tagName[1]));
    // A lone top-level heading (e.g. the document title) shouldn't occupy a
    // tree level — drop it and re-base the outline on the next level down.
    if (real.filter((h) => +h.tagName[1] === minLevel).length === 1) {
      real = real.filter((h) => +h.tagName[1] !== minLevel);
      if (real.length < 2) return;
      minLevel = Math.min(...real.map((h) => +h.tagName[1]));
    }

    const headings = real.filter((h) => +h.tagName[1] <= minLevel + (MAX_DEPTH - 1));
    if (headings.length < 2) return;

    const used = new Set();
    for (let i = 0; i < headings.length; i++) {
      const h = headings[i];
      const base = slugify(h.textContent) || ('section-' + (i + 1));
      let id = base, n = 1;
      while (used.has(id)) id = base + '-' + (++n);
      used.add(id);
      h.id = id;
    }

    const frag = document.createDocumentFragment();
    for (const h of headings) {
      const lvl = +h.tagName[1];
      const a = document.createElement('button');
      a.type = 'button';
      a.className = 'toc-link' + (lvl === minLevel ? ' toc-top' : '');
      a.dataset.target = h.id;
      a.textContent = h.textContent.trim();
      a.title = a.textContent;
      a.style.paddingLeft = (10 + (lvl - minLevel) * 14) + 'px';
      frag.appendChild(a);
    }
    els.tocList.appendChild(frag);
    document.body.classList.add('has-toc');
    setupScrollSpy(headings);
  }

  function setActiveTocLink(id) {
    const prev = els.tocList.querySelector('.toc-link.active');
    if (prev) prev.classList.remove('active');
    if (!id) return;
    const cur = els.tocList.querySelector('.toc-link[data-target="' + id + '"]');
    if (!cur) return;
    cur.classList.add('active');
    // keep the active entry within the outline's own scroll
    const box = els.tocList.getBoundingClientRect(), it = cur.getBoundingClientRect();
    if (it.top < box.top || it.bottom > box.bottom) cur.scrollIntoView({ block: 'nearest' });
  }

  // Highlight the heading nearest the top of the viewport as the page scrolls.
  function setupScrollSpy(headings) {
    if (!('IntersectionObserver' in window)) return;
    const topbar = document.querySelector('.topbar');
    const top = (topbar ? topbar.offsetHeight : 52) + 4;
    const visible = new Set();
    try {
      tocObserver = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.add(e.target.id);
          else visible.delete(e.target.id);
        }
        let active = null;
        for (const h of headings) { if (visible.has(h.id)) { active = h.id; break; } }
        if (!active) {   // nothing in the band → the last heading scrolled past
          for (const h of headings) { if (h.getBoundingClientRect().top < top + 1) active = h.id; }
        }
        setActiveTocLink(active);
      }, { rootMargin: '-' + top + 'px 0px -65% 0px', threshold: 0 });
      headings.forEach((h) => tocObserver.observe(h));
    } catch (_) {}
  }

  async function loadDoc(item, force) {
    els.content.innerHTML = '<p class="muted">Loading…</p>';
    clearOutline();
    try {
      let md;
      if (force) {
        // Resolve the path's current blob from the branch. The blob endpoint is
        // content-addressed, so reusing the stored SHA would just re-serve the
        // stale copy — fetch by path to pick up edits made on GitHub.
        const branch = await resolveBranch();
        const data = await ghApi(`/repos/${cfg.owner}/${cfg.repo}/contents/${encodePath(item.path)}?ref=${encodeURIComponent(branch)}`);
        item.sha = data.sha;
        md = data.content
          ? b64ToText(data.content)   // files >1MB come back empty here → fall back to the blob
          : b64ToText((await ghApi(`/repos/${cfg.owner}/${cfg.repo}/git/blobs/${item.sha}`)).content);
      } else {
        const blob = await ghApi(`/repos/${cfg.owner}/${cfg.repo}/git/blobs/${item.sha}`);
        md = b64ToText(blob.content);
      }
      els.content.innerHTML = DOMPurify.sanitize(marked.parse(md));
      // Highlight only blocks with an explicit language (```kotlin etc.).
      // Plain ``` without a language (e.g. ASCII diagrams) stays as readable text.
      els.content.querySelectorAll('pre code').forEach((el) => {
        if ([...el.classList].some((c) => c.startsWith('language-'))) {
          try { hljs.highlightElement(el); } catch (_) {}
        }
      });
      buildOutline();
      els.docTitle.textContent = item.name;
      window.scrollTo(0, 0);
      renderList(els.filter.value);
      openSidebar(false);
    } catch (e) {
      els.content.innerHTML = '<p class="error">' + escapeHtml(e.message) + '</p>';
    }
  }

  // Only one drawer is open at a time on mobile; the backdrop tracks either.
  function setOverlay(which) {
    els.sidebar.classList.toggle('open', which === 'sidebar');
    els.toc.classList.toggle('open', which === 'toc');
    els.backdrop.classList.toggle('show', which === 'sidebar' || which === 'toc');
  }
  function openSidebar(open) { setOverlay(open ? 'sidebar' : null); }
  function openToc(open) { setOverlay(open ? 'toc' : null); }

  function toggleSettings(open) {
    const willOpen = open === undefined ? els.settingsPanel.classList.contains('hidden') : open;
    els.settingsPanel.classList.toggle('hidden', !willOpen);
    els.settingsBackdrop.classList.toggle('hidden', !willOpen);
    els.settingsToggle.classList.toggle('open', willOpen);
    els.settingsToggle.setAttribute('aria-expanded', String(willOpen));
  }

  function renderList(q) {
    q = (q || '').toLowerCase().trim();
    els.list.innerHTML = '';
    const cur = decodeURIComponent(location.hash.slice(1));
    const groups = {};
    for (const f of files) {
      if (q && !f.name.toLowerCase().includes(q)) continue;
      (groups[f.group] = groups[f.group] || []).push(f);
    }
    // Folders ordered by their freshest file (newest on top); alphabetical tiebreak.
    const names = Object.keys(groups).sort((a, b) => {
      const d = groupNewest(groups[b]) - groupNewest(groups[a]);
      return d !== 0 ? d : a.localeCompare(b, 'en');
    });
    if (!names.length) { els.list.innerHTML = '<p class="muted small">Nothing found</p>'; return; }
    for (const g of names) {
      if (g) {
        const h = document.createElement('div');
        h.className = 'group-title'; h.textContent = g;
        els.list.appendChild(h);
      }
      for (const f of groups[g].slice().sort(byMtimeDesc)) {
        const a = document.createElement('a');
        a.className = 'file-link' + (f.path === cur ? ' active' : '');
        a.href = '#' + encodeURIComponent(f.path);
        const name = document.createElement('span');
        name.className = 'file-name';
        name.textContent = f.name;
        a.appendChild(name);
        const meta = fmtMtime(f.mtime);
        if (meta) {
          const m = document.createElement('span');
          m.className = 'file-meta';
          m.textContent = meta;
          a.appendChild(m);
        }
        els.list.appendChild(a);
      }
    }
  }

  function onRoute() {
    const p = decodeURIComponent(location.hash.slice(1));
    if (!p) { showWelcome(); return; }
    const item = files.find((f) => f.path === p);
    if (item) { els.reloadBtn.disabled = false; loadDoc(item); }
    else showWelcome();
  }

  const isMobile = () => window.matchMedia('(max-width: 768px)').matches;

  // No document selected: invite the user to pick one. On mobile the file list
  // lives in a drawer, so slide it out instead of showing an empty screen.
  function showWelcome() {
    clearOutline();
    els.reloadBtn.disabled = true;   // no open document to refresh
    els.docTitle.textContent = 'Doc Reader';
    els.content.innerHTML = '<p class="muted">Select a document from the list.</p>';
    renderList(els.filter.value);
    if (isMobile()) openSidebar(true);
  }

  // Pull last-commit dates in the background, re-sorting/re-rendering the list
  // progressively (debounced). Fire-and-forget — first paint stays instant and
  // per-file errors degrade softly.
  function loadMtimesInBackground() {
    let pending = null;
    const scheduleRerender = () => {
      if (pending) return;
      pending = setTimeout(() => { pending = null; renderList(els.filter.value); }, 250);
    };
    fetchMtimes(cfg.branch, scheduleRerender).finally(() => {
      if (pending) { clearTimeout(pending); pending = null; }
      renderList(els.filter.value);
    });
  }

  // Re-fetch the file list (new/removed files, updated SHAs) without disturbing
  // the open document; last-commit dates reload in the background as before.
  async function refreshList() {
    let next;
    try {
      next = await fetchFileList();
    } catch (e) {
      els.list.innerHTML = '<p class="error small">' + escapeHtml(e.message) + '</p>';
      return;
    }
    files = next;
    renderList(els.filter.value);
    loadMtimesInBackground();
  }

  // Re-fetch the open document straight from the branch (force = bypass the blob
  // cache by resolving the path's latest SHA first).
  function reloadCurrentDoc() {
    const p = decodeURIComponent(location.hash.slice(1));
    const item = files.find((f) => f.path === p);
    if (item) return loadDoc(item, true);
  }

  // Disable + spin an icon button for the duration of an async refresh.
  async function withSpin(btn, fn) {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.classList.add('spinning');
    try { await fn(); }
    finally { btn.classList.remove('spinning'); btn.disabled = false; }
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

    // Background: pull last-commit dates, re-sort/re-render progressively.
    loadMtimesInBackground();

    if (location.hash.slice(1)) onRoute();
    else showWelcome();
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
  els.reloadBtn.addEventListener('click', () => withSpin(els.reloadBtn, reloadCurrentDoc));
  els.refreshListBtn.addEventListener('click', () => withSpin(els.refreshListBtn, refreshList));
  els.tocBtn.addEventListener('click', () => openToc(!els.toc.classList.contains('open')));
  els.tocList.addEventListener('click', (e) => {
    const btn = e.target.closest('.toc-link');
    if (!btn) return;
    const target = document.getElementById(btn.dataset.target);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setActiveTocLink(btn.dataset.target);
    openToc(false);
  });
  els.backdrop.addEventListener('click', () => setOverlay(null));
  els.filter.addEventListener('input', () => renderList(els.filter.value));
  els.fontDec.addEventListener('click', () => bumpFontSize(-FONT_STEP));
  els.fontInc.addEventListener('click', () => bumpFontSize(FONT_STEP));
  els.themeControls.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (btn) applyTheme(btn.dataset.theme);
  });
  els.settingsToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSettings();
    // Opening settings slides the drawer shut so the panel isn't hidden behind it.
    if (els.settingsToggle.classList.contains('open')) openSidebar(false);
  });
  els.settingsClose.addEventListener('click', () => toggleSettings(false));
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
