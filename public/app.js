/* ────────────────────────────────────────────────────────────
   memo · 前端
   ──────────────────────────────────────────────────────────── */

const $ = (s, r = document) => r.querySelector(s);

const state = {
  site: { title: '碎碎念', desc: '' },
  notes: [],
  total: 0,
  offset: 0,
  done: false,
  loading: false,
  authed: false,
  tag: '',
  q: '',
  animate: true,
};

/* ── 通用工具 ─────────────────────────────────────────────── */

const pad = (n) => String(n).padStart(2, '0');
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== false) node.setAttribute(k, v);
  }
  for (const kid of kids) {
    if (kid == null) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  return node;
}

function toast(msg, ms = 2000) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(t._timer);
  t._timer = setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => { t.hidden = true; }, 260);
  }, ms);
}

/* ── 行内排版：`code` **粗** *斜* #标签 链接 ───────────────── */

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(https?:\/\/[^\s<>"'）】。，、；！？]+)|(#[\p{L}\p{N}_-]+)/gu;

function inline(text, parent) {
  INLINE.lastIndex = 0;
  let last = 0;
  let m;

  while ((m = INLINE.exec(text))) {
    if (m.index > last) {
      parent.append(document.createTextNode(text.slice(last, m.index)));
    }
    const tok = m[0];
    let consumed = tok.length;

    if (tok[0] === '`') {
      parent.append(el('code', { text: tok.slice(1, -1) }));
    } else if (tok.startsWith('**')) {
      parent.append(el('strong', { text: tok.slice(2, -2) }));
    } else if (tok[0] === '*') {
      parent.append(el('em', { text: tok.slice(1, -1) }));
    } else if (tok[0] === '#') {
      const name = tok.slice(1);
      parent.append(el('a', {
        class: 'tag',
        href: `?tag=${encodeURIComponent(name)}`,
        text: tok,
      }));
    } else {
      const trail = (tok.match(/[.,;:!?)\]}]+$/) || [''])[0];
      const url = trail ? tok.slice(0, -trail.length) : tok;
      parent.append(el('a', {
        href: url,
        target: '_blank',
        rel: 'noopener noreferrer',
        text: url.replace(/^https?:\/\//, '').replace(/\/$/, ''),
      }));
      if (trail) consumed -= trail.length;
    }

    last = m.index + consumed;
    if (consumed < tok.length) INLINE.lastIndex = last;
  }

  if (last < text.length) {
    parent.append(document.createTextNode(text.slice(last)));
  }
}

function renderBody(text) {
  const wrap = el('div', { class: 'note-body' });
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');

  let para = null;
  let quote = null;
  let qPara = null;
  let list = null;

  const reset = () => { para = null; quote = null; qPara = null; list = null; };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');

    if (!line.trim()) { reset(); continue; }

    const qm = line.match(/^>\s?(.*)$/);
    if (qm) {
      if (!quote) { quote = el('blockquote'); wrap.append(quote); }
      if (!qPara) { qPara = el('p'); quote.append(qPara); }
      else qPara.append(el('br'));
      inline(qm[1], qPara);
      para = null; list = null;
      continue;
    }
    quote = null; qPara = null;

    const lm = line.match(/^\s*[-*·]\s+(.*)$/);
    if (lm) {
      if (!list) { list = el('ul'); wrap.append(list); }
      const li = el('li');
      inline(lm[1], li);
      list.append(li);
      para = null;
      continue;
    }
    list = null;

    if (!para) { para = el('p'); wrap.append(para); }
    else para.append(el('br'));
    inline(line, para);
  }

  return wrap;
}

/* ── 数据层 ───────────────────────────────────────────────── */

async function rawApi(path, opts = {}) {
  const res = await fetch(path, { credentials: 'same-origin', ...opts });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch { /* ignore */ }
    throw new Error(msg || '请求失败');
  }
  return res.status === 204 ? null : res.json();
}

const api = rawApi;

/* ── 主题 ─────────────────────────────────────────────────── */

function syncThemeColor() {
  const dark = document.documentElement.dataset.theme === 'dark';
  document.getElementById('themeColor')?.setAttribute('content', dark ? '#333333' : '#f4f1ec');
}

function applyTheme() {
  const saved = localStorage.getItem('echlite-theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = saved || (prefersDark ? 'dark' : 'light');
  syncThemeColor();
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('echlite-theme', next);
  syncThemeColor();
}

/* ── 渲染 ─────────────────────────────────────────────────── */

function render() {
  const stream = $('#stream');
  stream.innerHTML = '';
  $('#empty').hidden = state.notes.length > 0 || state.done === false;
  $('#error').hidden = true;
  $('#loading').hidden = true;

  if (!state.notes.length) {
    const filtered = !!(state.tag || state.q);
    $('#empty').querySelector('.state-main').textContent = filtered ? '没有找到' : '这里还空着';
    $('#empty').querySelector('.state-sub').textContent = filtered ? '换个词试试。' : '第一句话往往最难写。';
    $('#empty').hidden = false;
    return;
  }
  $('#empty').hidden = true;

  const groups = [];
  let cur = null;

  for (const note of state.notes) {
    const d = new Date(note.created_at);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (!cur || cur.key !== key) {
      cur = { key, date: d, items: [] };
      groups.push(cur);
    }
    cur.items.push(note);
  }

  let index = 0;
  const today = new Date();
  const isToday = (d) =>
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();

  for (const g of groups) {
    const d = g.date;
    const sameYear = d.getFullYear() === today.getFullYear();
    const num = sameYear
      ? `${pad(d.getMonth() + 1)}.${pad(d.getDate())}`
      : `${String(d.getFullYear()).slice(2)}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;

    const list = el('ul', { class: 'notes' });
    for (const note of g.items) {
      const li = buildNote(note, index++);
      list.append(li);
    }

    const section = el('section', { class: `day${isToday(d) ? ' day-today' : ''}` },
      el('div', { class: 'day-label' },
        el('span', { class: 'day-num', text: num }),
        el('span', { class: 'day-dow', text: isToday(d) ? '今天' : WEEK[d.getDay()] }),
      ),
      list,
    );
    stream.append(section);
  }

  state.animate = false;
  updateFoot();
}

function buildNote(note, index) {
  const d = new Date(note.created_at);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const permalink = `${location.pathname}?n=${note.id}`;

  const meta = el('div', { class: 'note-meta' },
    el('a', {
      class: 'note-time',
      href: permalink,
      title: '点一下复制这条的链接',
      text: time,
      onclick: (e) => {
        e.preventDefault();
        const url = `${location.origin}${permalink}`;
        navigator.clipboard?.writeText(url).then(
          () => toast('链接已复制'),
          () => toast(url),
        );
        history.replaceState(null, '', permalink);
      },
    }),
  );

  if (note.pinned) meta.append(el('span', { class: 'note-flag', text: '置顶' }));
  if (note.updated_at) meta.append(el('span', { class: 'note-time', text: '已编辑' }));

  if (state.authed) {
    const tools = el('div', { class: 'note-tools' });
    tools.append(
      el('button', {
        class: 'tool-btn', title: '编辑', 'aria-label': '编辑',
        onclick: () => startEdit(note, li),
      }, icon('pencil')),
      el('button', {
        class: 'tool-btn', title: note.pinned ? '取消置顶' : '置顶', 'aria-label': '置顶',
        onclick: () => togglePin(note),
      }, icon('pin')),
      el('button', {
        class: 'tool-btn danger', title: '删除', 'aria-label': '删除',
        onclick: () => removeNote(note),
      }, icon('trash')),
    );
    meta.append(tools);
  }

  const li = el('li', { class: 'note', id: `n-${note.id}` },
    meta,
    renderBody(note.content),
  );

  if (state.animate) li.style.setProperty('--i', String(index % 12));
  else li.style.animation = 'none';

  return li;
}

function icon(name) {
  const paths = {
    pencil: 'M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3z',
    trash: 'M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13',
    pin: 'M12 3v9m0 0-4 4h8l-4-4zM7 20h10',
  };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', paths[name]);
  svg.append(p);
  return svg;
}

function updateFoot() {
  const count = $('#footCount');
  if (count) count.textContent = state.total ? `共 ${state.total} 条` : '';
}

/* ── 操作 ─────────────────────────────────────────────────── */

async function startEdit(note, li) {
  const body = li.querySelector('.note-body');
  const box = el('div');
  const ta = el('textarea', { class: 'note-editor', rows: '4' });
  ta.value = note.content;

  const save = async () => {
    const text = ta.value.trim();
    if (!text) return toast('内容不能为空');
    try {
      const updated = await api(`/api/notes/${note.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: text }),
      });
      Object.assign(note, updated);
      // 整条重建，让「已编辑」标记跟着一起更新
      li.replaceWith(buildNote(note, 0));
      toast('已保存');
    } catch (e) { toast(e.message); }
  };

  const cancel = () => box.replaceWith(body);

  box.append(
    ta,
    el('div', { class: 'editor-actions' },
      el('button', { class: 'btn-ghost', text: '取消', onclick: cancel }),
      el('button', { class: 'btn-primary', text: '保存', onclick: save }),
    ),
  );
  body.replaceWith(box);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  ta.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); save(); }
    if (e.key === 'Escape') cancel();
  });
}

async function togglePin(note) {
  try {
    const updated = await api(`/api/notes/${note.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pinned: !note.pinned }),
    });
    note.pinned = updated.pinned ?? !note.pinned;
    state.notes.sort((a, b) => (b.pinned - a.pinned) || (b.created_at - a.created_at));
    state.animate = false;
    render();
    toast(note.pinned ? '已置顶' : '已取消置顶');
  } catch (e) { toast(e.message); }
}

async function removeNote(note) {
  if (!confirm('删掉这条？删了就找不回来了。')) return;
  try {
    await api(`/api/notes/${note.id}`, { method: 'DELETE' });
    state.notes = state.notes.filter((n) => n.id !== note.id);
    state.total = Math.max(0, state.total - 1);
    state.animate = false;
    // 整页重排：否则删掉某天最后一条后，会留下一个空的日期分组
    render();
    toast('已删除');
  } catch (e) { toast(e.message); }
}

/* ── 加载 ─────────────────────────────────────────────────── */

async function loadMore(reset = false) {
  if (state.loading) return;
  if (!reset && state.done) return;

  state.loading = true;
  if (reset) {
    state.notes = [];
    state.offset = 0;
    state.done = false;
    state.animate = true;
    $('#empty').hidden = true;
    $('#error').hidden = true;
  }
  $('#loading').hidden = false;

  try {
    const qs = new URLSearchParams({ limit: '30', offset: String(state.offset) });
    if (state.tag) qs.set('tag', state.tag);
    if (state.q) qs.set('q', state.q);

    const data = await api(`/api/notes?${qs}`);
    const incoming = data.notes || [];

    if (reset) state.notes = incoming;
    else state.notes = state.notes.concat(incoming);

    state.total = data.total ?? state.notes.length;
    state.offset = state.notes.length;
    state.done = incoming.length === 0 || state.notes.length >= state.total;

    render();
    if (reset) jumpToPermalink();
  } catch (e) {
    if (reset) {
      $('#loading').hidden = true;
      $('#error').hidden = false;
      $('#errorMsg').textContent = e.message;
    } else {
      toast(e.message);
    }
  } finally {
    state.loading = false;
    $('#loading').hidden = true;
  }
}

function jumpToPermalink() {
  const id = new URLSearchParams(location.search).get('n');
  if (!id) return;

  const node = document.getElementById(`n-${id}`);
  if (!node) {
    if (!state.done && !state.loading) loadMore().then(jumpToPermalink);
    return;
  }
  node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  node.classList.add('flash');
  setTimeout(() => node.classList.remove('flash'), 2400);
}

/* ── 登录 / 发布 ──────────────────────────────────────────── */

function openModal() {
  $('#modal').hidden = false;
  $('#pwErr').textContent = '';
  $('#pwInput').value = '';
  setTimeout(() => $('#pwInput').focus(), 60);
}

function closeModal() {
  $('#modal').hidden = true;
}

async function login() {
  const pw = $('#pwInput').value;
  if (!pw) return;
  try {
    await api('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: pw }),
    });
    state.authed = true;
    closeModal();
    setAuthUI();
    state.animate = false;
    render();
    toast('欢迎回来');
    setTimeout(() => $('#composerInput').focus(), 300);
  } catch (e) {
    $('#pwErr').textContent = e.message;
    $('#pwInput').select();
  }
}

async function logout() {
  await api('/api/logout', { method: 'POST' });
  state.authed = false;
  setAuthUI();
  state.animate = false;
  render();
  toast('已退出');
}

function setAuthUI() {
  $('#dock').hidden = !state.authed;
  $('#loginBtn').textContent = state.authed ? '退出' : '登录';
}

async function publish() {
  const input = $('#composerInput');
  const btn = $('#publishBtn');
  const text = input.value.trim();
  if (!text) return;

  btn.disabled = true;
  btn.textContent = '发布中';
  try {
    const note = await api('/api/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: text }),
    });
    const firstUnpinned = state.notes.findIndex((n) => !n.pinned);
    state.notes.splice(firstUnpinned < 0 ? state.notes.length : firstUnpinned, 0, note);
    state.total += 1;
    state.animate = false;
    render();
    // 只让刚发出的那条亮一下，别把整条时间线重播一遍
    const fresh = document.getElementById(`n-${note.id}`);
    if (fresh) { fresh.style.animation = ''; fresh.classList.add('flash'); }
    input.value = '';
    resizeInput();
    input.blur();
    $('#dock').classList.remove('focused');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    toast('发出去了');
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = !input.value.trim();
    btn.textContent = '发布';
  }
}

function resizeInput() {
  const input = $('#composerInput');
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, window.innerHeight * 0.36)}px`;
  const len = input.value.length;
  const counter = $('#counter');
  counter.textContent = len ? `${len}` : '';
  counter.classList.toggle('warn', len > 4500);
  $('#publishBtn').disabled = !input.value.trim();
}

/* ── 事件绑定 ─────────────────────────────────────────────── */

function bindUI() {
  $('#themeBtn').addEventListener('click', toggleTheme);

  $('#loginBtn').addEventListener('click', () => {
    if (state.authed) logout();
    else openModal();
  });

  $('#modal').addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) closeModal();
  });

  $('#pwSubmit').addEventListener('click', login);
  $('#pwInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') login();
    if (e.key === 'Escape') closeModal();
  });

  const input = $('#composerInput');
  input.addEventListener('input', resizeInput);
  input.addEventListener('focus', () => $('#dock').classList.add('focused'));
  input.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); publish(); }
    if (e.key === 'Escape') { input.blur(); $('#dock').classList.remove('focused'); }
  });
  $('#publishBtn').addEventListener('click', publish);

  $('#filterClear').addEventListener('click', () => {
    location.href = location.pathname;
  });

  $('#retryBtn').addEventListener('click', () => loadMore(true));

  // 搜索
  const searchInput = $('#searchInput');
  $('#searchBtn').addEventListener('click', () => {
    searchInput.hidden = false;
    searchInput.focus();
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const q = searchInput.value.trim();
      const url = new URL(location.href);
      if (q) url.searchParams.set('q', q);
      else url.searchParams.delete('q');
      location.href = url.toString();
    }
    if (e.key === 'Escape') { searchInput.hidden = true; searchInput.value = ''; }
  });

  // 快捷键：n 写一条
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, [contenteditable]')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'n' && state.authed) {
      e.preventDefault();
      $('#composerInput').focus();
    }
  });

  // 无限滚动
  let ticking = false;
  window.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      const nearBottom =
        window.innerHeight + window.scrollY > document.body.offsetHeight - 700;
      if (nearBottom && !state.done && !state.loading) loadMore();
    });
  }, { passive: true });
}

/* ── 启动 ─────────────────────────────────────────────────── */

async function boot() {
  applyTheme();
  bindUI();

  const params = new URLSearchParams(location.search);
  state.tag = (params.get('tag') || '').replace(/^#/, '');
  state.q = params.get('q') || '';

  if (state.tag || state.q) {
    const parts = [];
    if (state.tag) parts.push(`#${state.tag}`);
    if (state.q) parts.push(`「${state.q}」`);
    $('#filterText').textContent = `正在看 ${parts.join(' 中搜 ')}`;
    $('#filter').hidden = false;
  }

  try {
    const [site, me] = await Promise.all([api('/api/site'), api('/api/me')]);
    state.site = site;
    state.authed = !!me.authed;

    $('#siteTitle').textContent = site.title || '碎碎念';
    $('#siteDesc').textContent = site.desc || '';
    document.title = site.title || '碎碎念';
    const metaDesc = document.querySelector('meta[name="description"]');
    if (metaDesc && site.desc) metaDesc.setAttribute('content', site.desc);

    setAuthUI();
  } catch {
    $('#siteTitle').textContent = '碎碎念';
    $('#dock').hidden = true;
  }

  await loadMore(true);
}

boot();
