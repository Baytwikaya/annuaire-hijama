// Generate sitemap.xml for hijama.site from static-manifest.json.
//
// The manifest is written by build-static.js (node build-static.js) and
// lists EXACTLY the static URLs that were generated — real clean paths
// only (https://hijama.site/centre/..., /ville/..., /guide/...).
// No hash URLs: Google strips URL fragments, so a #/… URL is not a
// separate page and the sitemap spec forbids fragments in <loc>.
// No page for a city without a centre: such a page is not generated
// (see build-static.js header), so it must not appear here either.
//
// Run: node gen_sitemap.js        (after node build-static.js, or alone
//                                   to regenerate the sitemap from the
//                                   existing manifest)
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "sitemap.xml");
const MANIFEST = path.join(__dirname, "static-manifest.json");

if (!fs.existsSync(MANIFEST)) {
  console.error("static-manifest.json introuvable — lancez d'abord : node build-static.js");
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
const urls = manifest.urls || [];
if (!urls.length) {
  console.error("static-manifest.json ne contient aucune URL — build incomplet, abandon.");
  process.exit(1);
}
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'];
urls.forEach(function (u) {
  if (u.loc.indexOf("#") >= 0) throw new Error("URL avec fragment interdite dans le sitemap : " + u.loc);
  lines.push("  <url>");
  lines.push("    <loc>" + esc(u.loc) + "</loc>");
  lines.push("    <lastmod>" + esc(u.lastmod || manifest.generatedAt) + "</lastmod>");
  lines.push("    <changefreq>" + esc(u.changefreq || "weekly") + "</changefreq>");
  lines.push("    <priority>" + esc(String(u.priority != null ? u.priority : 0.5)) + "</priority>");
  lines.push("  </url>");
});
lines.push("</urlset>");
fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
console.log("wrote", OUT, "with", urls.length, "urls (from static-manifest.json, generated " + manifest.generatedAt + ")");
