/**
 * GitHub Releases Updater for OpenCode Studio.
 * Queries https://api.github.com/repos/gniygniynus/opencode-studio/releases
 * and focuses cleanly on the latest official release.
 */

import fs from "node:fs";
import path from "node:path";
import { getAllSettings, setSetting } from "./db.mjs";
import { logEvent } from "./logger.mjs";
import { PROJECT_ROOT } from "./paths.mjs";
import { proxyFetch } from "./runtime_utils.mjs";

export const REPO_SLUG = process.env.OPENCODE_REPO || "gniygniynus/opencode-studio";

export function getAppVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"));
    return pkg.version || "1.0.0";
  } catch {
    return "1.0.0";
  }
}

export function compareSemver(a, b) {
  const clean = (v) => String(v || "0.0.0").replace(/^v/i, "");
  const [pa, preA = ""] = clean(a).split("-", 2);
  const [pb, preB = ""] = clean(b).split("-", 2);
  const na = pa.split(".").map((n) => parseInt(n, 10) || 0);
  const nb = pb.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((na[i] || 0) !== (nb[i] || 0)) return (na[i] || 0) > (nb[i] || 0) ? 1 : -1;
  }
  if (!preA && preB) return 1;
  if (preA && !preB) return -1;
  return preA.localeCompare(preB);
}

function pickPlatformAsset(assets = []) {
  const plat = process.platform;
  const arch = process.arch;
  const matchers =
    plat === "win32"
      ? [/setup.*\.exe$/i, /\.exe$/i, /win.*\.zip$/i]
      : plat === "darwin"
        ? arch === "arm64"
          ? [/arm64.*\.dmg$/i, /\.dmg$/i, /arm64.*\.zip$/i]
          : [/x64.*\.dmg$/i, /\.dmg$/i, /mac.*\.zip$/i]
        : [/\.AppImage$/i, /\.deb$/i, /linux.*\.tar\.gz$/i];

  for (const rx of matchers) {
    const hit = assets.find((a) => rx.test(a.name || ""));
    if (hit) {
      return {
        name: hit.name,
        size: hit.size,
        download_url: hit.browser_download_url,
      };
    }
  }
  return null;
}

export async function checkForUpdates(channelOverride = null) {
  const channel = channelOverride === "latest" ? "latest" : "stable";
  if (channelOverride === "latest" || channelOverride === "stable") {
    setSetting("update_channel", channel);
  }

  const currentVersion = getAppVersion();
  const apiUrl = `https://api.github.com/repos/${REPO_SLUG}/releases?per_page=15`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const proxyUrl = getAllSettings().search_engine?.proxy_url || "";
    const res = await proxyFetch(apiUrl, {
      headers: {
        "User-Agent": `OpenCodeStudio/${currentVersion}`,
        Accept: "application/vnd.github+json",
      },
      signal: controller.signal,
      proxyUrl,
    });
    if (!res.ok) {
      return {
        ok: false,
        channel,
        current_version: currentVersion,
        repo_url: `https://github.com/${REPO_SLUG}/releases`,
        has_update: false,
        message: res.status === 404 ? "仓库暂未发布 Release，请先发布版本标签。" : `GitHub API 返回 HTTP ${res.status}`,
      };
    }

    const rawReleases = await res.json();
    const releases = (Array.isArray(rawReleases) ? rawReleases : []).filter((r) => !r.draft);
    const stableRel = releases.find((r) => !r.draft && !r.prerelease) || null;
    const latestRel = releases[0] || null;
    const target =
      channelOverride === "latest"
        ? latestRel || stableRel
        : releases.find((r) => !r.draft && !r.prerelease) || releases[0] || null;

    if (!target) {
      return {
        ok: true,
        channel,
        current_version: currentVersion,
        repo_url: `https://github.com/${REPO_SLUG}/releases`,
        has_update: false,
        message: "当前尚无已发布的 Release 版本。",
      };
    }

    const targetVer = String(target.tag_name || "").replace(/^v/i, "");
    const hasUpdate = compareSemver(targetVer, currentVersion) > 0;
    const asset = pickPlatformAsset(target.assets || []);

    return {
      ok: true,
      channel,
      current_version: currentVersion,
      target_version: targetVer,
      tag_name: target.tag_name,
      is_prerelease: Boolean(target.prerelease),
      published_at: target.published_at,
      has_update: hasUpdate,
      notes: String(target.body || "").slice(0, 3000),
      release_url: target.html_url,
      repo_url: `https://github.com/${REPO_SLUG}/releases`,
      recommended_asset: asset,
      platform: `${process.platform}-${process.arch}`,
      available_channels: {
        stable: stableRel ? String(stableRel.tag_name) : null,
        latest: latestRel ? String(latestRel.tag_name) : null,
      },
    };
  } catch (err) {
    logEvent("WARN", "updater", "check_failed", `检查更新失败: ${err.message}`);
    return {
      ok: false,
      channel,
      current_version: currentVersion,
      repo_url: `https://github.com/${REPO_SLUG}/releases`,
      has_update: false,
      message: `联网检查更新失败: ${err.message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
