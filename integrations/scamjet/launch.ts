 ROBLOX_HOST = /^(?:(?:play|www)\.)?roblox\.com$|^play\.sitetest[1-3]\.robloxlabs\.com$/i;
const ID = /^[1-9]\d{0,18}$/;
const SERVER_ID = /^[A-Za-z0-9-]{1,64}$/;
const PROTOCOL = /^(roblox-player|roblox-client|roblox)(?:-sitetest([1-3]))?:/i;
const ROBLOX_SCHEME = /^roblox:\/\/(?:experiences\/start\??|navigation\/game_details\??|)(.*)$/i;
const LAUNCHER_HOST = /(^|\.)(roblox\.com|robloxlabs\.com)$/i;
const LAUNCHER_PATH = /\/game\/placelauncher\.ashx$/i;
const GAME_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IN_GAME = 2;

export type BloxLaunch = { placeId: string; serverId?: string };

export type BloxFollow = { userId: string; domain: string };

type Protocol = { domain: string; launcher: URL };

function param(params: URLSearchParams, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of params) if (key.toLowerCase() === wanted) return value;
  return undefined;
}

function launchFrom(placeId: string | undefined, serverId: string | undefined): BloxLaunch | null {
  if (placeId === undefined || !ID.test(placeId)) return null;
  return serverId && SERVER_ID.test(serverId) ? { placeId, serverId } : { placeId };
}

function parseProtocol(raw: string): Protocol | null {
  const match = PROTOCOL.exec(raw);
  if (!match) return null;
  const domain = match[2] ? `sitetest${match[2]}.robloxlabs.com` : "roblox.com";
  const fields = new Map<string, string>();
  for (const part of raw.slice(match[0].length).split("+")) {
    const colon = part.indexOf(":");
    if (colon > 0) fields.set(part.slice(0, colon).toLowerCase(), part.slice(colon + 1));
  }
  if ((fields.get("launchmode") ?? "play").toLowerCase() !== "play") return null;
  const target = fields.get("placelauncherurl");
  if (!target) return null;
  let launcher: URL;
  try {
    launcher = new URL(decodeURIComponent(target));
  } catch {
    return null;
  }
  if (launcher.protocol !== "https:" && launcher.protocol !== "http:") return null;
  if (!LAUNCHER_HOST.test(launcher.hostname) || !LAUNCHER_PATH.test(launcher.pathname)) return null;
  return { domain, launcher };
}

export function isProtocolUri(raw: string): boolean {
  return PROTOCOL.test(raw);
}

export function parseGamesStart(raw: string): BloxLaunch | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!ROBLOX_HOST.test(url.hostname) || url.port !== "" || url.username !== "" || url.password !== "") return null;
  if (url.pathname.replace(/\/+$/, "").toLowerCase() !== "/games/start") return null;
  return launchFrom(param(url.searchParams, "placeId"), param(url.searchParams, "gameInstanceId"));
}

export function parseLaunchUri(raw: string): BloxLaunch | null {
  if (/^roblox:\/\//i.test(raw)) {
    const match = ROBLOX_SCHEME.exec(raw);
    if (!match) return null;
    const params = new URLSearchParams(match[1]);
    return launchFrom(param(params, "placeId"), param(params, "gameInstanceId") ?? param(params, "gameId"));
  }
  const protocol = parseProtocol(raw);
  if (!protocol) return null;
  const request = param(protocol.launcher.searchParams, "request");
  const placeId = param(protocol.launcher.searchParams, "placeId");
  if (request === "RequestGame") return launchFrom(placeId, undefined);
  if (request !== "RequestGameJob") return null;
  const serverId = param(protocol.launcher.searchParams, "gameId") ?? param(protocol.launcher.searchParams, "jobId");
  return serverId ? launchFrom(placeId, serverId) : null;
}

export function parseFollowUri(raw: string): BloxFollow | null {
  const protocol = parseProtocol(raw);
  if (!protocol || param(protocol.launcher.searchParams, "request") !== "RequestFollowUser") return null;
  const userId = param(protocol.launcher.searchParams, "userId");
  return userId !== undefined && ID.test(userId) ? { userId, domain: protocol.domain } : null;
}

export class FollowError extends Error {
  constructor(readonly reason: "not-playing" | "unreachable") {
    super(reason);
  }
}

export type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

function postPresence(fetcher: Fetcher, url: string, body: string, csrf?: string): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (csrf) headers["x-csrf-token"] = csrf;
  return fetcher(url, { method: "POST", credentials: "include", headers, body });
}

export async function lookupFollow(fetcher: Fetcher, follow: BloxFollow): Promise<BloxLaunch> {
  const url = `https://presence.${follow.domain}/v1/presence/users`;
  const body = JSON.stringify({ userIds: [Number(follow.userId)] });
  let response: Response;
  try {
    response = await postPresence(fetcher, url, body);
    const csrf = response.status === 403 ? response.headers.get("x-csrf-token") : null;
    if (csrf) response = await postPresence(fetcher, url, body, csrf);
  } catch {
    throw new FollowError("unreachable");
  }
  if (!response.ok) throw new FollowError("unreachable");
  let presence: unknown;
  try {
    const data: unknown = await response.json();
    const list = data && typeof data === "object" && "userPresences" in data ? data.userPresences : undefined;
    presence = Array.isArray(list) ? list[0] : undefined;
  } catch {
    throw new FollowError("unreachable");
  }
  if (!presence || typeof presence !== "object" || !("userPresenceType" in presence) || presence.userPresenceType !== IN_GAME) {
    throw new FollowError("not-playing");
  }
  const rawPlace = "placeId" in presence ? presence.placeId : undefined;
  const placeId = typeof rawPlace === "number" || typeof rawPlace === "string" ? String(rawPlace) : "";
  if (!ID.test(placeId)) throw new FollowError("not-playing");
  const gameId = "gameId" in presence ? presence.gameId : undefined;
  return typeof gameId === "string" && GAME_ID.test(gameId) ? { placeId, serverId: gameId } : { placeId };
}
