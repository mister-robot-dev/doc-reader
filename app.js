(function () {
  'use strict';

  const API = 'https://api.github.com';
  const LS_KEY = 'docreader.config';
  const $ = (id) => document.getElementById(id);

  const els = {
    setup: $('setup'), setupForm: $('setupForm'), setupError: $('setupError'),
    reader: $('reader'), docTitle: $('docTitle'),
    list: $('fileList'), content: $('content'), filter: $('filter'),
    sidebar: $('sidebar'), backdrop: $('backdrop'),
    menuBtn: $('menuBtn'), settingsBtn: $('settingsBtn'),
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

  // ---------- github api ----------
  async function ghApi(path) {
    const res = await fetch(API + path, {
      headers: {
        'Authorization': 'Bearer ' + cfg.token,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (res.status === 401) throw new Error('Неверный токен (401). Проверь токен.');
    if (res.status === 404) throw new Error('Не найдено (404). Проверь owner / repo / ветку / папку.');
    if (res.status === 403) throw new Error('Доступ запрещён или лимит запросов (403).');
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
    items.sort((a, b) => (a.group + '/' + a.name).localeCompare(b.group + '/' + b.name, 'ru'));
    return items;
  }

  // ---------- rendering ----------
  function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  async function loadDoc(item) {
    els.content.innerHTML = '<p class="muted">Загрузка…</p>';
    try {
      const blob = await ghApi(`/repos/${cfg.owner}/${cfg.repo}/git/blobs/${item.sha}`);
      const md = b64ToText(blob.content);
      els.content.innerHTML = DOMPurify.sanitize(marked.parse(md));
      els.content.querySelectorAll('pre code').forEach((el) => { try { hljs.highlightElement(el); } catch (_) {} });
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

  function renderList(q) {
    q = (q || '').toLowerCase().trim();
    els.list.innerHTML = '';
    const cur = decodeURIComponent(location.hash.slice(1));
    const groups = {};
    for (const f of files) {
      if (q && !((f.name + ' ' + f.path).toLowerCase().includes(q))) continue;
      (groups[f.group] = groups[f.group] || []).push(f);
    }
    const names = Object.keys(groups).sort((a, b) => a.localeCompare(b, 'ru'));
    if (!names.length) { els.list.innerHTML = '<p class="muted small">Ничего не найдено</p>'; return; }
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
    els.content.innerHTML = '<p class="muted">Загрузка списка…</p>';
    try {
      files = await fetchFileList();
    } catch (e) {
      els.setupError.textContent = e.message;
      show('setup');
      return;
    }
    if (!files.length) {
      els.content.innerHTML = '<p class="muted">В репозитории нет .md файлов'
        + (cfg.path ? ' в папке «' + escapeHtml(cfg.path) + '»' : '') + '.</p>';
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

  els.settingsBtn.addEventListener('click', () => {
    els.setupForm.owner.value = cfg.owner || '';
    els.setupForm.repo.value = cfg.repo || '';
    els.setupForm.branch.value = cfg.branch || '';
    els.setupForm.path.value = cfg.path || '';
    els.setupForm.token.value = cfg.token || '';
    els.setupError.textContent = '';
    show('setup');
  });

  els.menuBtn.addEventListener('click', () => openSidebar(!els.sidebar.classList.contains('open')));
  els.backdrop.addEventListener('click', () => openSidebar(false));
  els.filter.addEventListener('input', () => renderList(els.filter.value));
  window.addEventListener('hashchange', onRoute);

  // ---------- init ----------
  cfg = loadCfg();
  if (cfg && cfg.token && cfg.owner && cfg.repo) startReader();
  else show('setup');
})();
