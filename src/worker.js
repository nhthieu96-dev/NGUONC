// Stremio Addon cho phim.nguonc.com — chạy trên Cloudflare Workers
// Dựa trên API công khai (không chính thức) của nguonc.com:
//   - Danh sách:  https://phim.nguonc.com/api/films/danh-sach/phim-moi-cap-nhat?page=N
//   - Tìm kiếm:   https://phim.nguonc.com/api/films/search?keyword=...
//   - Chi tiết:   https://phim.nguonc.com/api/film/{slug}
// Cấu trúc JSON có thể thay đổi theo thời gian vì đây là API không chính thức.

const BASE_API = "https://phim.nguonc.com/api";
const PREFIX = "nguonc:";
const PAGE_SIZE = 20;
const CACHE_TTL = 60 * 30; // 30 phút

const MANIFEST = {
  id: "com.nguonc.stremio.unofficial",
  version: "1.0.0",
  name: "NguonC Phim",
  description:
    "Addon xem phim tiếng Việt lấy dữ liệu từ phim.nguonc.com (không chính thức).",
  logo: "https://phim.nguonc.com/favicon.ico",
  resources: ["catalog", "meta", "stream"],
  types: ["movie", "series"],
  idPrefixes: [PREFIX],
  catalogs: [
    {
      type: "movie",
      id: "nguonc-movie",
      name: "NguonC - Phim Lẻ",
      extra: [{ name: "search" }, { name: "skip" }],
    },
    {
      type: "series",
      id: "nguonc-series",
      name: "NguonC - Phim Bộ",
      extra: [{ name: "search" }, { name: "skip" }],
    },
  ],
  behaviorHints: { configurable: false },
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "*",
  };
}

function jsonResponse(data, status = 200, cache = true) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(),
      "Cache-Control": cache
        ? `public, max-age=${CACHE_TTL}`
        : "no-store",
    },
  });
}

function stripHtml(html) {
  if (!html) return undefined;
  return html.replace(/<[^>]*>/g, "").trim() || undefined;
}

async function fetchJson(url) {
  const cache = caches.default;
  const cacheKey = new Request(url, { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) return cached.json();

  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`Upstream ${url} returned ${res.status}`);
  }
  const bodyText = await res.text();

  // Tạo Response mới với header có thể chỉnh sửa để lưu vào cache edge.
  const cacheableResponse = new Response(bodyText, {
    status: res.status,
    headers: { "Cache-Control": `max-age=${CACHE_TTL}` },
  });
  caches.default.put(cacheKey, cacheableResponse).catch(() => {});

  return JSON.parse(bodyText);
}

function isSeries(item) {
  const total = parseInt(item && item.total_episodes, 10);
  return Boolean(total && total > 1);
}

function toMetaPreview(item) {
  return {
    id: PREFIX + item.slug,
    type: isSeries(item) ? "series" : "movie",
    name: item.name || item.original_name || item.slug,
    poster: item.poster_url || item.thumb_url,
    posterShape: "poster",
    background: item.thumb_url || item.poster_url,
    description: stripHtml(item.description),
    releaseInfo: item.created ? String(item.created).slice(0, 4) : undefined,
  };
}

async function handleCatalog(type, extra) {
  let items = [];

  if (extra.search) {
    const data = await fetchJson(
      `${BASE_API}/films/search?keyword=${encodeURIComponent(extra.search)}`
    );
    items = data.items || [];
  } else {
    const skip = parseInt(extra.skip || "0", 10) || 0;
    const page = Math.floor(skip / PAGE_SIZE) + 1;
    const data = await fetchJson(
      `${BASE_API}/films/phim-moi-cap-nhat?page=${page}`
    );
    items = data.items || [];
  }

  const filtered = items.filter((item) => isSeries(item) === (type === "series"));
  return { metas: filtered.map(toMetaPreview) };
}

async function handleMeta(id) {
  const slug = id.replace(PREFIX, "").split(":")[0];
  const data = await fetchJson(`${BASE_API}/film/${encodeURIComponent(slug)}`);
  const movie = data && data.movie;
  if (!movie) return { meta: null };

  const series = isSeries(movie);
  const meta = {
    id: PREFIX + movie.slug,
    type: series ? "series" : "movie",
    name: movie.name || movie.original_name || movie.slug,
    poster: movie.poster_url || movie.thumb_url,
    background: movie.thumb_url || movie.poster_url,
    description: stripHtml(movie.description),
    releaseInfo: movie.created ? String(movie.created).slice(0, 4) : undefined,
    runtime: movie.time || undefined,
    director: movie.director ? [movie.director] : undefined,
    cast: movie.casts
      ? String(movie.casts)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined,
  };

  if (series && Array.isArray(movie.episodes) && movie.episodes.length) {
    const primaryServer = movie.episodes[0];
    meta.videos = (primaryServer.items || []).map((ep, idx) => ({
      id: `${PREFIX}${movie.slug}:${ep.slug}`,
      title: ep.name || `Tập ${idx + 1}`,
      season: 1,
      episode: idx + 1,
      released: movie.modified || movie.created || undefined,
    }));
  }

  return { meta };
}

async function handleStream(id) {
  const rest = id.replace(PREFIX, "");
  const [slug, epSlug] = rest.split(":");
  const data = await fetchJson(`${BASE_API}/film/${encodeURIComponent(slug)}`);
  const movie = data && data.movie;
  if (!movie || !Array.isArray(movie.episodes)) return { streams: [] };

  const streams = [];
  for (const server of movie.episodes) {
    const items = server.items || [];
    const match = epSlug ? items.find((it) => it.slug === epSlug) : items[0];
    if (!match || !match.embed) continue;
    // Nguồn chỉ cung cấp link nhúng iframe (không phải file media trực tiếp),
    // nên dùng externalUrl để Stremio mở link này trong trình duyệt/webview
    // khi người dùng bấm Play — đúng với cách trang gốc phân phối nội dung.
    streams.push({
      name: "NguonC",
      title: `${server.server_name || "Server"} - Tập ${match.name || ""}`.trim(),
      externalUrl: match.embed,
    });
  }
  return { streams };
}

function parseExtra(rawSegments) {
  // rawSegments: các đoạn kiểu "search=abc" hoặc "skip=20" nối bằng "/"
  const extra = {};
  for (const seg of rawSegments) {
    const idx = seg.indexOf("=");
    if (idx === -1) continue;
    const k = decodeURIComponent(seg.slice(0, idx));
    const v = decodeURIComponent(seg.slice(idx + 1));
    extra[k] = v;
  }
  return extra;
}

function landingPage(origin) {
  const manifestUrl = `${origin}/manifest.json`;
  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8" />
<title>NguonC Phim - Stremio Addon</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; background:#111; color:#eee; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; }
  .card { max-width: 480px; padding: 32px; background:#1c1c1c; border-radius: 12px; text-align:center; }
  h1 { font-size: 22px; margin-bottom: 8px; }
  p { color:#aaa; font-size:14px; line-height:1.5; }
  a.btn { display:inline-block; margin-top:20px; padding:12px 24px; background:#7b5bf5; color:white; border-radius:8px; text-decoration:none; font-weight:600; }
  code { background:#000; padding:2px 6px; border-radius:4px; font-size:12px; word-break: break-all; }
</style>
</head>
<body>
  <div class="card">
    <h1>🎬 NguonC Phim - Stremio Addon</h1>
    <p>Addon không chính thức, lấy dữ liệu từ phim.nguonc.com</p>
    <a class="btn" href="stremio://${manifestUrl.replace(/^https?:\/\//, "")}">Cài vào Stremio</a>
    <p style="margin-top:20px;">Hoặc dán link sau vào ô "Add addon" trong Stremio:</p>
    <code>${manifestUrl}</code>
  </div>
</body>
</html>`;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (path === "/" || path === "") {
      return new Response(landingPage(url.origin), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (path === "/manifest.json") {
      return jsonResponse(MANIFEST);
    }

    // Route tạm để debug: xem thẳng JSON thật mà nguonc.com trả về,
    // gọi qua chính Worker (không bị chặn bot như gọi từ máy khác).
    // Ví dụ: /debug/list  hoặc  /debug/film/{slug}
    if (path === "/debug/list") {
      try {
        const data = await fetchJson(
          `${BASE_API}/films/phim-moi-cap-nhat?page=1`
        );
        return jsonResponse(data, 200, false);
      } catch (err) {
        return jsonResponse({ error: String(err) }, 500, false);
      }
    }
    if (path.startsWith("/debug/film/")) {
      const slug = path.replace("/debug/film/", "");
      try {
        const data = await fetchJson(`${BASE_API}/film/${slug}`);
        return jsonResponse(data, 200, false);
      } catch (err) {
        return jsonResponse({ error: String(err) }, 500, false);
      }
    }
    // Proxy vạn năng để dò endpoint đúng, ví dụ:
    //   /debug/raw?url=https://phim.nguonc.com/api/films/phim-moi-cap-nhat.json
    //   /debug/raw?url=https://phim.nguonc.com/api-film/film/the-avengers
    if (path === "/debug/raw") {
      const target = url.searchParams.get("url");
      if (!target) {
        return jsonResponse({ error: "Thiếu ?url=" }, 400, false);
      }
      try {
        const res = await fetch(target, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            Accept: "application/json,text/html,*/*",
          },
        });
        const text = await res.text();
        return new Response(
          JSON.stringify({ status: res.status, body: text.slice(0, 3000) }),
          {
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              ...corsHeaders(),
            },
          }
        );
      } catch (err) {
        return jsonResponse({ error: String(err) }, 500, false);
      }
    }

    const segments = path.split("/").filter(Boolean);
    // /catalog/{type}/{id}.json  hoặc  /catalog/{type}/{id}/search=xxx.json  hoặc /skip=20.json

    if (segments[0] === "catalog" && segments.length >= 3) {
      const type = segments[1];
      const idAndMaybeExtra = segments.slice(2).join("/");
      const cleaned = idAndMaybeExtra.replace(/\.json$/, "");
      const parts = cleaned.split("/");
      // parts[0] là catalog id (bỏ qua, vì chỉ có 1 catalog mỗi type), phần còn lại là extra
      const extra = parseExtra(parts.slice(1));
      try {
        const result = await handleCatalog(type, extra);
        return jsonResponse(result);
      } catch (err) {
        return jsonResponse({ metas: [] }, 200, false);
      }
    }

    if (segments[0] === "meta" && segments.length === 3) {
      const id = decodeURIComponent(segments[2].replace(/\.json$/, ""));
      try {
        const result = await handleMeta(id);
        return jsonResponse(result);
      } catch (err) {
        return jsonResponse({ meta: null }, 200, false);
      }
    }

    if (segments[0] === "stream" && segments.length === 3) {
      const id = decodeURIComponent(segments[2].replace(/\.json$/, ""));
      try {
        const result = await handleStream(id);
        return jsonResponse(result);
      } catch (err) {
        return jsonResponse({ streams: [] }, 200, false);
      }
    }

    return new Response("Not found", { status: 404, headers: corsHeaders() });
  },
};
