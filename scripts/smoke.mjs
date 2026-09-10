// Usage: npm run smoke -- https://your-worker.workers.dev
const base = process.argv[2];
if (!base || !/^https?:\/\//.test(base)) {
  console.error('Usage: npm run smoke -- https://YOUR-WORKER.workers.dev'); process.exit(1);
}
async function get(path) {
  const r = await fetch(new URL(path, base), { signal: AbortSignal.timeout(45000) });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  if (r.headers.get('access-control-allow-origin') !== '*') throw new Error('Missing CORS');
  return r.json();
}
const manifest = await get('/manifest.json');
if (!manifest.resources?.length) throw new Error('Invalid manifest');
console.log('PASS manifest');
const catalog = await get('/catalog/movie/nguonc-new.json');
if (!Array.isArray(catalog.metas) || !catalog.metas.length) throw new Error('Empty or invalid catalog');
console.log('PASS live catalog:', catalog.metas.length, 'items');
const item = catalog.metas[0];
const { meta } = await get(`/meta/${item.type}/${encodeURIComponent(item.id)}.json`);
if (!meta?.id) throw new Error('Invalid metadata');
console.log('PASS live metadata');
const id = item.type === 'series' ? meta.videos?.[0]?.id : meta.id;
if (!id) throw new Error('No selectable episode');
const data = await get(`/stream/${item.type}/${encodeURIComponent(id)}.json`);
if (!Array.isArray(data.streams)) throw new Error('Invalid stream response');
console.log('Stream candidates:', data.streams.length);
if (!data.streams.length) {
  console.log('SOURCE LIMITATION: no accessible direct/HLS link.');
  console.log(JSON.stringify(await get(`/diagnose/${item.type}/${encodeURIComponent(id)}.json`), null, 2));
  process.exitCode = 2;
} else console.log('PASS stream response. Playback must still be checked in Stremio; this script does not download video.');
