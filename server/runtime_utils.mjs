/**
 * Zero-dependency cross-platform process-tree terminator & optional HTTP/HTTPS proxy fetcher.
 *
 * Design guarantees:
 *  - On Windows, `proc.kill()` only terminates the outer cmd/powershell wrapper and leaks
 *    grandchild processes (`claude.exe`, `npx` MCP servers, shell pipelines). `killProcessTree`
 *    cleanly reaps the entire process tree via `taskkill /PID <pid> /T /F`.
 *  - `proxyFetch` honors user-configured `proxyUrl` (e.g. `http://127.0.0.1:7897`) for outbound
 *    GET requests (stores, wallpaper proxy, GitHub release check) WITHOUT mutating `process.env.HTTP_PROXY`
 *    or interfering with localhost / direct API traffic.
 */

import { spawn } from "node:child_process";
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import tls from "node:tls";
import { isSafePublicUrl } from "./security.mjs";

export function killProcessTree(proc, gracefulSignal = "SIGTERM", forceDelayMs = 1500) {
  if (!proc || proc.exitCode !== null) return;
  const pid = proc.pid;
  if (!pid) {
    try {
      proc.kill(gracefulSignal);
    } catch {}
    return;
  }

  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("error", () => {
        try {
          proc.kill();
        } catch {}
      });
      killer.unref();
    } catch {
      try {
        proc.kill();
      } catch {}
    }
    return;
  }

  // On Linux/macOS, kill process group (-pid) first when spawned detached, then fallback to pid
  const signalGroupOrPid = (sig) => {
    try {
      process.kill(-pid, sig);
      return;
    } catch {}
    try {
      proc.kill(sig);
    } catch {}
  };

  signalGroupOrPid(gracefulSignal);
  if (forceDelayMs > 0) {
    const t = setTimeout(() => {
      if (proc.exitCode === null) {
        signalGroupOrPid("SIGKILL");
      }
    }, forceDelayMs);
    t.unref?.();
  }
}

function normalizeProxyUrl(rawProxy) {
  const s = String(rawProxy || "").trim();
  if (!s) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `http://${s}`);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u;
  } catch {
    return null;
  }
}

function shouldBypassProxy(targetUrl) {
  try {
    const h = new URL(targetUrl).hostname.toLowerCase();
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]" || h.endsWith(".local");
  } catch {
    return true;
  }
}

function rawGetViaHttpProxy(
  targetUrl,
  proxyUrlObj,
  { headers = {}, signal = null, maxRedirects = 4, maxBytes = 40 * 1024 * 1024, streamBody = false } = {},
) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("The operation was aborted"));
    if (!isSafePublicUrl(targetUrl)) {
      return reject(new Error("拒绝通过代理请求非公开本地/内网地址"));
    }

    const target = new URL(targetUrl);
    const proxyHost = proxyUrlObj.hostname;
    const proxyPort = Number(proxyUrlObj.port) || (proxyUrlObj.protocol === "https:" ? 443 : 80);
    const proxyAuth =
      proxyUrlObj.username || proxyUrlObj.password
        ? `Basic ${Buffer.from(`${decodeURIComponent(proxyUrlObj.username)}:${decodeURIComponent(proxyUrlObj.password)}`).toString("base64")}`
        : "";

    let settled = false;
    let activeReq = null;
    let activeSocket = null;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanupAbort();
      try { activeReq?.destroy(); } catch {}
      try { activeSocket?.destroy(); } catch {}
      reject(err);
    };

    const onAbort = () => fail(new Error("The operation was aborted"));
    const cleanupAbort = () => {
      if (signal) signal.removeEventListener("abort", onAbort);
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    const handleHttpResponse = (res) => {
      const status = res.statusCode || 0;
      const loc = res.headers.location;
      if ([301, 302, 303, 307, 308].includes(status) && loc && maxRedirects > 0) {
        res.resume();
        cleanupAbort();
        settled = true;
        let nextUrl;
        try {
          nextUrl = new URL(loc, targetUrl).toString();
        } catch {
          return reject(new Error("重定向地址格式无效"));
        }
        if (!isSafePublicUrl(nextUrl)) {
          return reject(new Error("已阻止重定向至本地或内网保留地址"));
        }
        rawGetViaHttpProxy(nextUrl, proxyUrlObj, {
          headers,
          signal,
          maxRedirects: maxRedirects - 1,
          maxBytes,
          streamBody,
        }).then(resolve, reject);
        return;
      }

      const hdrMap = new Map(
        Object.entries(res.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(", ") : String(v ?? "")]),
      );

      // True streaming body mode (used by large tarball/installer downloads with real-time progress)
      if (streamBody) {
        settled = true;
        res.on("error", () => {
          try { activeSocket?.destroy(); } catch {}
        });
        const webStream = Readable.toWeb(res);
        resolve({
          ok: status >= 200 && status < 300,
          status,
          headers: {
            get: (name) => hdrMap.get(String(name || "").toLowerCase()) ?? null,
          },
          body: webStream,
        });
        return;
      }

      const chunks = [];
      let total = 0;
      res.on("data", (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          fail(new Error(`响应体超过 ${Math.round(maxBytes / (1024 * 1024))}MB 上限`));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        if (settled) return;
        if (!res.complete) {
          fail(new Error("网络连接提前中断，响应数据不完整"));
          return;
        }
        settled = true;
        cleanupAbort();
        const buf = Buffer.concat(chunks);
        resolve({
          ok: status >= 200 && status < 300,
          status,
          headers: {
            get: (name) => hdrMap.get(String(name || "").toLowerCase()) ?? null,
          },
          body: Readable.toWeb(Readable.from([buf])),
          arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
          text: async () => buf.toString("utf8"),
          json: async () => JSON.parse(buf.toString("utf8")),
        });
      });
      res.on("error", fail);
    };

    if (target.protocol === "http:") {
      const reqHeaders = { ...headers, Host: target.host };
      if (proxyAuth) reqHeaders["Proxy-Authorization"] = proxyAuth;
      activeReq = http.request(
        {
          host: proxyHost,
          port: proxyPort,
          method: "GET",
          path: target.toString(),
          headers: reqHeaders,
        },
        handleHttpResponse,
      );
      activeReq.on("error", fail);
      activeReq.end();
      return;
    }

    // HTTPS over HTTP CONNECT tunnel
    const targetPort = Number(target.port) || 443;
    const connectHeaders = { Host: `${target.hostname}:${targetPort}` };
    if (proxyAuth) connectHeaders["Proxy-Authorization"] = proxyAuth;

    const connectReq = http.request({
      host: proxyHost,
      port: proxyPort,
      method: "CONNECT",
      path: `${target.hostname}:${targetPort}`,
      headers: connectHeaders,
    });
    activeReq = connectReq;

    connectReq.on("connect", (connectRes, socket) => {
      activeSocket = socket;
      socket.on("error", fail);
      if (connectRes.statusCode !== 200) {
        fail(new Error(`代理 CONNECT 失败 (HTTP ${connectRes.statusCode})`));
        return;
      }
      const tlsSocket = tls.connect({
        socket,
        servername: target.hostname,
      });
      activeSocket = tlsSocket;
      tlsSocket.on("error", fail);

      const httpsReq = https.request(
        {
          hostname: target.hostname,
          port: targetPort,
          path: `${target.pathname}${target.search}`,
          method: "GET",
          headers: { ...headers, Host: target.host },
          createConnection: () => tlsSocket,
        },
        handleHttpResponse,
      );
      activeReq = httpsReq;
      httpsReq.on("error", fail);
      httpsReq.end();
    });
    connectReq.on("error", fail);
    connectReq.end();
  });
}

/**
 * Drop-in GET fetch wrapper that uses `proxyUrl` when configured, or falls back to native `fetch`.
 */
export async function proxyFetch(
  url,
  { headers = {}, signal = null, proxyUrl = "", maxBytes = 40 * 1024 * 1024, streamBody = false } = {},
) {
  const parsedProxy = normalizeProxyUrl(proxyUrl);
  if (!parsedProxy || shouldBypassProxy(url)) {
    return await fetch(url, { headers, signal });
  }
  return await rawGetViaHttpProxy(url, parsedProxy, { headers, signal, maxBytes, streamBody });
}
