// Stremio HTTP protocol on Cloudflare Workers. No video bytes are proxied.
const API = 'https://phim.nguonc.com/api';
const PREFIX = 'nguonc:';
const TYPES = ['movie', 'series'];
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const CATALOGS = [
  { id: 'nguonc-new', type: 'movie', name: 'NguonC • Mới cập nhật', path: '/films/phim-moi-cap-nhat' },
  { id: 'nguonc-movies', type: 'movie', name: 'NguonC • Phim lẻ', path: '/films/danh-sach/phim-le', fixedType: 'movie' },
  { id: 'nguonc-series', type: 'series', name: 'NguonC • Phim bộ', path: '/films/danh-sach/phim-bo', fixedType: 'series' },
  { id: 'nguonc-search', type: 'movie', name: 'NguonC • Tìm kiếm', path: '/films/search', search: true },
];
export const manifest = {
  id: 'community.nguonc.direct', version: '1.0.3', name: 'NguonC HLS / Direct',
  description: 'Danh mục, tìm kiếm và tập phim NguonC. Phát HLS/direct khi nguồn công khai cung cấp link video.',
  types: TYPES, idPrefixes: [PREFIX],
  resources: ['catalog', ...['meta', 'stream'].map(name => ({ name, types: TYPES, idPrefixes: [PREFIX] }))],
  catalogs: CATALOGS.map(({ id, type, name, search }) => ({ id, type, name,
    extra: [...(search ? [{ name: 'search', isRequired: true }] : []), { name: 'skip', isRequired: false }] })),
  behaviorHints: { adult: false, p2p: false },
};
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function json(data, status = 200, ttl = 0) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': ttl ? `public, max-age=${ttl}` : 'no-store',
    'X-Content-Type-Options': 'nosniff' } });
}
function normalize(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').toLowerCase().trim();
}
function plain(value) {
  return String(value ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}
function publicUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) return null;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    if (!host.includes('.') || /[:\[\]]/.test(host) || /^\d+\.\d+\.\d+\.\d+$/.test(host) || /\.(local|localhost|internal)$/.test(host)) return null;
    return url.href;
  } catch { return null; }
}
function category(movie, groupName) {
  return Object.values(movie.category || {}).filter(c => normalize(c.group?.name) === normalize(groupName))
    .flatMap(c => c.list || []).map(c => String(c.name || ''));
}
function guessType(movie) {
  const formats = category(movie, 'Định dạng').map(normalize);
  if (formats.includes('phim le')) return 'movie';
  if (formats.includes('phim bo')) return 'series';
  return Number(movie.total_episodes) > 1 || /tap\s*\d/.test(normalize(movie.current_episode)) ? 'series' : 'movie';
}
function preview(movie, type = guessType(movie)) {
  const year = String(movie.year || category(movie, 'Năm')[0] || '');
  return { id: PREFIX + movie.slug, type, name: String(movie.name || movie.original_name || movie.slug),
    poster: publicUrl(movie.thumb_url) || publicUrl(movie.poster_url) || undefined,
    background: publicUrl(movie.poster_url) || undefined, posterShape: 'poster',
    description: plain(movie.description).slice(0, 5000),
    releaseInfo: /^\d{4}$/.test(year) ? year : undefined,
    genres: category(movie, 'Thể loại'),
  };
}
function groups(movie) {
  return (Array.isArray(movie.episodes) ? movie.episodes : []).map(server => ({
    name: String(server.server_name || 'Server'),
    items: Array.isArray(server.items) ? server.items : (Array.isArray(server.server_data) ? server.server_data : []),
  }));
}
export function episodeKey(item) {
  const slug = normalize(item.slug), name = normalize(item.name);
  for (const value of [slug, name]) {
    const match = /^(?:(?:tap|episode|ep)[\s-]*)?0*(\d+)$/.exec(value);
    if (match) return 'n' + Number(match[1]);
  }
  const value = slug || name;
  if (!value) return null; // Never align unknown episodes by server array position.
  return 'x' + [...new TextEncoder().encode(value)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export function videoList(movie) {
  const entries = new Map();
  for (const server of groups(movie)) for (const item of server.items) {
    const key = episodeKey(item);
    if (key && !entries.has(key)) entries.set(key, item);
  }
  let special = 0;
  return [...entries].sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })).map(([key, item]) => ({
    id: `${PREFIX}${movie.slug}:${key}`, title: /^n/.test(key) ? `Tập ${Number(key.slice(1))}` : String(item.name || item.slug),
    season: key.startsWith('n') ? 1 : 0,
    episode: key.startsWith('n') ? Number(key.slice(1)) : ++special,
  }));
}
function parseId(id) {
  const match = /^nguonc:([a-z0-9]+(?:-[a-z0-9]+)*)(?::(n\d+|x[0-9a-f]+))?$/.exec(id);
  if (!match || id.length > 1000) throw new HttpError(400, 'ID NguonC không hợp lệ.');
  return { slug: match[1], episode: match[2] };
}
async function limitedText(response, maxBytes = 2_000_000) {
  if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('Response too large');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder(); let result = '', bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) { await reader.cancel(); throw new Error('Response too large'); }
      result += decoder.decode(value, { stream: true });
    }
    return result + decoder.decode();
  } finally { reader.releaseLock(); }
}
async function api(path, fetcher) {
  try {
    // Keep the subrequest simple. Some Cloudflare-fronted origins reject
    // Worker-specific cache options or requests without a normal User-Agent.
    const response = await fetcher(API + path, {
      redirect: 'follow',
      signal: AbortSignal.timeout(45000),
      headers: {
        Accept: 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 (compatible; NguonC-Stremio/1.0)',
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = JSON.parse(await limitedText(response, 5_000_000));
    if (data.status !== 'success') throw new Error('API status is not success');
    return data;
  } catch (error) {
    const reason = error instanceof Error ? error.message.slice(0, 120) : 'unknown error';
    throw new HttpError(502, `NguonC không phản hồi dữ liệu hợp lệ (${reason}).`);
  }
}
async function movieBySlug(slug, fetcher) {
  const data = await api('/film/' + encodeURIComponent(slug), fetcher);
  if (!data.movie || !Array.isArray(data.movie.episodes)) throw new HttpError(502, 'Dữ liệu chi tiết phim không hợp lệ.');
  return { ...data.movie, slug };
}
async function catalog(type, id, extra, fetcher) {
  const config = CATALOGS.find(c => c.id === id && c.type === type);
  if (!config) throw new HttpError(404, 'Không có danh mục này.');
  const search = (extra.get('search') || '').trim();
  if (config.search && !search) return { metas: [] };
  if (search.length > 200) throw new HttpError(400, 'Từ khóa quá dài.');
  const rawSkip = extra.get('skip') || '0';
  if (!/^\d+$/.test(rawSkip) || Number(rawSkip) > 1000000) throw new HttpError(400, 'skip không hợp lệ.');
  const skip = Number(rawSkip);
  const query = page => `${config.path}?${new URLSearchParams({ ...(config.search ? { keyword: search } : {}), page: String(page) })}`;
  // Read upstream page size, do not assume Stremio requests pages of 100 items.
  const first = await api(query(1), fetcher);
  const size = Number(first.paginate?.items_per_page || first.items?.length || 10);
  if (!Number.isInteger(size) || size < 1 || size > 100) throw new HttpError(502, 'Kích thước trang không hợp lệ.');
  const page = Math.floor(skip / size) + 1, offset = skip % size;
  const total = Number(first.paginate?.total_page);
  if (total && page > total) return { metas: [] };
  const data = page === 1 ? first : await api(query(page), fetcher);
  if (!Array.isArray(data.items)) throw new HttpError(502, 'Danh sách phim không hợp lệ.');
  let items = data.items.slice(offset);
  if (offset && (!total || page < total) && data.items.length === size) {
    const next = await api(query(page + 1), fetcher);
    if (!Array.isArray(next.items)) throw new HttpError(502, 'Danh sách phim không hợp lệ.');
    items.push(...next.items.slice(0, offset));
  }
  return { metas: items.filter(m => typeof m.slug === 'string').map(m => preview(m, config.fixedType || guessType(m))) };
}
export function directLinks(item) {
  const output = [];
  for (const key of ['m3u8', 'link_m3u8', 'hls', 'mp4', 'link_mp4', 'direct', 'url', 'file', 'link']) {
    const url = publicUrl(item[key]);
    if (!url) continue;
    const path = new URL(url).pathname;
    const format = /\.m3u8$/i.test(path) ? 'hls' : /\.(mp4|mkv|webm|mov|m4v)$/i.test(path) ? 'direct' :
      ['m3u8', 'link_m3u8', 'hls'].includes(key) ? 'hls' : ['mp4', 'link_mp4', 'direct'].includes(key) ? 'direct' : null;
    if (format) output.push({ url, format });
  }
  return output;
}
function allowedEmbed(url, env) {
  if (!publicUrl(url.href) || url.protocol !== 'https:' || (url.port && url.port !== '443')) return false;
  const extras = String(env.EMBED_ALLOWED_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return /^embed\d*\.streamc\.xyz$/.test(url.hostname) || extras.includes(url.hostname);
}
export function extractPublicLinks(html, base) {
  // Only literal, visible media URLs. No eval, JS execution, DRM or challenge bypass.
  const text = html.replace(/\\\//g, '/').replace(/\\u0026/gi, '&').replace(/&amp;/g, '&');
  const output = [];
  for (const match of text.matchAll(/["']([^"'<>\s]+\.(?:m3u8|mp4|mkv|webm|m4v)(?:\?[^"'<>\s]*)?)["']/gi)) {
    try {
      const url = publicUrl(new URL(match[1], base).href);
      if (url) output.push({ url, format: /\.m3u8$/i.test(new URL(url).pathname) ? 'hls' : 'direct' });
    } catch { /* Ignore malformed literals. */ }
  }
  return output;
}
async function resolveEmbed(value, env, fetcher) {
  if (!publicUrl(value)) return { links: [], status: 'invalid_embed' };
  let url = new URL(value);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!allowedEmbed(url, env)) return { links: [], status: 'host_not_allowed' };
    try {
      const response = await fetcher(url.href, { redirect: 'manual', signal: AbortSignal.timeout(7000) });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (response.body) await response.body.cancel();
        if (!location) return { links: [], status: 'invalid_redirect' };
        url = new URL(location, url); continue;
      }
      if (!response.ok) {
        if (response.body) await response.body.cancel();
        return { links: [], status: `embed_http_${response.status}` };
      }
      const links = extractPublicLinks(await limitedText(response), url.href);
      return { links, status: links.length ? 'public_link_found' : 'no_public_media_url' };
    } catch { return { links: [], status: 'embed_unreachable' }; }
  }
  return { links: [], status: 'redirect_limit' };
}
function customStreams(env, id) {
  if (!env.DIRECT_SOURCES) return [];
  let map;
  try { map = JSON.parse(env.DIRECT_SOURCES); }
  catch { throw new HttpError(500, 'DIRECT_SOURCES phải là JSON hợp lệ.'); }
  const sources = map?.[id] || [];
  if (!Array.isArray(sources)) throw new HttpError(500, 'Mỗi ID trong DIRECT_SOURCES phải chứa một mảng.');
  return sources.flatMap(source => {
    const url = publicUrl(source.url);
    if (!url) return [];
    return [{ url, name: String(source.name || 'Direct tùy chỉnh'),
      behaviorHints: { notWebReady: true, ...(source.requestHeaders && typeof source.requestHeaders === 'object'
        ? { proxyHeaders: { request: source.requestHeaders } } : {}) } }];
  });
}
async function streamsFor(movie, type, episode, env, fetcher) {
  if (type === 'series' && !episode) return { streams: [], diagnostics: [{ status: 'select_episode' }] };
  const selected = groups(movie).map(server => ({ name: server.name,
    item: episode ? server.items.find(item => episodeKey(item) === episode)
      : server.items.find(item => /^(full|hoan tat|tron bo)$/.test(normalize(item.name))) || server.items[0],
  })).filter(s => s.item).slice(0, 6);
  const diagnostics = [], streams = [];
  await Promise.all(selected.map(async ({ name, item }) => {
    let links = directLinks(item), status = links.length ? 'api_direct_link' : 'no_direct_link';
    if (!links.length && env.RESOLVE_PUBLIC_EMBED !== 'false' && (item.embed || item.link_embed)) {
      const result = await resolveEmbed(item.embed || item.link_embed, env, fetcher);
      links = result.links; status = result.status;
    }
    diagnostics.push({ server: name, episode: String(item.name || ''), status, count: links.length });
    for (const link of links) streams.push({ url: link.url,
      name: `NguonC • ${link.format === 'hls' ? 'HLS' : 'Direct'} • ${movie.quality || ''}`,
      title: `${name} • ${item.name || 'Full'}${movie.language ? ' • ' + movie.language : ''}`,
      behaviorHints: { notWebReady: true, bingeGroup: `nguonc-${name}-${link.format}` }, _format: link.format });
  }));
  const preferred = env.PREFERRED_FORMAT === 'direct' ? 'direct' : 'hls';
  streams.sort((a, b) => Number(b._format === preferred) - Number(a._format === preferred) || a.title.localeCompare(b.title));
  return { streams: streams.map(({ _format, ...stream }) => stream), diagnostics };
}
export function createWorker(fetcher = (...args) => fetch(...args)) {
  return { async fetch(request, env = {}) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (!['GET', 'HEAD'].includes(request.method)) return json({ error: 'Method not allowed' }, 405);
    let response;
    try {
      const url = new URL(request.url);
      if (url.pathname === '/') response = json({ name: manifest.name,
        manifest: `${url.origin}/manifest.json`, install: `stremio://${url.host}/manifest.json`,
        help: 'Dán URL manifest vào Addons trong Stremio. Nếu không có stream, xem README và /diagnose/{type}/{id}.json.' });
      else if (url.pathname === '/health') response = json({ ok: true, version: manifest.version });
      else if (/^(?:\/manifest\.json)+\/?$/.test(url.pathname)) response = json(manifest, 200, 3600);
      else {
        const match = /^\/(catalog|meta|stream|diagnose)\/([^/]+)\/([^/]+?)(?:\/(.*))?\.json$/.exec(url.pathname);
        if (!match) throw new HttpError(404, 'Endpoint không tồn tại.');
        const [, resource, rawType, rawId, extras] = match;
        let type, id;
        try { type = decodeURIComponent(rawType); id = decodeURIComponent(rawId); }
        catch { throw new HttpError(400, 'URL encoding không hợp lệ.'); }
        if (!TYPES.includes(type)) throw new HttpError(404, 'Loại nội dung không được hỗ trợ.');
        if (resource === 'catalog') {
          response = json(await catalog(type, id, new URLSearchParams(extras || url.search.slice(1)), fetcher), 200, 120);
        } else {
          if (extras) throw new HttpError(404, 'Endpoint không tồn tại.');
          const { slug, episode } = parseId(id);
          const custom = resource !== 'meta' ? customStreams(env, id) : [];
          if (resource === 'stream' && custom.length) response = json({ streams: custom });
          else {
            const movie = await movieBySlug(slug, fetcher);
            if (resource === 'meta') response = json({ meta: { ...preview(movie, type),
              cast: String(movie.casts || '').split(',').map(s => s.trim()).filter(Boolean),
              director: String(movie.director || '').split(',').map(s => s.trim()).filter(Boolean),
              ...(type === 'series' ? { videos: videoList(movie) } : {}),
            } }, 200, 120);
            else {
              const result = await streamsFor(movie, type, episode, env, fetcher);
              const unique = [...new Map(result.streams.map(stream => [stream.url, stream])).values()];
              response = resource === 'diagnose' ? json({ id, customStreams: custom.length, streamCount: unique.length, servers: result.diagnostics })
                : json({ streams: unique, ...(!unique.length ? { error: 'Nguồn chưa cung cấp link HLS/direct truy cập được. Xem endpoint diagnose hoặc cấu hình DIRECT_SOURCES.' } : {}) });
            }
          }
        }
      }
    } catch (error) {
      response = json({ error: error instanceof HttpError ? error.message : 'Lỗi xử lý addon.' }, error instanceof HttpError ? error.status : 500);
    }
    return request.method === 'HEAD' ? new Response(null, { status: response.status, headers: response.headers }) : response;
  } };
}
export default createWorker();
