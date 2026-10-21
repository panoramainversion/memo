/**
 * memo — 极简单人微博客
 * Cloudflare Workers + D1
 */

const enc = new TextEncoder();

/* ────────────────────────────── 工具 ────────────────────────────── */

const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extra,
    },
  });
}

const fail = (msg, status = 400) => json({ error: msg }, status);

function esc(s = '') {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}

// 定长比较，避免时序侧信道
function safeEqual(a, b) {
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

const secretOf = (env) => env.SESSION_SECRET || env.ADMIN_PASSWORD || 'echlite-dev';

/* ────────────────────────────── 会话 ────────────────────────────── */

const COOKIE = 'ec_session';
const MAX_AGE = 60 * 60 * 24 * 30; // 30 天

async function makeSession(env) {
  const payload = b64url(enc.encode(JSON.stringify({ exp: Date.now() + MAX_AGE * 1000 })));
  return `${payload}.${await hmac(secretOf(env), payload)}`;
}

async function isValidSession(env, token) {
  if (!token || !token.includes('.')) return false;
  const [payload, sig] = token.split('.');
  if (!safeEqual(sig, await hmac(secretOf(env), payload))) return false;
  try {
    const { exp } = JSON.parse(new TextDecoder().decode(
      Uint8Array.from(atob(payload.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
    ));
    return typeof exp === 'number' && exp > Date.now();
  } catch {
    return false;
  }
}

function readCookie(request, name) {
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

const isAuthed = async (request, env) =>
  isValidSession(env, readCookie(request, COOKIE));

const sessionCookie = (token) =>
  `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE}`;

const clearCookie = () =>
  `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

/* ────────────────────────────── 数据 ────────────────────────────── */

const shape = (r) => ({
  id: r.id,
  content: r.content,
  created_at: r.created_at,
  updated_at: r.updated_at || null,
  pinned: !!r.pinned,
});

/* ─────────────────────────── 站点配置 ─────────────────────────── */

const SITE_TITLE_MAX = 80;
const SITE_DESC_MAX = 300;
const SITE_AUTHOR_MAX = 80;
const NOTE_MAX = 5000;
const RESTORE_MAX = 50000;

const siteDefaults = (env) => ({
  title: String(env.SITE_TITLE || '碎碎念').trim() || '碎碎念',
  desc: String(env.SITE_DESC || '').trim(),
  author: String(env.SITE_AUTHOR || '').trim(),
  lang: String(env.SITE_LANG || 'zh-CN').trim() || 'zh-CN',
  tz: Number.isFinite(Number(env.SITE_TZ_OFFSET ?? 8)) ? Number(env.SITE_TZ_OFFSET ?? 8) : 8,
});

function cleanText(value, max) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);
}

function clampTz(value, fallback = 8) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(14, Math.max(-12, Math.round(n * 4) / 4));
}

function normalizeSite(input = {}, fallback = {}) {
  return {
    title: cleanText(input.title, SITE_TITLE_MAX) || fallback.title || '碎碎念',
    desc: cleanText(input.desc, SITE_DESC_MAX),
    author: cleanText(input.author, SITE_AUTHOR_MAX),
    lang: cleanText(input.lang, 24) || fallback.lang || 'zh-CN',
    tz: clampTz(input.tz, fallback.tz ?? 8),
  };
}

let settingsReady = false;
async function ensureSettings(env) {
  if (settingsReady) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT 0
  )`).run();
  settingsReady = true;
}

async function getSiteConfig(env) {
  const defaults = siteDefaults(env);
  try {
    const row = await env.DB.prepare(
      "SELECT value FROM settings WHERE key = 'site'"
    ).first();
    if (row?.value) {
      return normalizeSite(JSON.parse(row.value), defaults);
    }
  } catch {
    // 还没建 settings 表时按环境变量里的默认值工作
  }
  return defaults;
}

async function saveSiteConfig(env, config) {
  await ensureSettings(env);
  const site = normalizeSite(config, siteDefaults(env));
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('site', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(JSON.stringify(site), Date.now()).run();
  return site;
}

/* ─────────────────────────── 备份 / 恢复 ─────────────────────────── */

function noteTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
    const t = Date.parse(value);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

// 兼容三种格式：本项目的备份、裸 notes 数组、wrangler d1 --json 的结果
function backupNotes(payload) {
  if (Array.isArray(payload)) {
    if (payload.some((row) => Array.isArray(row?.results))) {
      return payload.flatMap((row) => (Array.isArray(row.results) ? row.results : []));
    }
    return payload;
  }
  if (Array.isArray(payload?.notes)) return payload.notes;
  if (Array.isArray(payload?.results)) return payload.results;
  return [];
}

function prepareNotes(raw) {
  const notes = [];
  const seenIds = new Set();
  let skipped = 0;

  for (const row of raw) {
    if (notes.length >= RESTORE_MAX) { skipped += 1; continue; }
    if (!row || typeof row !== 'object') { skipped += 1; continue; }

    const content = String(row.content ?? '').replace(/\r\n/g, '\n').trim();
    if (!content || content.length > NOTE_MAX) { skipped += 1; continue; }

    const created = noteTimestamp(row.created_at);
    if (!created) { skipped += 1; continue; }

    let updated = row.updated_at == null ? null : noteTimestamp(row.updated_at);
    if (updated && updated < created) updated = created;

    let id = Number(row.id);
    if (!Number.isInteger(id) || id <= 0 || id > Number.MAX_SAFE_INTEGER) id = null;
    if (id && seenIds.has(id)) id = null;
    if (id) seenIds.add(id);

    notes.push({
      id,
      content,
      created_at: created,
      updated_at: updated,
      pinned: row.pinned ? 1 : 0,
    });
  }

  return { notes, skipped };
}

async function insertNotesMerge(env, notes) {
  let inserted = 0;
  for (let i = 0; i < notes.length; i += 50) {
    const chunk = notes.slice(i, i + 50);
    const stmts = chunk.map((n) => env.DB.prepare(
      `INSERT INTO notes (content, created_at, updated_at, pinned)
       SELECT ?, ?, ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM notes WHERE content = ? AND created_at = ?
       )`
    ).bind(n.content, n.created_at, n.updated_at, n.pinned, n.content, n.created_at));
    const results = await env.DB.batch(stmts);
    inserted += results.reduce((sum, r) => sum + (r.meta?.changes || 0), 0);
  }
  return inserted;
}

async function replaceNotes(env, notes) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS notes_import (
    id         INTEGER PRIMARY KEY,
    content    TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER,
    pinned     INTEGER NOT NULL DEFAULT 0
  )`).run();
  await env.DB.prepare('DELETE FROM notes_import').run();

  // 先全部灌进临时表；任何一批失败都不会碰现有数据
  for (let i = 0; i < notes.length; i += 50) {
    const chunk = notes.slice(i, i + 50);
    const stmts = chunk.map((n) => env.DB.prepare(
      'INSERT INTO notes_import (id, content, created_at, updated_at, pinned) VALUES (?, ?, ?, ?, ?)'
    ).bind(n.id, n.content, n.created_at, n.updated_at, n.pinned));
    await env.DB.batch(stmts);
  }

  // 最后一步一次事务内换表
  await env.DB.batch([
    env.DB.prepare('DELETE FROM notes'),
    env.DB.prepare(
      `INSERT INTO notes (id, content, created_at, updated_at, pinned)
       SELECT id, content, created_at, updated_at, pinned FROM notes_import ORDER BY id`
    ),
    env.DB.prepare('DROP TABLE notes_import'),
  ]);
}

async function listNotes(env, { limit, offset, tag, q }) {
  const where = [];
  const args = [];
  if (tag) {
    where.push('content LIKE ?');
    args.push(`%#${tag}%`);
  }
  if (q) {
    where.push('content LIKE ?');
    args.push(`%${q}%`);
  }
  const sql = `SELECT * FROM notes
               ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY pinned DESC, created_at DESC, id DESC
               LIMIT ? OFFSET ?`;
  const { results } = await env.DB.prepare(sql).bind(...args, limit, offset).all();
  const { results: cnt } = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM notes ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`
  ).bind(...args).all();
  return { notes: (results || []).map(shape), total: cnt?.[0]?.n ?? 0 };
}

/* ────────────────────────────── 路由 ────────────────────────────── */

async function handleApi(request, env, url) {
  const { pathname: p } = url;
  const method = request.method;

  /* 站点信息 */
  if (p === '/api/site') {
    return json(await getSiteConfig(env));
  }

  /* 会话状态 */
  if (p === '/api/me') {
    return json({ authed: await isAuthed(request, env) });
  }

  /* 管理：站点配置 */
  if (p === '/api/admin/site') {
    if (!(await isAuthed(request, env))) return fail('未登录', 401);
    if (method === 'GET') {
      return json({ site: await getSiteConfig(env), defaults: siteDefaults(env) });
    }
    if (method === 'PUT') {
      const body = await request.json().catch(() => ({}));
      const title = cleanText(body.title, SITE_TITLE_MAX);
      if (!title) return fail('站点标题不能为空');
      const site = await saveSiteConfig(env, {
        title,
        desc: body.desc,
        author: body.author,
        lang: body.lang,
        tz: body.tz,
      });
      return json({ ok: true, site });
    }
    return fail('Method not allowed', 405);
  }

  /* 管理：导出备份 */
  if (p === '/api/admin/backup') {
    if (method !== 'GET') return fail('Method not allowed', 405);
    if (!(await isAuthed(request, env))) return fail('未登录', 401);
    const [site, { results }] = await Promise.all([
      getSiteConfig(env),
      env.DB.prepare(
        'SELECT id, content, created_at, updated_at, pinned FROM notes ORDER BY id'
      ).all(),
    ]);
    const filename = `memo-backup-${new Date().toISOString().slice(0, 10)}.json`;
    return json({
      app: 'memo',
      version: 1,
      exported_at: new Date().toISOString(),
      site,
      notes: results || [],
    }, 200, { 'content-disposition': `attachment; filename="${filename}"` });
  }

  /* 管理：恢复备份 */
  if (p === '/api/admin/restore' && method === 'POST') {
    if (!(await isAuthed(request, env))) return fail('未登录', 401);
    const length = Number(request.headers.get('content-length') || 0);
    if (length > 25 * 1024 * 1024) return fail('备份文件太大了（上限 25 MB）', 413);

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return fail('备份文件格式不对');

    const rawNotes = backupNotes(body);
    if (!rawNotes.length && !body.site) return fail('备份里没有可恢复的数据');
    const prepared = prepareNotes(rawNotes);
    if (!prepared.notes.length && !body.site) return fail('备份里没有可恢复的条目');

    const mode = body.mode === 'replace' ? 'replace' : 'merge';
    let inserted = 0;
    let deleted = 0;
    let siteUpdated = false;

    if (prepared.notes.length) {
      if (mode === 'replace') {
        const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM notes').first();
        deleted = count?.n ?? 0;
        await replaceNotes(env, prepared.notes);
        inserted = prepared.notes.length;
      } else {
        inserted = await insertNotesMerge(env, prepared.notes);
      }
    }

    if (body.site && body.restoreSite !== false) {
      const { title, desc, author, lang, tz } = body.site;
      if (title || desc || author || lang || tz != null) {
        await saveSiteConfig(env, { title, desc, author, lang, tz });
        siteUpdated = true;
      }
    }

    return json({
      ok: true,
      mode,
      inserted,
      skipped: prepared.skipped + (mode === 'merge' ? prepared.notes.length - inserted : 0),
      deleted,
      siteUpdated,
    });
  }

  if (p === '/api/login' && method === 'POST') {
    if (!env.ADMIN_PASSWORD) return fail('未设置 ADMIN_PASSWORD', 500);
    const body = await request.json().catch(() => ({}));
    if (!safeEqual(body.password || '', env.ADMIN_PASSWORD)) {
      await new Promise((r) => setTimeout(r, 400)); // 拖慢暴力破解
      return fail('密码不对', 401);
    }
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie(await makeSession(env)) });
  }

  if (p === '/api/logout') {
    if (method !== 'POST') return fail('Method not allowed', 405);
    return json({ ok: true }, 200, { 'set-cookie': clearCookie() });
  }

  /* 列表 */
  if (p === '/api/notes' && method === 'GET') {
    const limit = Math.min(Number(url.searchParams.get('limit')) || 30, 100);
    const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
    const tag = (url.searchParams.get('tag') || '').replace(/^#/, '').trim();
    const q = (url.searchParams.get('q') || '').trim();
    return json(await listNotes(env, { limit, offset, tag, q }));
  }

  /* 新建 */
  if (p === '/api/notes' && method === 'POST') {
    if (!(await isAuthed(request, env))) return fail('未登录', 401);
    const { content, created_at } = await request.json().catch(() => ({}));
    const text = String(content || '').trim();
    if (!text) return fail('内容不能为空');
    if (text.length > 5000) return fail('单条最多 5000 字');
    // 可选：补写过去的条目（数字毫秒或 ISO 字符串）
    let ts = Date.now();
    if (created_at) {
      const t = typeof created_at === 'number' ? created_at : Date.parse(created_at);
      if (Number.isFinite(t) && t > 0) ts = t;
    }
    const ins = await env.DB.prepare(
      'INSERT INTO notes (content, created_at) VALUES (?, ?)'
    ).bind(text, ts).run();
    const row = await env.DB.prepare('SELECT * FROM notes WHERE id = ?')
      .bind(ins.meta.last_row_id).first();
    return json(shape(row), 201);
  }

  /* 单条 / 修改 / 删除 */
  const m = p.match(/^\/api\/notes\/(\d+)$/);
  if (m) {
    const id = Number(m[1]);

    if (method === 'GET') {
      const row = await env.DB.prepare('SELECT * FROM notes WHERE id = ?').bind(id).first();
      return row ? json(shape(row)) : fail('没有这条', 404);
    }

    if (method === 'PATCH') {
      if (!(await isAuthed(request, env))) return fail('未登录', 401);
      const body = await request.json().catch(() => ({}));
      const sets = [];
      const args = [];
      if (typeof body.content === 'string') {
        const text = body.content.trim();
        if (!text) return fail('内容不能为空');
        if (text.length > 5000) return fail('单条最多 5000 字');
        sets.push('content = ?', 'updated_at = ?');
        args.push(text, Date.now());
      }
      if (typeof body.pinned === 'boolean') {
        sets.push('pinned = ?');
        args.push(body.pinned ? 1 : 0);
      }
      if (!sets.length) return fail('没有要改的字段');
      const upd = await env.DB.prepare(
        `UPDATE notes SET ${sets.join(', ')} WHERE id = ?`
      ).bind(...args, id).run();
      if (!upd.meta?.changes) return fail('没有这条', 404);
      const row = await env.DB.prepare('SELECT * FROM notes WHERE id = ?').bind(id).first();
      return json(shape(row));
    }

    if (method === 'DELETE') {
      if (!(await isAuthed(request, env))) return fail('未登录', 401);
      const r = await env.DB.prepare('DELETE FROM notes WHERE id = ?').bind(id).run();
      return json({ ok: true, deleted: r.meta?.changes || 0 });
    }
  }

  return fail('Not found', 404);
}

/* ────────────────────────────── RSS ────────────────────────────── */

async function handleFeed(env, url) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM notes ORDER BY created_at DESC LIMIT 30'
  ).all();
  const site = await getSiteConfig(env);
  const title = site.title;
  const desc = site.desc;
  const origin = url.origin;
  const tz = site.tz * 3600 * 1000;
  const p2 = (n) => String(n).padStart(2, '0');

  const items = (results || []).map((n) => {
    const local = new Date(n.created_at + tz);
    const label = `${local.getUTCFullYear()}-${p2(local.getUTCMonth() + 1)}-${p2(local.getUTCDate())}`
      + ` ${p2(local.getUTCHours())}:${p2(local.getUTCMinutes())}`;
    return `    <item>
      <title>${esc(label)}</title>
      <link>${origin}/?n=${n.id}</link>
      <guid isPermaLink="false">echlite-${n.id}</guid>
      <pubDate>${new Date(n.created_at).toUTCString()}</pubDate>
      <description>${esc(n.content)}</description>
    </item>`;
  }).join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${esc(title)}</title>
    <link>${origin}</link>
    <description>${esc(desc)}</description>
    <language>${esc(site.lang)}</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <atom:link href="${origin}/feed.xml" rel="self" type="application/rss+xml" />
${items}
  </channel>
</rss>`;

  return new Response(xml, {
    headers: {
      'content-type': 'application/rss+xml; charset=utf-8',
      'cache-control': 'public, max-age=600',
    },
  });
}

/* ────────────────────────────── 入口 ────────────────────────────── */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    try {
      if (url.pathname.startsWith('/api/')) {
        return await handleApi(request, env, url);
      }
      if (url.pathname === '/feed.xml') {
        return await handleFeed(env, url);
      }
      // 其余交给静态资源（含 SPA 回退）
      return await env.ASSETS.fetch(request);
    } catch (err) {
      console.error('[echlite]', err);
      return fail(err?.message || '服务器开了个小差', 500);
    }
  },
};
