import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const siteOrigin = "https://www.blankspacewoodstock.ca";
const outDir = path.resolve("site-original");
const rawDir = path.join(outDir, "_raw");

const pages = [
  { url: `${siteOrigin}/`, file: "index.html" },
  { url: `${siteOrigin}/pricing`, file: "pricing.html" },
  { url: `${siteOrigin}/faq`, file: "faq.html" },
  { url: `${siteOrigin}/contact`, file: "contact.html" },
  { url: `${siteOrigin}/book-appointment`, file: "book-appointment.html" },
];

const urlToLocal = new Map();
const downloaded = [];
const failed = [];
const pageMap = new Map();

for (const page of pages) {
  pageMap.set(page.url, page.file);
  pageMap.set(page.url.replace(/\/$/, ""), page.file);
  pageMap.set(new URL(page.url).pathname || "/", page.file);
}

function hashUrl(url) {
  return createHash("sha1").update(url).digest("hex").slice(0, 10);
}

function normalizeUrl(input, baseUrl) {
  if (!input) return null;
  const cleaned = input.trim().replace(/^['"]|['"]$/g, "");
  if (
    !cleaned ||
    cleaned.startsWith("#") ||
    cleaned.startsWith("mailto:") ||
    cleaned.startsWith("tel:") ||
    cleaned.startsWith("javascript:") ||
    cleaned.startsWith("data:") ||
    cleaned.startsWith("blob:")
  ) {
    return null;
  }

  try {
    const normalized = new URL(cleaned, baseUrl).href;
    const decoded = decodeURIComponent(normalized);
    if (decoded.includes("${") || decoded.includes("}")) return null;
    return normalized;
  } catch {
    return null;
  }
}

function getExtension(url, contentType = "") {
  const pathname = new URL(url).pathname;
  const ext = path.extname(pathname);
  if (ext && ext.length <= 8) return ext;

  if (contentType.includes("text/css")) return ".css";
  if (contentType.includes("javascript")) return ".js";
  if (contentType.includes("image/jpeg")) return ".jpg";
  if (contentType.includes("image/png")) return ".png";
  if (contentType.includes("image/webp")) return ".webp";
  if (contentType.includes("image/svg")) return ".svg";
  if (contentType.includes("font/woff2")) return ".woff2";
  if (contentType.includes("font/woff")) return ".woff";
  if (contentType.includes("video/mp4")) return ".mp4";
  if (contentType.includes("application/json")) return ".json";
  return ".bin";
}

function localAssetPath(url, contentType = "") {
  const parsed = new URL(url);
  const safeHost = parsed.hostname.replace(/[^a-z0-9.-]/gi, "_");
  const base = path.basename(parsed.pathname).replace(/[^a-z0-9._-]/gi, "_");
  const ext = getExtension(url, contentType);
  const stem = base && base.includes(".") ? base.slice(0, -path.extname(base).length) : base || "asset";
  return path.join("assets", safeHost, `${stem}.${hashUrl(url)}${ext}`);
}

function addAsset(found, url, baseUrl) {
  const normalized = normalizeUrl(url, baseUrl);
  if (!normalized) return;
  const protocol = new URL(normalized).protocol;
  if (protocol !== "http:" && protocol !== "https:") return;
  found.add(normalized);
}

function collectFromSrcset(found, srcset, baseUrl) {
  for (const candidate of srcset.split(",")) {
    const url = candidate.trim().split(/\s+/)[0];
    addAsset(found, url, baseUrl);
  }
}

function isAllowedHost(url) {
  const host = new URL(url).hostname;
  return (
    host === "www.blankspacewoodstock.ca" ||
    host.endsWith(".squarespace.com") ||
    host.endsWith(".squarespace-cdn.com") ||
    host.endsWith(".sqspcdn.com") ||
    host === "fonts.googleapis.com" ||
    host === "fonts.gstatic.com" ||
    host === "cdn.plyr.io"
  );
}

function looksLikePage(url) {
  const parsed = new URL(url);
  return parsed.origin === siteOrigin && pageMap.has(parsed.pathname);
}

function addAllowedAsset(found, url, baseUrl) {
  const normalized = normalizeUrl(url, baseUrl);
  if (!normalized || !isAllowedHost(normalized) || looksLikePage(normalized)) return;
  addAsset(found, normalized, baseUrl);
}

function collectAssets(text, baseUrl, options = {}) {
  const found = new Set();
  const attrPattern =
    /\b(?:src|href|poster|data-src|data-image|data-url)=["']([^"']+)["']/gi;
  const srcsetPattern = /\b(?:srcset|data-srcset)=["']([^"']+)["']/gi;
  const cssUrlPattern = /url\((?!['"]?data:)([^)]+)\)/gi;
  const quotedUrlPattern = /["'](https?:\/\/[^"']+)["']/gi;

  for (const match of text.matchAll(attrPattern)) addAllowedAsset(found, match[1], baseUrl);
  for (const match of text.matchAll(srcsetPattern)) {
    for (const candidate of match[1].split(",")) {
      addAllowedAsset(found, candidate.trim().split(/\s+/)[0], baseUrl);
    }
  }
  for (const match of text.matchAll(cssUrlPattern)) addAllowedAsset(found, match[1], baseUrl);
  if (options.includeQuotedUrls) {
    for (const match of text.matchAll(quotedUrlPattern)) addAllowedAsset(found, match[1], baseUrl);
  }

  return found;
}

function shouldFetchAsset(url) {
  if (!isAllowedHost(url) || looksLikePage(url)) return false;
  const parsed = new URL(url);
  if (parsed.hostname.includes("google-analytics.com")) return false;
  if (parsed.hostname.includes("googletagmanager.com")) return false;
  if (parsed.hostname.includes("facebook.net")) return false;
  if (parsed.hostname.includes("doubleclick.net")) return false;
  if (parsed.hostname.includes("sentry.io")) return false;
  return true;
}

async function fetchWithTimeout(url, timeoutMs = 30000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function downloadAsset(url, queue) {
  if (urlToLocal.has(url) || !shouldFetchAsset(url)) return;

  try {
    const response = await fetchWithTimeout(url);
    if (!response.ok) {
      failed.push({ url, status: response.status, statusText: response.statusText });
      return;
    }

    const contentType = response.headers.get("content-type") || "";
    const localRelative = localAssetPath(url, contentType);
    const localAbsolute = path.join(outDir, localRelative);
    await mkdir(path.dirname(localAbsolute), { recursive: true });

    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(localAbsolute, buffer);
    urlToLocal.set(url, localRelative.replaceAll(path.sep, "/"));
    downloaded.push({ url, file: localRelative.replaceAll(path.sep, "/"), bytes: buffer.length, contentType });

    if (contentType.includes("text/css") || contentType.includes("javascript") || contentType.includes("json")) {
      const nested = collectAssets(buffer.toString("utf8"), url);
      for (const nestedUrl of nested) {
        if (!urlToLocal.has(nestedUrl) && shouldFetchAsset(nestedUrl)) queue.add(nestedUrl);
      }
    }
  } catch (error) {
    failed.push({ url, error: error.message });
  }
}

function rewriteHtml(html, pageUrl) {
  let rewritten = html;

  const replacements = [...urlToLocal.entries()].sort((a, b) => b[0].length - a[0].length);

  for (const [url, localPath] of replacements) {
    const relative = path.relative(path.dirname(pageMap.get(pageUrl) || "index.html"), localPath).replaceAll(path.sep, "/");
    rewritten = rewritten.split(url).join(relative);
    const parsed = new URL(url);
    rewritten = rewritten
      .split(`//${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`)
      .join(relative);
    if (parsed.origin === siteOrigin) {
      rewritten = rewritten.split(`${parsed.pathname}${parsed.search}${parsed.hash}`).join(relative);
    }
  }

  for (const page of pages) {
    const pageUrlObject = new URL(page.url);
    const hrefs = new Set([
      page.url,
      page.url.replace(/\/$/, ""),
      pageUrlObject.pathname,
      `${pageUrlObject.pathname}/`,
    ]);
    for (const href of hrefs) {
      rewritten = rewritten.split(`href="${href}"`).join(`href="${page.file}"`);
      rewritten = rewritten.split(`href='${href}'`).join(`href='${page.file}'`);
    }
  }

  return rewritten;
}

async function main() {
  await mkdir(outDir, { recursive: true });
  await mkdir(rawDir, { recursive: true });

  const queue = new Set();

  for (const page of pages) {
    const response = await fetchWithTimeout(page.url);
    if (!response.ok) throw new Error(`Could not fetch ${page.url}: ${response.status}`);
    const html = await response.text();
    await writeFile(path.join(rawDir, page.file), html);
    for (const asset of collectAssets(html, page.url, { includeQuotedUrls: true })) queue.add(asset);
  }

  while (queue.size > 0) {
    const [assetUrl] = queue;
    queue.delete(assetUrl);
    await downloadAsset(assetUrl, queue);
  }

  for (const page of pages) {
    const rawHtml = await readFile(path.join(rawDir, page.file), "utf8");
    await writeFile(path.join(outDir, page.file), rewriteHtml(rawHtml, page.url));
  }

  const manifest = {
    capturedAt: new Date().toISOString(),
    siteOrigin,
    pages,
    downloaded,
    failed,
  };
  await writeFile(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(`Pages: ${pages.length}`);
  console.log(`Assets downloaded: ${downloaded.length}`);
  console.log(`Assets failed/skipped errors: ${failed.length}`);
  console.log(`Output: ${outDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
