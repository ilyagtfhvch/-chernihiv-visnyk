/**
 * Cloudflare Worker: server-side proxy for Alerts.in.ua.
 * Keep ALERTS_IN_UA_TOKEN in Worker Secrets, never in public HTML.
 * Upstream calls are cached to respect Alerts.in.ua rate limits.
 */
const UPSTREAM = "https://api.alerts.in.ua/v1/alerts/active.json";
const CACHE_SECONDS = 60; // upstream API limit is roughly 8-10 requests/minute per IP
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") {
      return json({ ok: true, service: "chernihiv-visnyk-api", time: new Date().toISOString() }, 200, request);
    }
    if (url.pathname !== "/api/active") return new Response("Not found", { status: 404 });
    if (!env.ALERTS_IN_UA_TOKEN) return json({ error: "Не налаштовано ALERTS_IN_UA_TOKEN у Secrets сервера." }, 503, request);

    const cache = caches.default;
    const cacheKey = new Request(new URL("/__cache/alerts-active", url.origin).toString(), { method: "GET" });
    const cached = await cache.match(cacheKey);
    if (cached) {
      const cloned = new Response(cached.body, cached);
      cloned.headers.set("X-Data-Cache", "HIT");
      return cors(cloned, request);
    }

    try {
      const upstream = await fetch(UPSTREAM, {
        headers: { "Authorization": `Bearer ${env.ALERTS_IN_UA_TOKEN}`, "Accept": "application/json" },
        cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true }
      });
      if (!upstream.ok) {
        const detail = await upstream.text();
        return json({ error: `Alerts.in.ua повернув HTTP ${upstream.status}. Перевірте токен, ліміт запитів або доступність сервісу.`, upstreamStatus: upstream.status, detail: detail.slice(0, 300) }, upstream.status === 429 ? 429 : 502, request);
      }
      const data = await upstream.json();
      const payload = { data, fetchedAt: new Date().toISOString(), source: "Alerts.in.ua", cacheSeconds: CACHE_SECONDS };
      const response = json(payload, 200, request);
      response.headers.set("Cache-Control", `public, max-age=${CACHE_SECONDS}`);
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
      return cors(response, request);
    } catch (e) {
      return json({ error: "Не вдалося підключитися до Alerts.in.ua. Перевірте мережу та налаштування.", detail: String(e).slice(0, 200) }, 502, request);
    }
  }
};
function json(value, status, request) {
  return cors(new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } }), request);
}
function cors(response, request) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", new URL(request.url).origin);
  headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}