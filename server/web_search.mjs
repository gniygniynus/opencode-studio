/**
 * Built-in Zero-API-Key Dual-Engine Web Search & Clean Page Reader.
 *
 * Works out-of-the-box for BOTH domestic direct networks (China, zero VPN) and global proxy environments:
 *  - Domestic Direct ("cn"): Bing CN Search RSS + Bing CN News RSS (~220ms, clean direct URLs & snippets).
 *  - Global Proxy ("proxy"): DuckDuckGo HTML + Bing Global RSS in parallel, honoring `search_engine.proxy_url`.
 *  - Auto ("auto"): Picks optimal engine via cached reachability probe and falls back automatically.
 */

import { getAllSettings } from "./db.mjs";
import { proxyFetch } from "./runtime_utils.mjs";
import { assertSafePublicUrlResolved, isSafePublicUrl } from "./security.mjs";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function decodeXmlEntities(str) {
  return String(str || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

function stripHtmlTags(str) {
  return decodeXmlEntities(str)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseRssSearchItems(xmlText, sourceLabel = "Bing") {
  const out = [];
  const raw = String(xmlText || "");
  for (const m of raw.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const block = m[1];
    const title = stripHtmlTags(block.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || "");
    let link = decodeXmlEntities(block.match(/<link>([\s\S]*?)<\/link>/i)?.[1] || "").trim();
    const desc = stripHtmlTags(block.match(/<description>([\s\S]*?)<\/description>/i)?.[1] || "");
    const pubDate = stripHtmlTags(block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1] || "");

    // Unwrap Bing news redirect URLs (`url=https%3a%2f%2f...`) if present
    if (link.includes("bing.com/news/apiclick.aspx") && link.includes("url=")) {
      try {
        const u = new URL(link);
        const real = u.searchParams.get("url");
        if (real && /^https?:\/\//i.test(real)) link = real;
      } catch {}
    }

    if (!title || !/^https?:\/\//i.test(link)) continue;
    out.push({
      title,
      url: link,
      snippet: desc,
      published: pubDate,
      source: sourceLabel,
    });
  }
  return out;
}

export function parseDuckDuckGoHtmlItems(htmlText) {
  const out = [];
  const raw = String(htmlText || "");
  const blocks = raw.split(/<div[^>]*\bclass="[^"]*\bresult\b(?![_-])/i).slice(1);
  for (const blk of blocks) {
    const aTag = blk.match(/<a\b[^>]*\bclass="[^"]*\bresult__a\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    if (!aTag) continue;
    const hrefAttr = aTag[0].match(/\bhref="([^"]+)"/i);
    if (!hrefAttr) continue;
    let href = decodeXmlEntities(hrefAttr[1]).trim();
    if (href.startsWith("//")) href = "https:" + href;
    if (href.includes("uddg=")) {
      try {
        const u = new URL(href, "https://html.duckduckgo.com");
        const real = u.searchParams.get("uddg");
        if (real) href = real;
      } catch {}
    }
    const title = stripHtmlTags(aTag[1]);
    const snipMatch = blk.match(/\bclass="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/i);
    const snippet = stripHtmlTags(snipMatch?.[1] || "");
    if (!title || !/^https?:\/\//i.test(href)) continue;
    out.push({
      title,
      url: href,
      snippet,
      published: "",
      source: "DuckDuckGo",
    });
  }
  return out;
}

async function fetchTextSafe(url, { timeoutMs = 6500, proxyUrl = "", headers = {}, maxBytes = 2 * 1024 * 1024 } = {}) {
  await assertSafePublicUrlResolved(url, Boolean(proxyUrl));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let curUrl = url;
    for (let hop = 0; hop <= 4; hop++) {
      const res = await proxyFetch(curUrl, {
        headers: {
          "User-Agent": BROWSER_UA,
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
          ...headers,
        },
        signal: controller.signal,
        proxyUrl,
        maxBytes,
      });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get("location");
        try { await res.body?.cancel?.(); } catch {}
        if (!loc || hop === 4) throw new Error(`HTTP ${res.status}`);
        curUrl = new URL(loc, curUrl).toString();
        await assertSafePublicUrlResolved(curUrl, Boolean(proxyUrl));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ctype = String(res.headers.get("content-type") || "").toLowerCase();
      if (
        ctype &&
        !ctype.includes("text/") &&
        !ctype.includes("xml") &&
        !ctype.includes("json") &&
        !ctype.includes("html") &&
        !ctype.includes("javascript")
      ) {
        try { await res.body?.cancel?.(); } catch {}
        throw new Error(`目标响应不是可读网页文本 (${ctype.split(";")[0]})`);
      }
      if (res.body?.getReader) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let total = 0;
        let out = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          out += decoder.decode(value, { stream: true });
          if (total >= maxBytes) {
            try { await reader.cancel(); } catch {}
            break;
          }
        }
        out += decoder.decode();
        return out;
      }
      const txt = await res.text();
      return txt.slice(0, maxBytes);
    }
    throw new Error("重定向次数过多");
  } finally {
    clearTimeout(timer);
  }
}

let _ddgBlockedUntil = 0;
let _ddgLastProxy = "";

/**
 * Execute live full-web search across configured Domestic Direct or Global Proxy engines.
 */
export async function searchWebLive(query, { maxResults = 8, mode = "" } = {}) {
  const q = String(query || "").trim();
  if (!q) return { ok: false, query: "", engine: "none", results: [], error: "搜索词不能为空" };

  const se = getAllSettings().search_engine || {};
  const proxyUrl = String(se.proxy_url || "").trim();
  if (proxyUrl !== _ddgLastProxy) {
    _ddgLastProxy = proxyUrl;
    _ddgBlockedUntil = 0;
  }
  const pref = ["cn", "proxy", "auto"].includes(mode) ? mode : se.mode || "auto";
  const wantGlobal =
    (pref === "proxy" || (pref === "auto" && Boolean(proxyUrl))) &&
    (Boolean(proxyUrl) || Date.now() >= _ddgBlockedUntil);

  const collected = [];
  const errors = [];
  const isNewsLike = /最新|今日|新闻|发布|动态|2025|2026|news|latest|release/i.test(q);

  const runBingCn = async () => {
    const tasks = [
      fetchTextSafe(`https://cn.bing.com/search?q=${encodeURIComponent(q)}&format=rss&count=12`, {
        timeoutMs: 4500,
        proxyUrl: "",
      })
        .then((xml) => parseRssSearchItems(xml, "Bing"))
        .catch((e) => {
          errors.push(`Bing: ${e.message}`);
          return [];
        }),
    ];
    if (isNewsLike) {
      tasks.push(
        fetchTextSafe(`https://cn.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss`, {
          timeoutMs: 4500,
          proxyUrl: "",
        })
          .then((xml) => parseRssSearchItems(xml, "Bing News"))
          .catch(() => []),
      );
    }
    const batches = await Promise.all(tasks);
    return batches.flat();
  };

  if (wantGlobal) {
    const globalTimeout = proxyUrl ? 5500 : 2200;
    const [ddgItems, bingGlobalItems, cnFallbackItems] = await Promise.all([
      fetchTextSafe(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=wt-wt`, {
        timeoutMs: globalTimeout,
        proxyUrl,
      })
        .then((html) => parseDuckDuckGoHtmlItems(html))
        .catch((e) => {
          if (!proxyUrl) _ddgBlockedUntil = Date.now() + 5 * 60 * 1000;
          errors.push(`DuckDuckGo: ${e.message}`);
          return [];
        }),
      fetchTextSafe(`https://www.bing.com/search?q=${encodeURIComponent(q)}&format=rss&count=12`, {
        timeoutMs: globalTimeout,
        proxyUrl,
      })
        .then((xml) => parseRssSearchItems(xml, "Bing Global"))
        .catch(() => []),
      runBingCn(),
    ]);
    collected.push(...ddgItems, ...bingGlobalItems, ...cnFallbackItems);
  } else {
    const cnItems = await runBingCn();
    collected.push(...cnItems);
  }

  // Deduplicate by normalized URL
  const dedup = new Map();
  for (const item of collected) {
    const key = item.url.replace(/\/+$/, "").toLowerCase();
    if (!dedup.has(key)) dedup.set(key, item);
  }

  const results = [...dedup.values()].slice(0, Math.min(Math.max(Number(maxResults) || 8, 1), 20));
  return {
    ok: results.length > 0 || errors.length === 0,
    query: q,
    engine: wantGlobal && results.some((r) => r.source === "DuckDuckGo") ? "proxy" : "cn",
    results,
    error: !results.length && errors.length ? errors.join("；") : "",
  };
}

/**
 * Fetch and extract clean readable text/headings from a public web page URL.
 */
export async function fetchWebPageClean(rawUrl, { maxChars = 18000 } = {}) {
  const url = String(rawUrl || "").trim();
  if (!isSafePublicUrl(url)) {
    return { ok: false, url, error: "仅支持访问公开 http(s) 网页链接（已阻止本地或内网地址）", content: "" };
  }
  const proxyUrl = String(getAllSettings().search_engine?.proxy_url || "").trim();
  try {
    let html;
    try {
      html = await fetchTextSafe(url, { timeoutMs: 12000, proxyUrl });
    } catch (e1) {
      if (proxyUrl) html = await fetchTextSafe(url, { timeoutMs: 10000, proxyUrl: "" });
      else throw e1;
    }
    const title = stripHtmlTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "");
    const cleaned = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
      .replace(/<(?:nav|footer|aside|noscript)[\s\S]*?<\/(?:nav|footer|aside|noscript)>/gi, " ")
      .replace(/<h([1-4])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, lvl, inner) => `\n\n${"#".repeat(Number(lvl))} ${stripHtmlTags(inner)}\n`)
      .replace(/<\/(?:p|div|li|tr|section|article|br)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .split(/\r?\n/)
      .map((l) => decodeXmlEntities(l).replace(/[ \t]+/g, " ").trim())
      .filter(Boolean)
      .join("\n");

    return {
      ok: true,
      url,
      title,
      content: cleaned.slice(0, maxChars),
    };
  } catch (err) {
    return { ok: false, url, error: err.message, content: "" };
  }
}

export function formatSearchResultsForLlm(res) {
  if (!res.results?.length) {
    return `未检索到与「${res.query}」相关的网页结果${res.error ? `（${res.error}）` : ""}。`;
  }
  const lines = [`[全网实时搜索结果 · 关键词: "${res.query}" · 引擎: ${res.engine === "proxy" ? "全球搜索引擎" : "国内直连引擎"}]`];
  res.results.forEach((r, idx) => {
    lines.push(
      `\n${idx + 1}. ${r.title}\n   URL: ${r.url}` +
        (r.published ? `\n   时间: ${r.published}` : "") +
        (r.snippet ? `\n   摘要: ${r.snippet}` : ""),
    );
  });
  return lines.join("\n");
}
