// Only cache explicitly public anonymous GETs. Moderation and personal access
// always reach the origin.
const routes = new Set([
  '/api/garage/folders', '/api/garage/members', '/api/market/listings',
  '/api/club/notifications', '/api/club/events', '/api/club/news',
  '/api/gallery/folders', '/api/analytics/config'
]);
const fallbackRoutes = new Set(['/api/club/events', '/api/club/news']);
const freshSeconds = 60;
const fallbackSeconds = 300;
const capturedAt = 'X-Club-Cache-Captured-At';

// Photos and videos stored in D1. Each file id is fixed once uploaded, so
// anonymous visitors can keep a copy instead of asking D1 again for the same
// bytes every time a carousel or page shows it. Content that moderation can
// hide or that keeps the same address after an edit gets a short lifetime.
const mediaRules = [
  [/^\/api\/gallery\/photos\/[^/]+$/, 86400],
  [/^\/api\/market\/photos\/[^/]+$/, 86400],
  [/^\/api\/cms\/media\/[^/]+$/, 86400],
  [/^\/api\/bricos\/media\/[^/]+$/, 86400],
  [/^\/api\/club\/events\/[^/]+\/photo$/, 3600],
  [/^\/api\/garage\/photos\/[^/]+$/, 600],
  [/^\/api\/garage\/profiles\/[^/]+\/photo$/, 600]
];

function mediaSeconds(url) {
  // Only a version marker may vary the address; previews and measurements skip the cache.
  if ([...url.searchParams.keys()].some(key => key !== 'v')) return 0;
  return mediaRules.find(([pattern]) => pattern.test(url.pathname))?.[1] || 0;
}

function anonymous(request) {
  return !request.headers.has('authorization') &&
    !/(?:^|;\s*)(?:club_session|club_member_session)=/.test(request.headers.get('cookie') || '');
}

function sharedMedia(response, seconds) {
  const headers = new Headers(response.headers);
  headers.delete(capturedAt);
  headers.set('Cache-Control', 'public, max-age=' + seconds);
  return new Response(response.body, {status: response.status, headers});
}

async function withMediaCache(request, cache, next, seconds) {
  const url = new URL(request.url);
  const key = new Request(url.href);
  if (request.method !== 'GET') {
    const response = await next();
    if (response.ok && request.method === 'DELETE') { try { await cache?.delete(key); } catch {} }
    return response;
  }
  if (!anonymous(request)) return next();
  // Video ranges are streamed in pieces; the browser keeps them, the edge does not.
  const ranged = request.headers.has('range');
  if (cache && !ranged) {
    let hit;
    try { hit = await cache.match(key); } catch {}
    const stamp = Number(hit?.headers.get(capturedAt));
    if (hit && stamp && (Date.now() - stamp) / 1000 < seconds) return sharedMedia(hit, seconds);
  }
  const response = await next();
  if (![200, 206].includes(response.status) || response.headers.has('Set-Cookie')) return response;
  if (cache && !ranged && response.status === 200 && Number(response.headers.get('Content-Length') || 0) <= 5 * 1048576) {
    const headers = new Headers(response.headers);
    headers.set(capturedAt, String(Date.now()));
    headers.set('Cache-Control', 'public, max-age=' + seconds);
    try { await cache.put(key, new Response(response.clone().body, {status: 200, headers})); } catch {}
  }
  return sharedMedia(response, seconds);
}

function publicResponse(response, stale = false) {
  const headers = new Headers(response.headers);
  headers.delete(capturedAt);
  headers.set('Cache-Control', 'no-store');
  if (stale) headers.set('X-Club-Data-Stale', '1');
  return new Response(response.body, {status: response.status, headers});
}

export async function withPublicCache(request, cache, next) {
  const url = new URL(request.url);
  const media = mediaSeconds(url);
  if (media) return withMediaCache(request, cache, next, media);
  if (!cache) return next();

  // Publish successful edits immediately at the edge serving the update.
  const eventChange = ['POST', 'DELETE'].includes(request.method) &&
    /^\/api\/club\/events(?:\/[^/]+)?$/.test(url.pathname);
  const marketChange = request.method === 'POST' &&
    /^\/api\/admin\/listings\/[^/]+(?:\/edit)?$/.test(url.pathname);
  if (eventChange || marketChange) {
    const response = await next();
    if (response.ok) {
      const path = eventChange ? '/api/club/events' : '/api/market/listings';
      try { await cache.delete(new Request(url.origin + path)); } catch {}
    }
    return response;
  }

  if (request.method !== 'GET' || request.headers.has('authorization') ||
      /(?:^|;\s*)(?:club_session|club_member_session)=/.test(request.headers.get('cookie') || '') ||
      !routes.has(url.pathname)) return next();

  // Review/manage/preview requests never share a cache entry.
  const params = [...url.searchParams.keys()];
  if (params.length && (url.pathname !== '/api/garage/members' || params.length !== 1 || params[0] !== 'folder')) return next();

  const key = new Request(url.href);
  const allowFallback = fallbackRoutes.has(url.pathname);
  let hit;
  try { hit = await cache.match(key); } catch {}
  if (hit) {
    const stamp = Number(hit.headers.get(capturedAt));
    const age = stamp ? (Date.now() - stamp) / 1000 : 0;
    if (age < freshSeconds) return publicResponse(hit);
    if (!allowFallback || age >= fallbackSeconds) hit = null;
  }

  const response = await next();
  if (hit && response.status >= 500) return publicResponse(hit, true);
  if (response.status === 200 && !response.headers.has('Set-Cookie')) {
    const headers = new Headers(response.headers);
    headers.set(capturedAt, String(Date.now()));
    headers.set('Cache-Control', 'public, max-age=' + (allowFallback ? fallbackSeconds : freshSeconds));
    try { await cache.put(key, new Response(response.clone().body, {status: 200, headers})); } catch {}
  }
  return response;
}
