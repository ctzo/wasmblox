const CHANNEL = "blox-signin";
const LOGIN_URL = "https://www.roblox.com/login";

export type BloxSignInFrame = {
  prefix: string;
  element: { src: string };
  go(url: string): void;
};

export type BloxSignInController = {
  config?: { codec?: { encode?(url: string): string } };
  createFrame(): BloxSignInFrame;
};

export type BloxSignInOptions = {
  base?: string | URL;
  url?: string;
};

export function proxiedUrl(
  controller: Pick<BloxSignInController, "config">,
  frame: BloxSignInFrame,
  url: string,
  base: string | URL,
): string | null {
  const encode = controller.config?.codec?.encode;
  let target = "";
  if (typeof frame.prefix === "string" && frame.prefix && typeof encode === "function") {
    try {
      target = frame.prefix + encode(url);
    } catch {
      target = "";
    }
  }
  if (!target) {
    try {
      frame.go(url);
      target = typeof frame.element?.src === "string" ? frame.element.src : "";
    } catch {
      target = "";
    }
  }
  if (!target) return null;
  let proxied: URL;
  try {
    proxied = new URL(target, base);
    if (proxied.origin !== new URL(base).origin) return null;
  } catch {
    return null;
  }
  return proxied.href;
}

export function installBloxSignIn(controller: BloxSignInController, options: BloxSignInOptions = {}): () => void {
  const Channel = globalThis.BroadcastChannel;
  if (typeof Channel !== "function") return () => {};
  const base = options.base ?? globalThis.location?.href ?? "http://localhost/";
  const login = options.url ?? LOGIN_URL;
  const channel = new Channel(CHANNEL);
  const origin = new URL(base).origin;
  channel.onmessage = ({ data }: MessageEvent) => {
    const message = data as { type?: unknown; id?: unknown; origin?: unknown } | null;
    if (!message || typeof message !== "object" || message.type !== "blox-signin-request" || typeof message.id !== "string") return;
    if (message.origin !== origin) return;
    let url: string | null = null;
    try {
      const frame = controller.createFrame();
      try {
        frame.go(login);
      } catch {
      }
      url = proxiedUrl(controller, frame, login, base);
    } catch {
      url = null;
    }
    channel.postMessage(url ? { type: "blox-signin-opened", id: message.id, url } : { type: "blox-signin-failed", id: message.id });
  };
  return () => channel.close();
}
