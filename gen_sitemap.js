// Generate sitemap.xml for hijama.site from the live index.html data.
// Extracts REGIONS (city names) + GUIDES slugs from index.html, builds
// slugs with the exact citySlug() logic used by the app, and writes
// sitemap.xml next to this script. Run: node gen_sitemap.js
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "index.html");
const OUT = path.join(__dirname, "sitemap.xml");
const LASTMOD = "2026-11-18";

const html = fs.readFileSync(SRC, "utf8");

// --- Extract REGIONS object literal via brace matching (string-aware) ---
function extractRegions(text) {
  const start = text.indexOf("var REGIONS = ");
  if (start < 0) throw new Error("REGIONS not found");
  const brace = text.indexOf("{", start);
  let depth = 0, inStr = false, esc = false;
  for (let i = brace; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else {
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) return text.slice(brace, i + 1); }
    }
  }
  throw new Error("REGIONS closing brace not found");
}

const REGIONS = new Function("return " + extractRegions(html))();

// --- Same slug logic as the app (copied verbatim) ---
function citySlug(n) {
  return n.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

const cities = [];
Object.keys(REGIONS).forEach(function (r) {
  REGIONS[r].forEach(function (c) { cities.push({ name: c, region: r, slug: citySlug(c) }); });
});
console.log("cities:", cities.length);
if (cities.length !== 375) throw new Error("expected 375 cities, got " + cities.length);
const slugs = cities.map(function (c) { return c.slug; });
const dupes = slugs.filter(function (s, i) { return slugs.indexOf(s) !== i; });
if (dupes.length) throw new Error("duplicate city slugs: " + dupes.join(","));

// --- Guide slugs (verified against the GUIDES array in index.html) ---
const guidesBlock = html.slice(html.indexOf("var GUIDES=["), html.indexOf("];", html.indexOf("var GUIDES=[")));
const guideSlugs = [];
const re = /slug:"([^"]+)"/g;
let m;
while ((m = re.exec(guidesBlock)) !== null) guideSlugs.push(m[1]);
console.log("guides:", guideSlugs.join(","));
if (guideSlugs.length !== 4) throw new Error("expected 4 guides, got " + guideSlugs.length);

// --- Build sitemap ---
function url(loc, prio, freq) {
  return "  <url>\n    <loc>" + loc + "</loc>\n    <lastmod>" + LASTMOD + "</lastmod>\n    <changefreq>" + freq + "</changefreq>\n    <priority>" + prio + "</priority>\n  </url>";
}
const urls = [];
urls.push(url("https://hijama.site/", "1.0", "daily"));
["centres", "villes", "guides", "inscription", "verification"].forEach(function (p) {
  urls.push(url("https://hijama.site/#/" + p, "0.8", "weekly"));
});
urls.push(url("https://hijama.site/#/centre/bayt-al-wiqaya-casablanca", "0.9", "weekly"));
for (let i = 0; i < 7; i++) {
  urls.push(url("https://hijama.site/#/service/bayt-al-wiqaya-casablanca/" + i, "0.7", "monthly"));
}
guideSlugs.forEach(function (g) {
  urls.push(url("https://hijama.site/#/guide/" + g, "0.7", "monthly"));
});
cities.forEach(function (c) {
  urls.push(url("https://hijama.site/#/ville/" + c.slug, "0.6", "monthly"));
});

const xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
  + urls.join("\n") + "\n</urlset>\n";
fs.writeFileSync(OUT, xml, "utf8");
console.log("wrote", OUT, "with", urls.length, "urls");
