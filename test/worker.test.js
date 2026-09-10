import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorker, videoList, episodeKey, extractPublicLinks } from '../src/worker.js';
const movie = { slug: 'demo', name: 'Demo', total_episodes: 3, episodes: [
  { server_name: 'A', items: [
    { slug: 'tap-1', name: '1', m3u8: 'https://media.example.com/1.m3u8?token=x&y=2', mp4: 'https://media.example.com/1.mp4' },
    { slug: 'tap-3', name: '3', embed: 'https://embed.streamc.xyz/player/3' },
  ] },
  { server_name: 'B', items: [
    { slug: '01', name: '01', link_m3u8: 'https://other.example.com/1.m3u8' },
    { slug: 'tap-2', name: '2', m3u8: 'https://other.example.com/2.m3u8' },
  ] },
] };
const response = data => new Response(JSON.stringify(data));
function setup(embedResponse = () => new Response('<script>file: "https://media.example.com/3.m3u8"</script>')) {
  const calls = [];
  const worker = createWorker(async (input) => {
    const url = new URL(input); calls.push(url.href);
    if (url.hostname === 'phim.nguonc.com') {
      if (url.pathname.startsWith('/api/film/')) return response({ status: 'success', movie });
      const page = Number(url.searchParams.get('page'));
      return response({ status: 'success', paginate: { items_per_page: 3, total_page: 3 },
        items: Array.from({ length: 3 }, (_, i) => ({ slug: `demo-${(page - 1) * 3 + i}`, name: `Movie ${i}`, total_episodes: 1 })) });
    }
    return embedResponse(url);
  });
  return { calls, get: (path, env = {}, method = 'GET') => worker.fetch(new Request('https://addon.example.com' + path, { method }), env) };
}
test('manifest, CORS and HEAD are available without upstream', async () => {
  const { get, calls } = setup(); const r = await get('/manifest.json');
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.equal((await r.json()).resources[2].idPrefixes[0], 'nguonc:');
  assert.equal(await (await get('/manifest.json', {}, 'HEAD')).text(), '');
  assert.equal((await get('/stream/movie/nguonc:demo.json', {}, 'OPTIONS')).status, 204);
  assert.equal(calls.length, 0);
});
test('pagination supports unaligned skip without duplicates or missing items', async () => {
  const { get } = setup();
  const a = await (await get('/catalog/movie/nguonc-new/skip=2.json')).json();
  const b = await (await get('/catalog/movie/nguonc-new/skip=5.json')).json();
  assert.deepEqual([...a.metas, ...b.metas].map(m => m.id), [2, 3, 4, 5, 6, 7].map(i => 'nguonc:demo-' + i));
});
test('search preserves encoded Vietnamese text and ampersand', async () => {
  const { get, calls } = setup(); const query = 'mùa hè & biển';
  await get('/catalog/movie/nguonc-search/search=' + encodeURIComponent(query) + '.json');
  assert.equal(new URL(calls[0]).searchParams.get('keyword'), query);
});
test('episode identity merges padded numbers and never uses position', async () => {
  assert.equal(episodeKey({ slug: 'tap-01' }), 'n1');
  assert.deepEqual(videoList(movie).map(v => v.id), ['nguonc:demo:n1', 'nguonc:demo:n2', 'nguonc:demo:n3']);
  const { get } = setup();
  const data = await (await get('/stream/series/nguonc:demo:n2.json')).json();
  assert.equal(data.streams.length, 1);
  assert.equal(data.streams[0].url, 'https://other.example.com/2.m3u8');
});
test('both HLS and direct survive and preference changes ordering', async () => {
  const { get } = setup();
  const data = await (await get('/stream/series/nguonc%3Ademo%3An1.json', { PREFERRED_FORMAT: 'direct' })).json();
  assert.equal(data.streams.length, 3);
  assert.match(data.streams[0].url, /mp4$/);
  assert.ok(data.streams.some(s => s.url.endsWith('token=x&y=2')));
});
test('public embed resolves literal links; iframe is never a stream', async () => {
  const { get } = setup();
  const data = await (await get('/stream/series/nguonc:demo:n3.json')).json();
  assert.equal(data.streams[0].url, 'https://media.example.com/3.m3u8');
  assert.ok(!data.streams.some(s => s.url.includes('embed.streamc.xyz')));
  assert.equal(extractPublicLinks('<iframe src="https://embed.example.com/player"></iframe>', 'https://embed.example.com').length, 0);
});
test('403 is reported honestly and never causes a challenge bypass', async () => {
  const { get, calls } = setup(() => new Response('Forbidden', { status: 403 }));
  const data = await (await get('/diagnose/series/nguonc:demo:n3.json')).json();
  assert.equal(data.streamCount, 0); assert.equal(data.servers[0].status, 'embed_http_403');
  assert.equal(calls.length, 2);
});
test('redirect to private or unapproved host is not fetched', async () => {
  const { get, calls } = setup(() => new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/secret' } }));
  const data = await (await get('/diagnose/series/nguonc:demo:n3.json')).json();
  assert.equal(data.servers[0].status, 'host_not_allowed');
  assert.equal(calls.length, 2);
});
test('public extraction unescapes URLs and supports relative media paths', () => {
  const data = extractPublicLinks('file="https:\\/\\/cdn.example.com/a.m3u8?x=1&amp;y=2"; src="/video.mp4"', 'https://embed.example.com/player');
  assert.deepEqual(data.map(s => s.url), ['https://cdn.example.com/a.m3u8?x=1&y=2', 'https://embed.example.com/video.mp4']);
});
test('series metadata exposes a selectable merged episode list', async () => {
  const { get } = setup(); const { meta } = await (await get('/meta/series/nguonc:demo.json')).json();
  assert.equal(meta.type, 'series'); assert.equal(meta.videos.length, 3);
});
test('custom direct source works without upstream and invalid JSON is actionable', async () => {
  const { get, calls } = setup();
  const env = { DIRECT_SOURCES: JSON.stringify({ 'nguonc:demo:n1': [{ url: 'https://cdn.example.com/signed?id=3', requestHeaders: { Referer: 'https://example.com/' } }] }) };
  const data = await (await get('/stream/series/nguonc:demo:n1.json', env)).json();
  assert.equal(data.streams[0].behaviorHints.proxyHeaders.request.Referer, 'https://example.com/');
  assert.equal(calls.length, 0);
  assert.equal((await get('/stream/series/nguonc:demo:n1.json', { DIRECT_SOURCES: '{' })).status, 500);
});
test('malformed IDs and bad skip fail before network requests', async () => {
  const { get, calls } = setup();
  for (const path of ['/stream/movie/tt123.json', '/stream/movie/nguonc:..json', '/catalog/movie/nguonc-new/skip=-1.json'])
    assert.equal((await get(path)).status, 400);
  assert.equal((await get('/manifest.json', {}, 'POST')).status, 405); assert.equal(calls.length, 0);
});
test('upstream errors are not cached as empty success', async () => {
  const worker = createWorker(async () => new Response('bad', { status: 503 }));
  const result = await worker.fetch(new Request('https://addon.example.com/meta/movie/nguonc:demo.json'));
  assert.equal(result.status, 502); assert.equal(result.headers.get('cache-control'), 'no-store');
});
