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
    return json({
      title: env.SITE_TITLE || '碎碎念',
      desc: env.SITE_DESC || '',
      author: env.SITE_AUTHOR || '',
      lang: env.SITE_LANG || 'zh-CN',
    });
  }

  /* 会话状态 */
  if (p === '/api/me') {
    return json({ authed: await isAuthed(request, env) });
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
  const title = env.SITE_TITLE || '碎碎念';
  const desc = env.SITE_DESC || '';
  const origin = url.origin;
  const tz = Number(env.SITE_TZ_OFFSET ?? 8) * 3600 * 1000;
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
    <language>${esc(env.SITE_LANG || 'zh-cn')}</language>
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
