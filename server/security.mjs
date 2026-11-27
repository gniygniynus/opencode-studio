/**
 * Unified Security, SSRF Protection, Constant-Time Auth & Crash-Safe Range Streaming Primitives.
 */

import crypto from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { pipeline } from "node:stream";

export const INTERNAL_PROXY_TOKEN = crypto.randomBytes(24).toString("hex");

export function safeTokenEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function extractInternalTokenFromReq(req) {
  const custom = req?.headers?.["x-ocs-internal-token"] || req?.headers?.["x-api-key"];
  if (typeof custom === "string" && custom.trim()) return custom.trim();
  const auth = String(req?.headers?.authorization || "");
  if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, "").trim();
  return "";
}

export function isValidInternalRequest(req) {
  return safeTokenEqual(extractInternalTokenFromReq(req), INTERNAL_PROXY_TOKEN);
}

export function parseCookies(cookieHeader) {
  const out = Object.create(null);
  const raw = String(cookieHeader || "");
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export function capMapSize(map, maxEntries = 200) {
  while (map.size > maxEntries) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
}

export function atomicWriteFileSync(filePath, data, options = "utf8") {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(tmpPath, data, options);
    try {
      fs.renameSync(tmpPath, filePath);
    } catch {
      fs.writeFileSync(filePath, data, options);
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

function isPrivateIpv4(ip) {
  const parts = ip.split(".").map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

export function isPrivateOrLoopbackIp(rawIp) {
  const ip = String(rawIp || "").trim().replace(/^\[|\]$/g, "").toLowerCase();
  if (!ip) return true;
  const v = net.isIP(ip);
  if (v === 4) return isPrivateIpv4(ip);
  if (v === 6) {
    if (ip === "::1" || ip === "::" || ip === "0:0:0:0:0:0:0:1" || ip === "0:0:0:0:0:0:0:0") return true;
    if (ip.startsWith("fc") || ip.startsWith("fd")) return true; // fc00::/7 Unique Local
    if (/^fe[89ab]/.test(ip)) return true; // fe80::/10 Link-Local
    if (ip.startsWith("::ffff:")) {
      const tail = ip.slice(7);
      if (net.isIP(tail) === 4) return isPrivateIpv4(tail);
      const hexMatch = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
      if (hexMatch) {
        const hi = parseInt(hexMatch[1], 16);
        const lo = parseInt(hexMatch[2], 16);
        const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
        return isPrivateIpv4(v4);
      }
      return true;
    }
    return false;
  }
  return false;
}

export function isSafePublicUrl(rawUrl) {
  try {
    const u = new URL(String(rawUrl || "").trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (!host) return false;
    if (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      host.endsWith(".internal") ||
      host === "metadata.google.internal"
    ) {
      return false;
    }
    if (net.isIP(host)) {
      return !isPrivateOrLoopbackIp(host);
    }
    return true;
  } catch {
    return false;
  }
}

export async function assertSafePublicUrlResolved(rawUrl, skipDns = false) {
  if (!isSafePublicUrl(rawUrl)) {
    throw new Error("目标链接属于受保护的本地/内网地址或非法协议，已安全拦截");
  }
  if (skipDns) return true;
  const u = new URL(String(rawUrl).trim());
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) return true;
  try {
    const records = await dns.lookup(host, { all: true, verbatim: true });
    if (!records.length) throw new Error("域名无法解析");
    for (const r of records) {
      if (isPrivateOrLoopbackIp(r.address)) {
        throw new Error(`域名 ${host} 解析到了本地或内网保留地址 (${r.address})，已安全拦截`);
      }
    }
  } catch (err) {
    if (err.message.includes("安全拦截")) throw err;
    // Allow caller's proxy fetcher to handle DNS when direct local DNS cannot resolve external hosts behind proxy
  }
  return true;
}

/**
 * Fetch wrapper for upstream LLM API calls carrying sensitive `Authorization` / `x-api-key`.
 * Never leaks custom `x-api-key` headers across cross-origin 30x redirects!
 */
export async function fetchUpstreamWithSafeRedirects(url, init = {}, maxHops = 3) {
  let curUrl = url;
  const origHost = new URL(url).hostname.toLowerCase();
  let curMethod = (init.method || "POST").toUpperCase();
  let curBody = init.body;

  for (let hop = 0; hop <= maxHops; hop++) {
    const res = await fetch(curUrl, {
      ...init,
      method: curMethod,
      body: curBody,
      redirect: "manual",
    });
    if (![301, 302, 303, 307, 308].includes(res.status)) {
      return res;
    }
    const loc = res.headers.get("location");
    try { await res.body?.cancel(); } catch {}
    if (!loc || hop === maxHops) {
      throw new Error(`上游 API 返回未完成重定向 (HTTP ${res.status})`);
    }
    const nextUrlObj = new URL(loc, curUrl);
    if (nextUrlObj.protocol !== "https:" && nextUrlObj.protocol !== "http:") {
      throw new Error(`上游 API 重定向协议不安全: ${nextUrlObj.protocol}`);
    }
    if (nextUrlObj.hostname.toLowerCase() !== origHost) {
      throw new Error(`已阻止跨域名 API 重定向 (${origHost} -> ${nextUrlObj.hostname})，防止泄露 API 密钥`);
    }
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && curMethod === "POST")) {
      curMethod = "GET";
      curBody = undefined;
    }
    curUrl = nextUrlObj.toString();
  }
  throw new Error("上游 API 重定向次数过多");
}

function nearestExistingRealPath(p) {
  let cur = path.resolve(p);
  const tailParts = [];
  while (true) {
    if (fs.existsSync(cur)) {
      const realBase = fs.realpathSync(cur);
      return tailParts.length ? path.join(realBase, ...tailParts.reverse()) : realBase;
    }
    const parent = path.dirname(cur);
    if (parent === cur) return path.resolve(p);
    tailParts.push(path.basename(cur));
    cur = parent;
  }
}

export function isRealPathInsideDir(targetPath, rootDir) {
  if (!targetPath || !rootDir) return false;
  try {
    const realTarget = nearestExistingRealPath(targetPath);
    const realRoot = nearestExistingRealPath(rootDir);
    const normTarget = process.platform === "win32" ? realTarget.toLowerCase() : realTarget;
    const normRoot = process.platform === "win32" ? realRoot.toLowerCase() : realRoot;
    const rootWithSep = normRoot.endsWith(path.sep) ? normRoot : normRoot + path.sep;
    return normTarget === normRoot || normTarget.startsWith(rootWithSep);
  } catch {
    return false;
  }
}

/**
 * Crash-safe HTTP 200 / 206 / 416 file & slice streamer using `stream.pipeline`.
 * Automatically cleans up file descriptors on client disconnect and never crashes on stream errors.
 */
export function streamFileWithRange(
  req,
  res,
  filePath,
  {
    contentType = "application/octet-stream",
    cacheControl = "no-cache",
    extraHeaders = {},
    sliceStart = 0,
    sliceLength = null,
    supportRange = true,
  } = {},
) {
  let st;
  try {
    st = fs.statSync(filePath);
    if (!st.isFile()) {
      res.writeHead(404);
      return res.end("Not Found");
    }
  } catch {
    res.writeHead(404);
    return res.end("Not Found");
  }

  const baseStart = Math.max(0, Number(sliceStart) || 0);
  if (baseStart > st.size) {
    res.writeHead(416, { "Content-Range": "bytes */0" });
    return res.end();
  }
  const total =
    sliceLength !== null && sliceLength !== undefined
      ? Math.max(0, Math.min(Number(sliceLength) || 0, st.size - baseStart))
      : st.size - baseStart;

  const baseHeaders = {
    "Content-Type": contentType,
    "Cache-Control": cacheControl,
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  };

  if (total === 0) {
    res.writeHead(200, { ...baseHeaders, "Content-Length": 0 });
    return res.end();
  }

  const rangeHeader = supportRange ? req?.headers?.range : "";
  if (rangeHeader && /^bytes=/i.test(rangeHeader)) {
    const m = String(rangeHeader).match(/bytes=(\d*)-(\d*)/i);
    if (!m || (!m[1] && !m[2])) {
      res.writeHead(416, { "Content-Range": `bytes */${total}` });
      return res.end();
    }
    let start;
    let end;
    if (!m[1] && m[2]) {
      const suffixLen = Number(m[2]);
      if (!Number.isSafeInteger(suffixLen) || suffixLen <= 0) {
        res.writeHead(416, { "Content-Range": `bytes */${total}` });
        return res.end();
      }
      start = Math.max(0, total - suffixLen);
      end = total - 1;
    } else {
      start = Number(m[1]);
      end = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
    }

    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= total || start > end) {
      res.writeHead(416, { "Content-Range": `bytes */${total}` });
      return res.end();
    }

    res.writeHead(206, {
      ...baseHeaders,
      "Content-Range": `bytes ${start}-${end}/${total}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
    });
    const rs = fs.createReadStream(filePath, { start: baseStart + start, end: baseStart + end });
    pipeline(rs, res, () => {});
    return;
  }

  res.writeHead(200, {
    ...baseHeaders,
    ...(supportRange ? { "Accept-Ranges": "bytes" } : {}),
    "Content-Length": total,
  });
  const rs = fs.createReadStream(filePath, { start: baseStart, end: baseStart + total - 1 });
  pipeline(rs, res, () => {});
}
