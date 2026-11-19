#!/usr/bin/env node
/* Soumet les URL nouvelles/modifiées de hijama.site à IndexNow
   (Bing, Yandex, Naver, Seznam, Yep — PAS Google : Google ne
   participe pas à IndexNow, donc cette soumission ne le touche pas).
   Lit la clé dans <key>.txt à la racine du dépôt et la liste des URL
   dans indexnow-changed.json (écrit par build-static.js : les URL
   dont <lastmod> est aujourd'hui). Appelé par le workflow GitHub
   Actions après le push (les URL doivent être en ligne pour que
   Bing puisse les récupérer).
   Sortie 0 quand il n'y a rien à soumettre ou que la soumission est
   acceptée ; 1 seulement en cas d'erreur de configuration (fichier
   clé ou liste manquant/invalide). Une panne réseau ou une réponse
   inattendue de l'API est journalisée en avertissement (sortie 0) :
   les URL restent découvrables via le sitemap, et le build quotidien
   ne doit pas échouer à cause d'une panne chez Bing. */
"use strict";
const fs = require("fs");
const path = require("path");
const https = require("https");

const ROOT = __dirname;
const KEY_FILE = "50cbf94bfbcd05751e9950abeb412e49.txt";
const HOST = "hijama.site";

function main() {
  const keyPath = path.join(ROOT, KEY_FILE);
  if (!fs.existsSync(keyPath)) { console.error("IndexNow : fichier clé introuvable : " + KEY_FILE); process.exit(1); }
  const key = fs.readFileSync(keyPath, "utf8").trim();
  if (!/^[0-9a-f]{32}$/.test(key)) { console.error("IndexNow : clé invalide dans " + KEY_FILE); process.exit(1); }
  const changedPath = path.join(ROOT, "indexnow-changed.json");
  if (!fs.existsSync(changedPath)) { console.error("IndexNow : indexnow-changed.json introuvable — lancez d'abord : node build-static.js"); process.exit(1); }
  const changed = JSON.parse(fs.readFileSync(changedPath, "utf8"));
  const urls = changed.urls || [];
  if (!urls.length) { console.log("IndexNow : aucune URL nouvelle/modifiée — rien à soumettre."); return; }
  const body = JSON.stringify({ host: HOST, key: key, keyLocation: "https://" + HOST + "/" + KEY_FILE, urlList: urls });
  const req = https.request({ hostname: "api.indexnow.org", path: "/indexnow.json", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, function (res) {
    console.log("IndexNow : HTTP " + res.statusCode + " pour " + urls.length + " URL(s).");
    if (res.statusCode === 200 || res.statusCode === 202) { console.log("IndexNow : soumission acceptée."); }
    else { console.warn("IndexNow : réponse inattendue (" + res.statusCode + ") — URL non soumises (elles restent dans le sitemap)."); }
  });
  req.on("error", function (e) { console.warn("IndexNow : erreur réseau (" + e.message + ") — URL non soumises (elles restent dans le sitemap)."); });
  req.end(body);
}
main();
