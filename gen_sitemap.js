// Generate sitemap.xml for hijama.site.
//
// IMPORTANT (2026-11-18 SEO audit): this sitemap lists ONLY the homepage.
// The site is a hash-routed single-page app: every "page" (city, centre,
// guide) lives behind a URL fragment, e.g. https://hijama.site/#/ville/casablanca.
// Google strips URL fragments, so all 392 former hash URLs collapsed to the
// homepage in Google's eyes, and the sitemap spec forbids fragments in <loc>.
// Listing them only produced "duplicate / invalid URL" errors in Search
// Console without indexing a single extra page.
//
// DO NOT re-add hash URLs here. After the routing migration to real paths
// (History API + one static HTML file per route, or prerendering), regenerate
// the full sitemap with one <url> per real page and bump lastmod.
// Run: node gen_sitemap.js
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "sitemap.xml");
const LASTMOD = new Date().toISOString().slice(0, 10);

const xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
  + '  <url>\n'
  + '    <loc>https://hijama.site/</loc>\n'
  + '    <lastmod>' + LASTMOD + '</lastmod>\n'
  + '    <changefreq>daily</changefreq>\n'
  + '    <priority>1.0</priority>\n'
  + '  </url>\n'
  + '</urlset>\n';
fs.writeFileSync(OUT, xml, "utf8");
console.log("wrote", OUT, "with 1 url (homepage only — see header comment)");
