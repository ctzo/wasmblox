const SCOPE = new URL(self.registration.scope);
const PINNED_FLAGS = new URL("engine/PinnedFlags.json", SCOPE).href;
const DIRECT_HOSTS = new Set(["cdnjs.cloudflare.com"]);
const FLAGS_URL = /^https:\/\/clientsettingscdn\.roblox\.com\/v2\/settings\/application\/WebClientApp(?:\/bucket\/[^?#]*)?(?:[?#]|$)/;
const NULL_BODY = new Set([101, 103, 204, 205, 304]);
const RELAY_TIMEOUT_MS = 120_000;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (!/^https?:/.test(request.url) || url.origin === self.location.origin || DIRECT_HOSTS.has(url.hostname)) return;
  event.respondWith(crossOrigin(request, event.clientId));
});

async function crossOrigin(request, clientId) {
  if (request.method === "GET" && FLAGS_URL.test(request.url)) {
    const pinned = await fetch(PINNED_FLAGS, { cache: "no-cache" }).catch(() => null);
    if (pinned?.ok) return reply(200, "", [["content-type", "application/json"]], await pinned.arrayBuffer());
  }
  try {
    const body = request.method === "GET" || request.method === "HEAD" ? null : await request.arrayBuffer();
    const result = await relay(clientId, {
      url: request.url,
      method: request.method,
      headers: [...request.headers],
      body,
    });
    return reply(result.status, result.statusText, result.headers, result.body);
  } catch (error) {
    return reply(502, "Bad Gateway", [["content-type", "application/json"]], JSON.stringify({ error: String(error?.message || error) }));
  }
}

function reply(status, statusText, headers, body) {
  const out = new Headers(headers);
  out.set("cross-origin-resource-policy", "cross-origin");
  out.set("access-control-allow-origin", self.location.origin);
  out.set("access-control-allow-credentials", "true");
  const names = [...new Set([...out.keys()])].join(", ");
  if (names) out.set("access-control-expose-headers", names);
  return new Response(NULL_BODY.has(status) ? null : body, { status, statusText, headers: out });
}
async function relayPage(clientId) {
  const own = clientId ? await self.clients.get(clientId) : null;
  if (own?.type === "window") return own;
  const pages = await self.clients.matchAll({ type: "window" });
  const page = pages.find((client) => client.frameType === "top-level") ?? pages[0];
  if (!page) throw new Error("no page to relay through");
  return page;
}

async function relay(clientId, message) {
  const page = await relayPage(clientId);
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      reject(new Error("relay timed out"));
    }, RELAY_TIMEOUT_MS);
    channel.port1.onmessage = ({ data }) => {
      clearTimeout(timer);
      channel.port1.close();
      if (data.ok) resolve(data);
      else reject(new Error(data.error));
    };
    const transfer = message.body ? [channel.port2, message.body] : [channel.port2];
    page.postMessage({ type: "blox-fetch", ...message }, transfer);
  });
}
