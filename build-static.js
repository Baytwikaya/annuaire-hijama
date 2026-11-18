#!/usr/bin/env node
/* =====================================================================
   build-static.js — génération des pages statiques de hijama.site
   =====================================================================
   POURQUOI CE SCRIPT
   -----------------
   hijama.site est une application monopage (SPA) : une seule page
   index.html, dont les « pages » (villes, centres, guides…) sont des
   vues JavaScript derrière des ancres (#/ville/casablanca). Google
   ignore le contenu après # : seule la page d'accueil pouvait être
   indexée. Ce script génère une vraie page HTML par route, avec le
   contenu complet + titre / méta / canonique dans le HTML brut, pour
   que Google indexe chaque page sans exécuter de JavaScript.

   CE QUE LE SCRIPT GÉNÈRE
   ------------------------
   - la page d'accueil (contenu pré-rendu injecté dans index.html)
   - les sections : /centres, /villes, /guides, /inscription,
     /verification
   - les 4 guides : /guide/<slug>
   - chaque centre réel : /centre/<slug> + ses pages services
     /service/<slug>/<index>
   - les pages villes UNIQUEMENT pour les villes qui ont au moins un
     centre : /ville/<slug> (aujourd'hui : Casablanca seulement).
     Une ville sans centre n'a PAS de page statique — elle reste
     joignable via la liste des villes (/villes) et via la recherche
     de l'application. Quand un centre est approuvé dans une ville,
     la prochaine exécution du script crée sa page automatiquement.

   SOURCE DE VÉRITÉ : FIRESTORE
   -----------------------------
   Les centres sont lus en direct depuis Firestore (API publique,
   sans secret — la clé est déjà dans index.html). Les données
   Firestore priment sur la liste codée en dur dans index.html
   (même fusion que l'application : centreFromFirestore).
   Le script SYNCHRONISE aussi la liste codée en dur avec les données
   fusionnées, pour que l'application affiche les mêmes données que
   les pages statiques au démarrage, avant même le chargement
   Firestore. Conséquence : un centre nouveau (sans entrée codée en
   dur) apparaît automatiquement sur le site après un build — c'est
   le comportement voulu (Firestore = source de vérité), et c'est ce
   qui permet l'automatisation ci-dessous.

   AUTOMATISATION (AUCUN REBUILD MANUEL)
   --------------------------------------
   Un workflow GitHub Actions (.github/workflows/build-static.yml)
   exécute ce script tous les jours (et à la demande) : si le build
   produit des changements (nouveau centre → nouvelles pages,
   sitemap mis à jour), il les committe et les pousse tout seul.
   La SEULE partie manuelle reste l'indexation : soumettre les
   nouvelles URL dans Google Search Console, de temps en temps,
   quand des centres sont ajoutés.

   COMMENT LANCER LE BUILD À LA MAIN
   ---------------------------------
     cd <racine du dépôt>
     node build-static.js
   Puis vérifier, committer et pousser (git add -A && git commit &&
   git push). Le script échoue bruyamment (exit 1) si Firestore est
   injoignable ou si la liste fusionnée est vide/invalide — ne jamais
   pousser un build partiel.

   COMMENT AJOUTER UNE VILLE / UN CENTRE
   -------------------------------------
   Rien à faire dans ce script : approuvez le centre dans Firestore
   (directUpdated: true). Le prochain build (manuel ou automatique)
   crée la page du centre, ses pages services et, si la ville n'en
   avait pas, sa page ville. La liste des grandes villes
   (MAJOR_CITIES, dans index.html) ne concerne que le formulaire
   d'inscription, pas les pages statiques.

   SORTIES
   -------
   - <route>/index.html pour chaque route générée
   - index.html (accueil pré-rendu, entre les marqueurs
     <!-- PRERENDER:home --> ... <!-- /PRERENDER -->)
   - static-manifest.json : la liste des URL générées
   - sitemap.xml : régénéré par gen_sitemap.js à partir du manifeste
   ===================================================================== */
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = __dirname;
const SITE = "https://hijama.site";
const TODAY = new Date().toISOString().slice(0, 10);

/* ------------------------------------------------------------------ */
/* Utilitaires (mêmes règles que l'application)                        */
/* ------------------------------------------------------------------ */
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function citySlug(n) {
  return String(n || "").toLowerCase()
    .replace(/[àâä]/g, "a").replace(/[éèêë]/g, "e").replace(/[îï]/g, "i")
    .replace(/[ôö]/g, "o").replace(/[ùûü]/g, "u").replace(/ç/g, "c")
    .replace(/'/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
function phoneToIntl(p) {
  if (!p) return "";
  var d = String(p).replace(/[^0-9+]/g, "");
  if (d.indexOf("+") === 0) return d;
  if (d.indexOf("212") === 0) return "+" + d;
  if (d.charAt(0) === "0") return "+212" + d.slice(1);
  return d;
}
/* +212664651301 → +212 6 64 65 13 01 */
function phoneDisplay(intl) {
  var d = String(intl || "").replace(/[^0-9]/g, "");
  if (d.indexOf("212") === 0 && d.length === 12) {
    var r = d.slice(3);
    return "+212 " + r.charAt(0) + " " + r.slice(1, 3) + " " + r.slice(3, 5) + " " + r.slice(5, 7) + " " + r.slice(7, 9);
  }
  return String(intl || "");
}
function isImgSrc(v) {
  return typeof v === "string" && (v.indexOf("http://") === 0 || v.indexOf("https://") === 0 || v.indexOf("data:") === 0 || v.charAt(0) === "/");
}
function fp(v) { v = String(v || ""); return v.length + ":" + v.slice(0, 100); }

const MONTHS_FR = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
function sinceLabel(c) {
  var s = c.since || "";
  var m = /^(\d{4})-(\d{2})/.exec(s);
  if (m) { var mo = parseInt(m[2], 10); if (mo >= 1 && mo <= 12) return MONTHS_FR[mo - 1] + " " + m[1]; }
  return s;
}
function hourDay(h) { return h ? (h.day !== undefined ? h.day : h[0]) : ""; }
function hourRange(h) { return h ? (h.hours !== undefined ? h.hours : h[1]) : ""; }

/* ------------------------------------------------------------------ */
/* Extraction des données codées en dur dans index.html                */
/* ------------------------------------------------------------------ */
/* Extrait un littéral JS (objet ou tableau) en suivant les accolades /
   crochets en tenant compte des chaînes — comme gen_sitemap.js. */
function extractLiteral(src, marker, openCh, closeCh) {
  var start = src.indexOf(marker);
  if (start < 0) throw new Error("Marqueur introuvable dans index.html : " + marker);
  var i = src.indexOf(openCh, start);
  var depth = 0, j = i, instr = null, escCh = false;
  while (j < src.length) {
    var ch = src[j];
    if (instr) {
      if (escCh) escCh = false;
      else if (ch === "\\") escCh = true;
      else if (ch === instr) instr = null;
    } else {
      if (ch === "'" || ch === '"' || ch === "`") instr = ch;
      else if (ch === openCh) depth++;
      else if (ch === closeCh) { depth--; if (depth === 0) return src.slice(i, j + 1); }
    }
    j++;
  }
  throw new Error("Littéral non terminé pour : " + marker);
}
function loadTemplateData() {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const regionsSrc = extractLiteral(html, "var REGIONS", "{", "}");
  const guidesSrc = extractLiteral(html, "var GUIDES", "[", "]");
  const centresSrc = extractLiteral(html, "var CENTRES", "[", "]");
  const apiKey = /apiKey\s*:\s*"([^"]+)"/.exec(html);
  if (!apiKey) throw new Error("Clé API Firebase introuvable dans index.html (FIREBASE_CONFIG).");
  // Évaluation des littéraux (données de confiance : notre propre fichier).
  const REGIONS = new Function("return (" + regionsSrc + ");")();
  const GUIDES = new Function("return (" + guidesSrc + ");")();
  const CENTRES = new Function("return (" + centresSrc + ");")();
  const MAJOR = /var MAJOR_CITIES\s*=\s*(\[[^\]]*\])/.exec(html);
  const MAJOR_CITIES = MAJOR ? new Function("return (" + MAJOR[1] + ");")() : [];
  return { html, REGIONS, GUIDES, CENTRES, MAJOR_CITIES, apiKey: apiKey[1] };
}

/* ------------------------------------------------------------------ */
/* Firestore (API REST publique, sans secret)                          */
/* ------------------------------------------------------------------ */
function fsDec(v) {
  if (!v || typeof v !== "object") return v;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.integerValue !== undefined) return parseInt(v.integerValue, 10);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.timestampValue !== undefined) return v.timestampValue;
  if (v.nullValue !== undefined) return null;
  if (v.arrayValue !== undefined) return (v.arrayValue.values || []).map(fsDec);
  if (v.mapValue !== undefined) {
    var o = {};
    Object.keys(v.mapValue.fields || {}).forEach(function (k) { o[k] = fsDec(v.mapValue.fields[k]); });
    return o;
  }
  return v;
}
function fsDoc(d) {
  var o = {};
  Object.keys(d.fields || {}).forEach(function (k) { o[k] = fsDec(d.fields[k]); });
  return o;
}
async function fetchJson(url, opts, tries) {
  tries = tries || 3;
  var lastErr = null;
  for (var i = 0; i < tries; i++) {
    try {
      var res = await fetch(url, opts || {});
      if (!res.ok) throw new Error("HTTP " + res.status + " sur " + url);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await new Promise(function (r) { setTimeout(r, 1500 * (i + 1)); });
    }
  }
  throw new Error("Firestore injoignable après " + tries + " tentatives : " + lastErr.message);
}
async function loadLiveData(apiKey) {
  const base = "https://firestore.googleapis.com/v1/projects/annuaire-hijama/databases/(default)/documents";
  const centres = await fetchJson(base + "/centres?pageSize=200&key=" + apiKey);
  const etat = await fetchJson(base + "/fiches_etat?pageSize=200&key=" + apiKey).catch(function () { return { documents: [] }; });
  const avis = await fetchJson(base + ":runQuery?key=" + apiKey, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "avis" }],
        where: { fieldFilter: { field: { fieldPath: "statut" }, op: "EQUAL", value: { stringValue: "publie" } } }
      }
    })
  });
  return {
    centres: (centres.documents || []).map(fsDoc),
    etat: (etat.documents || []).map(fsDoc),
    avis: (avis || []).filter(function (r) { return r.document; }).map(function (r) { return fsDoc(r.document); })
  };
}

/* ------------------------------------------------------------------ */
/* Fusion Firestore → seed (port fidèle de centreFromFirestore)        */
/* ------------------------------------------------------------------ */
function centreFromFirestore(dd, base) {
  if (!dd) return base;
  var m = {}; Object.keys(base).forEach(function (k) { m[k] = base[k]; });
  if (dd.name) m.name = dd.name;
  if (dd.city || dd.ville) m.city = dd.city || dd.ville;
  if (dd.address || dd.adresse) m.address = dd.address || dd.adresse;
  if (dd.phone || dd.telephone) m.phone = dd.phone || dd.telephone;
  if (dd.phoneIntl) m.phoneIntl = dd.phoneIntl;
  else if (m.phone && m.phone !== base.phone) m.phoneIntl = phoneToIntl(m.phone);
  if (dd.maps) m.maps = dd.maps;
  if (dd.desc || dd.description) m.desc = dd.desc || dd.description;
  if (dd.services) m.services = dd.services;
  if (dd.hours || dd.horaires) m.hours = dd.hours || dd.horaires;
  if (dd.cover && isImgSrc(dd.cover)) m.cover = dd.cover;
  else if (dd.image && isImgSrc(dd.image)) m.cover = dd.image;
  if (typeof dd.coverPos === "number" && isFinite(dd.coverPos)) m.coverPos = Math.max(0, Math.min(100, dd.coverPos));
  if (dd.verificationPhotos && Array.isArray(dd.verificationPhotos)) m.verificationPhotos = dd.verificationPhotos.filter(isImgSrc);
  if (dd.photos && Array.isArray(dd.photos) && dd.photos.length && dd.photos.every(isImgSrc)) m.photos = dd.photos;
  if (dd.servicePhotos) {
    var sp = {}; Object.keys(base.servicePhotos || {}).forEach(function (k) { sp[k] = base.servicePhotos[k]; });
    Object.keys(dd.servicePhotos).forEach(function (k) { if (isImgSrc(dd.servicePhotos[k])) sp[k] = dd.servicePhotos[k]; });
    m.servicePhotos = sp;
  }
  if (dd.servicePrices) {
    var pr = {}; Object.keys(base.servicePrices || {}).forEach(function (k) { pr[k] = base.servicePrices[k]; });
    Object.keys(dd.servicePrices).forEach(function (k) { var v = dd.servicePrices[k]; if (typeof v === "number" && isFinite(v) && v > 0) pr[k] = v; });
    m.servicePrices = pr;
  }
  if (dd.serviceDesc) {
    var sd = {}; Object.keys(base.serviceDesc || {}).forEach(function (k) { sd[k] = base.serviceDesc[k]; });
    Object.keys(dd.serviceDesc).forEach(function (k) { var v = dd.serviceDesc[k]; if (typeof v === "string" && v.trim()) sd[k] = v; });
    m.serviceDesc = sd;
  }
  if (dd.social) m.social = dd.social;
  if (dd.logo && isImgSrc(dd.logo)) m.logo = dd.logo;
  if (dd.slug) m.slug = dd.slug;
  if (typeof dd.since === "string" && dd.since) m.since = dd.since;
  if (dd.verified !== undefined) m.verified = dd.verified;
  return m;
}
function centreSig(c) {
  return [fp(c.name), fp(c.city), fp(c.address), fp(c.phone), fp(c.phoneIntl), fp(c.maps), fp(c.desc),
    fp((c.services || []).join("|")), fp(JSON.stringify(c.servicePrices || {})),
    fp(JSON.stringify(c.serviceDesc || {})), fp(JSON.stringify(c.servicePhotos || {})),
    fp(JSON.stringify(c.hours || [])), fp(c.logo || ""), fp(c.cover || ""),
    fp(JSON.stringify(c.social || {})), fp(c.since || ""), String(!!c.verified)].join(";");
}
/* Ne garder, dans les tables par service, que les services listés. */
function pruneServiceMaps(c) {
  var keep = {};
  (c.services || []).forEach(function (s) { keep[s] = 1; });
  ["servicePrices", "serviceDesc", "servicePhotos"].forEach(function (k) {
    if (!c[k]) return;
    var out = {};
    Object.keys(c[k]).forEach(function (s) { if (keep[s]) out[s] = c[k][s]; });
    c[k] = out;
  });
  return c;
}
function mergeCentres(seed, fsCentres, etat, CITIES) {
  var bySlug = {};
  seed.forEach(function (c) { bySlug[c.slug] = c; });
  var merged = seed.map(function (c) { return Object.assign({}, c); });
  var mergedBySlug = {};
  merged.forEach(function (c) { mergedBySlug[c.slug] = c; });
  fsCentres.forEach(function (dd) {
    if (dd.directUpdated !== true) return;
    var slug = dd.slug || (bySlug[dd.slug] ? dd.slug : null);
    if (!slug) {
      // Nouveau centre sans entrée codée en dur : base minimale, puis fusion.
      var base = {
        slug: dd.slug || citySlug(dd.name || "centre"),
        name: dd.name || "Centre", city: dd.city || dd.ville || "", region: "",
        address: "", phone: "", phoneIntl: "", maps: "", desc: "",
        services: [], servicePrices: {}, serviceDesc: {}, servicePhotos: {},
        hours: [], cover: "", photos: [], logo: "", social: {}, since: "", verified: false
      };
      merged.push(centreFromFirestore(dd, base));
      mergedBySlug[merged[merged.length - 1].slug] = merged[merged.length - 1];
      return;
    }
    var base2 = mergedBySlug[slug];
    if (!base2) return;
    var live = centreFromFirestore(dd, base2);
    Object.keys(live).forEach(function (k) { base2[k] = live[k]; });
  });
  // Région du centre : recalculée depuis sa ville (comme l'application).
  merged.forEach(function (c) {
    var found = null;
    CITIES.forEach(function (x) { if (x.name === c.city) found = x; });
    if (found) c.region = found.region;
  });
  // Surcharge d'état (vérifié / suspendu) depuis fiches_etat.
  (etat || []).forEach(function (e) {
    var c = mergedBySlug[e.slug || e.centreSlug];
    if (!c) return;
    if (e.verified !== undefined) c.verified = e.verified;
    if (e.suspended !== undefined) c.suspended = e.suspended;
  });
  merged.forEach(pruneServiceMaps);
  return merged;
}
function validateCentres(centres) {
  if (!centres.length) throw new Error("Aucun centre après fusion — build abandonné (Firestore vide ou injoignable).");
  centres.forEach(function (c) {
    if (!c.slug || !c.name || !c.city) throw new Error("Centre invalide (slug/nom/ville manquant) : " + JSON.stringify(c).slice(0, 200));
    if (!Array.isArray(c.services) || !c.services.length) throw new Error("Centre sans service : " + c.slug);
  });
}

/* ------------------------------------------------------------------ */
/* Liens : URL propre si la route est générée, ancre sinon             */
/* ------------------------------------------------------------------ */
let GENERATED = new Set();
function link(route) {
  var q = "";
  var qi = route.indexOf("?");
  if (qi >= 0) { q = route.slice(qi); route = route.slice(0, qi); }
  if (route === "" || route === "accueil") return "/" + (q ? q : "");
  if (GENERATED.has(route)) return "/" + route + "/" + (q ? q : "");
  return "#/" + route + q;
}

/* ------------------------------------------------------------------ */
/* Méta par route (mêmes textes que routeMeta dans l'application)      */
/* ------------------------------------------------------------------ */
const HOME_TITLE = "Annuaire Hijama Maroc — Centres vérifiés, 375 villes";
const HOME_DESC = "Annuaire des centres de hijama (حجامة, cupping) vérifiés au Maroc : trouvez un centre près de chez vous parmi 375 villes, hygiène contrôlée et avis vérifiés.";
function metaFor(route, ctx) {
  var seg = route.split("/").filter(Boolean);
  if (!seg.length || seg[0] === "accueil") return { title: HOME_TITLE, desc: HOME_DESC };
  if (seg[0] === "centres") return { title: "Tous les centres de hijama vérifiés au Maroc — Annuaire Hijama", desc: "Liste des centres de hijama vérifiés au Maroc : hygiène contrôlée, avis vérifiés, coordonnées et tarifs." };
  if (seg[0] === "villes") return { title: "Hijama par ville — 375 villes du Maroc — Annuaire Hijama", desc: "Trouvez un centre de hijama vérifié dans votre ville, parmi 375 villes du Maroc." };
  if (seg[0] === "ville" && seg[1] && ctx.cities[seg[1]])
    return { title: "Hijama à " + ctx.cities[seg[1]].name + " — Centres vérifiés | Annuaire Hijama", desc: "Centres de hijama vérifiés à " + ctx.cities[seg[1]].name + " : adresses, avis vérifiés et hygiène contrôlée. Trouvez un centre près de chez vous." };
  if (seg[0] === "centre" && seg[1] && ctx.centres[seg[1]]) {
    var c = ctx.centres[seg[1]];
    return { title: c.name + " — Annuaire Hijama", desc: (c.desc || HOME_DESC).slice(0, 160) };
  }
  if (seg[0] === "service" && seg[1] && seg[2] !== undefined && ctx.centres[seg[1]]) {
    var cc = ctx.centres[seg[1]];
    var s = (cc.services || [])[parseInt(seg[2], 10)];
    if (s) return { title: s + " — " + cc.name + " — Annuaire Hijama", desc: (cc.serviceDesc && cc.serviceDesc[s]) ? cc.serviceDesc[s].slice(0, 160) : HOME_DESC };
    return { title: cc.name + " — Annuaire Hijama", desc: (cc.desc || HOME_DESC).slice(0, 160) };
  }
  if (seg[0] === "guides") return { title: "Guides et conseils hijama — Annuaire Hijama", desc: "Guides pratiques : choisir un centre, hygiène et sécurité, première séance, questions fréquentes sur la hijama." };
  if (seg[0] === "guide" && seg[1] && ctx.guides[seg[1]]) {
    var g = ctx.guides[seg[1]];
    return { title: g.title + " — Annuaire Hijama", desc: (g.intro || HOME_DESC).slice(0, 160) };
  }
  if (seg[0] === "verification") return { title: "Notre processus de vérification — Annuaire Hijama", desc: "Chaque centre publié est contacté, photographié et contrôlé sur l'hygiène avant acceptation. Voici notre processus." };
  if (seg[0] === "inscription") return { title: "Inscrire votre centre de hijama — Annuaire Hijama", desc: "Professionnels : inscrivez votre centre dans l'annuaire après notre contrôle d'hygiène." };
  return { title: HOME_TITLE, desc: HOME_DESC };
}

/* ------------------------------------------------------------------ */
/* Blocs partagés (ports fidèles de l'application)                     */
/* ------------------------------------------------------------------ */
function adSlot(tall) {
  return '<div class="ad-slot' + (tall ? " tall" : "") + '" aria-label="Espace publicitaire">Espace publicitaire</div>';
}
function trackerBlock() {
  return '<section class="block" id="tracker"><div class="tracker"><div class="tracker-body"><div><span class="badge gold">Pour les professionnels</span>'
    + '<h2 style="margin-top:10px">Vous gérez un centre de hijama ? Voici son <em>assistant intelligent</em></h2></div>'
    + '<p>L\'annuaire fait découvrir votre centre. Pour le gérer au quotidien, nous présentons aux propriétaires de centres le <b>Hijama Tracker Pro</b> : le suivi des séances, des clients et des points de hijama, pensé pour les praticiens.</p>'
    + '<ul><li>Fiches clients et historique des séances</li><li>Cartographie interactive des points</li><li>Signalement des contre-indications avant chaque séance</li></ul>'
    + '<p class="tracker-note"><b>Deux outils, un même objectif :</b> être trouvé par les clients, puis travailler comme un professionnel organisé.</p>'
    + '<div class="tracker-actions"><a class="btn" href="https://baytwikaya.site/fr/centers" target="_blank" rel="noopener">Découvrir l\'offre pour les centres</a></div>'
    + '<div class="tracker-links"><a href="' + link("inscription") + '">Ou inscrivez d\'abord votre centre dans l\'annuaire →</a>'
    + '<a href="#/espace">Déjà publié ? Gérez votre fiche dans votre Espace centre →</a></div></div>'
    + '<figure class="tracker-media"><img src="/tracker.jpg" alt="L\'assistant intelligent du Hijama Tracker, un petit robot, désigne le panneau de la carte des points de hijama sur le corps humain" width="800" height="600"><figcaption>L\'assistant intelligent vous montre la carte des points de hijama</figcaption></figure>'
    + '</div></section>';
}
function coverPosOf(c) { var p = (c && typeof c.coverPos === "number" && isFinite(c.coverPos)) ? c.coverPos : 40; return Math.max(0, Math.min(100, p)); }
function coverHTML(c, cls, hideBadges) {
  var badges = hideBadges ? "" : '<div class="cover-badges"><span class="badge">✓ Centre vérifié</span>' + (c.featured ? '<span class="badge gold">Premier centre listé</span>' : "") + "</div>";
  if (c.cover) return '<figure class="' + cls + '"><img src="' + c.cover + '" alt="Photo de couverture — ' + esc(c.name) + '" loading="lazy" style="object-position:center ' + coverPosOf(c) + '%">' + badges + "</figure>";
  if (hideBadges) return "";
  return '<div class="card-badges-row">' + badges + "</div>";
}
const ICON_IG = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#fff" stroke-width="2" aria-hidden="true"><rect x="2.5" y="2.5" width="19" height="19" rx="5.5"/><circle cx="12" cy="12" r="4.2"/><circle cx="17.4" cy="6.6" r="1.3" fill="#fff" stroke="none"/></svg>';
const ICON_TT = '<svg viewBox="0 0 24 24" width="24" height="24" fill="#fff" aria-hidden="true"><path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"/></svg>';
const ICON_FB = '<svg viewBox="0 0 24 24" width="24" height="24" fill="#fff" aria-hidden="true"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>';
function avatarHTML(c, big) {
  var src = c.logo || (c.photos && c.photos.length ? c.photos[0] : null) || c.cover || "/logo.png";
  return '<div class="centre-id"><span class="centre-avatar' + (big ? " big" : "") + '"><img src="' + src + '" alt="Logo / photo de profil — ' + esc(c.name) + '" loading="lazy"></span></div>';
}
function socialHTML(c) {
  var s = c.social || {};
  var links = [];
  if (s.instagram) links.push('<a href="' + esc(s.instagram) + '" target="_blank" rel="noopener" class="soc soc-ig" aria-label="Instagram">' + ICON_IG + "</a>");
  if (s.tiktok) links.push('<a href="' + esc(s.tiktok) + '" target="_blank" rel="noopener" class="soc soc-tt" aria-label="TikTok">' + ICON_TT + "</a>");
  if (s.facebook) links.push('<a href="' + esc(s.facebook) + '" target="_blank" rel="noopener" class="soc soc-fb" aria-label="Facebook">' + ICON_FB + "</a>");
  if (!links.length) return "";
  return '<div class="social-icons" aria-label="Réseaux sociaux du centre">' + links.join("") + "</div>";
}
var SVC_SHORT = { "Alignement osseux avec diagnostic précis": "Alignement osseux", "Massage sportif aux outils de grattage (IASTM)": "Massage IASTM (grattage)", "Acupuncture (aiguilles chinoises)": "Acupuncture" };
function svcShort(s) {
  if (SVC_SHORT[s]) return SVC_SHORT[s];
  if (s.length > 34) { var base = s.split("(")[0].trim(); if (base.length >= 10 && base.length < s.length) return base; }
  return s;
}
function cardAvisLine(c) {
  var n = c.ratingCount || 0;
  var l = '<a href="' + link("centre/" + c.slug) + '">voir la fiche</a>';
  if (n > 0) {
    var avg = c.ratingAvg || 0;
    var full = Math.round(avg);
    var avgTxt = avg.toFixed(1).replace(".", ",");
    return '<span class="stars" aria-hidden="true">' + "★".repeat(full) + "☆".repeat(5 - full) + "</span><span><b>" + avgTxt + " / 5</b> — " + n + " avis publié" + (n > 1 ? "s" : "") + " sur cet annuaire — " + l + "</span>";
  }
  return "<span>Avis publiés après relecture — " + l + "</span>";
}
function cardLoc(c) { var a = (c.address || "").split(","); var area = a.length > 1 ? a[0].trim() : ""; return area ? area + ", " + c.city : c.city; }
function minPrice(c) {
  var pr = c.servicePrices || {}; var min = null;
  Object.keys(pr).forEach(function (k) { var v = pr[k]; if (typeof v === "number" && isFinite(v) && v > 0 && (min === null || v < min)) min = v; });
  return min;
}
function centreCard(c) {
  var mp = minPrice(c);
  return '<article class="card centre-card' + (c.cover ? "" : " no-cover") + '" data-href="' + link("centre/" + c.slug) + '">' + coverHTML(c, "cover")
    + avatarHTML(c)
    + '<div class="card-body">'
    + '<h3><a href="' + link("centre/" + c.slug) + '">' + esc(c.name) + "</a></h3>"
    + '<div class="avis-line">' + cardAvisLine(c) + "</div>"
    + '<p class="meta">📍 ' + esc(cardLoc(c)) + "</p>"
    + '<p class="svc-line">' + c.services.slice(0, 2).map(function (s) { return esc(svcShort(s)); }).join(" · ") + (c.services.length > 2 ? " …" : "") + "</p>"
    + (mp !== null ? '<p class="price-from">À partir de ' + mp + " DH</p>" : "")
    + '<div class="actions"><a class="btn small" href="' + link("centre/" + c.slug) + '">Voir la fiche</a><a class="btn small ghost" href="tel:' + c.phoneIntl + '" onclick="event.stopPropagation()">📞 ' + c.phone + "</a></div>"
    + "</div></article>";
}
/* Liste des services : en contenu pré-rendu, chaque ligne est un LIEN
   vers sa page service (l'application utilise des boutons — même
   apparence, la classe .svc-row est commune). */
function serviceListHTML(c) {
  var photos = c.photos || []; var svcPhotos = c.servicePhotos || {};
  return '<div class="svc-list" id="svcList">' + c.services.map(function (s, i) {
    var src = svcPhotos[s] || photos[i] || null;
    var thumb = src ? '<img src="' + src + '" alt="Photo — ' + esc(s) + '">' : '<span class="svc-thumb-ph" aria-hidden="true">📷</span>';
    return '<a class="svc-row' + (src ? "" : " no-photo") + '" href="' + link("service/" + c.slug + "/" + i) + '">' + thumb + '<span class="svc-name">' + esc(s) + '</span><span class="svc-arrow" aria-hidden="true">›</span></a>';
  }).join("") + "</div>";
}
/* Sélecteur de ville du formulaire d'inscription : grandes villes
   d'abord (MAJOR_CITIES, dans l'ordre), puis toutes les autres villes
   regroupées par région. La valeur reste le slug de la ville. */
function majorCityOptions(preselect, CITIES, REGIONS, MAJOR_CITIES) {
  function opt(c, sel) { return '<option value="' + c.slug + '"' + (sel ? " selected" : "") + ">" + esc(c.name) + " — " + esc(c.region) + "</option>"; }
  var majors = [], majorSlugs = {};
  MAJOR_CITIES.forEach(function (n) { var c = null; CITIES.forEach(function (x) { if (x.name === n) c = x; }); if (c) { majors.push(c); majorSlugs[c.slug] = 1; } });
  var out = '<optgroup label="Grandes villes">' + majors.map(function (c) { return opt(c, preselect === c.slug); }).join("") + "</optgroup>";
  Object.keys(REGIONS).forEach(function (r) {
    var rest = [];
    REGIONS[r].forEach(function (n) { var c = null; CITIES.forEach(function (x) { if (x.name === n) c = x; }); if (c && !majorSlugs[c.slug]) rest.push(c); });
    if (!rest.length) return;
    out += '<optgroup label="' + esc(r) + '">' + rest.map(function (c) { return '<option value="' + c.slug + '"' + (preselect === c.slug ? " selected" : "") + ">" + esc(c.name) + "</option>"; }).join("") + "</optgroup>";
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* Vues pré-rendues (ports fidèles de l'application ; les liens       */
/* internes utilisent link() : URL propre si la page est générée,    */
/* ancre #/… sinon). Les formulaires sont inertes avant le démarrage */
/* de l'application, qui les re-rend et y attache ses gestionnaires.  */
/* ------------------------------------------------------------------ */
function sortCentres(list) {
  return list.slice().sort(function (a, b) { var av = !!a.verified, bv = !!b.verified; if (av !== bv) return av ? -1 : 1; var af = !!a.featured, bf = !!b.featured; if (af !== bf) return af ? -1 : 1; return 0; });
}
function centresOf(slug, CENTRES) { return sortCentres(CENTRES.filter(function (c) { return !c.suspended && citySlug(c.city) === slug; })); }

function viewHome(ctx) {
  var CENTRES = ctx.CENTRES, CITIES = ctx.CITIES, GUIDES = ctx.GUIDES;
  var cityOpts = CITIES.map(function (c) { return '<option value="' + c.slug + '">' + esc(c.name) + " — " + esc(c.region) + "</option>"; }).join("");
  var topCities = ["Casablanca", "Rabat", "Marrakech", "Agadir", "Tanger", "Fès", "Meknès", "Oujda", "Kénitra", "Tétouan", "Laâyoune", "Dakhla"];
  return '<div class="hero"><div class="wrap"><h1>Trouvez un centre de <em>hijama</em> vérifié, près de chez vous</h1>'
    + '<p>Chaque centre publié dans cet annuaire a été contacté par notre équipe, a transmis des photos de ses locaux et a passé un contrôle d\'hygiène avant acceptation. Pas d\'inscription automatique, pas de fiche fantôme.</p>'
    + '<p>Que vous cherchiez une hijama humide ou une hijama sèche, cet annuaire vous aide à trouver un centre de hijama vérifié près de chez vous, partout au Maroc — de Casablanca à Dakhla. Chaque centre listé a été contrôlé sur son hygiène avant publication, pour que vous réserviez en confiance.</p>'
    + '<form class="searchbox" id="heroSearch"><div><label for="hs-city">Ville</label><select id="hs-city"><option value="">Toutes les villes</option>' + cityOpts + '</select></div>'
    + '<div><label for="hs-q">Service ou nom du centre</label><input id="hs-q" type="search" placeholder="Ex. hijama humide, acupuncture, alignement…"></div>'
    + '<div style="align-self:end"><button class="btn" type="submit" style="width:100%">Rechercher</button></div></form>'
    + '<div class="stats"><div><b>375</b><span>villes et centres urbains couverts</span></div><div><b>12</b><span>régions du Royaume</span></div><div><b>100 %</b><span>des fiches vérifiées à la main</span></div><div><b>0</b><span>publication sans contrôle d\'hygiène</span></div></div>'
    + "</div></div>"
    + '<div class="wrap">' + adSlot(false)
    + '<section class="block"><div class="sec-head"><h2>Centres vérifiés</h2><a href="' + link("centres") + '">Tous les centres →</a></div>'
    + '<p class="sec-sub">L\'annuaire démarre avec son premier centre vérifié. Les suivants rejoindront la liste au rythme des contrôles — jamais avant.</p>'
    + '<div class="grid centres">' + sortCentres(CENTRES.filter(function (c) { return !c.suspended; })).map(centreCard).join("") + '<article class="card" style="display:flex;flex-direction:column;gap:8px;justify-content:center;text-align:center"><h3>Votre centre n\'est pas encore là ?</h3><p>Les inscriptions sont ouvertes dans les 375 villes. Chaque demande passe par notre vérification d\'hygiène avant publication.</p><div class="actions" style="justify-content:center"><a class="btn small" href="' + link("inscription") + '">Inscrire mon centre</a></div></article></div></section>'
    + '<section class="block"><div class="sec-head"><h2>Les grandes villes</h2><a href="' + link("villes") + '">Les 375 villes →</a></div>'
    + '<div class="chips">' + topCities.map(function (n) { var c = CITIES.filter(function (x) { return x.name === n; })[0]; var k = centresOf(c.slug, CENTRES).length; return '<a class="chip" href="' + link("ville/" + c.slug) + '">' + esc(n) + (k ? '<span class="n">' + k + " centre" + (k > 1 ? "s" : "") + "</span>" : '<span class="n">bientôt</span>') + "</a>"; }).join("") + "</div></section>"
    + '<section class="block"><div class="sec-head"><h2>Comment un centre entre dans l\'annuaire</h2><a href="' + link("verification") + '">Le détail →</a></div>'
    + '<div class="steps"><div class="step"><div class="num">1</div><h3>Demande d\'inscription</h3><p>Le centre remplit le formulaire avec ses coordonnées et ses services.</p></div>'
    + '<div class="step"><div class="num">2</div><h3>Contact et photos</h3><p>Nous contactons le centre et demandons des photos réelles de ses locaux et de ses salles de soins.</p></div>'
    + '<div class="step"><div class="num">3</div><h3>Contrôle d\'hygiène</h3><p>Matériel à usage unique, stérilisation, gestion des déchets : la fiche n\'avance que si les critères sont remplis.</p></div>'
    + '<div class="step"><div class="num">4</div><h3>Publication + espace personnel</h3><p>Nous publions la fiche, puis le centre reçoit son propre espace : il y gère sa fiche et y ajoute ses autres services ; chaque modification est publiée immédiatement sur sa fiche publique. Aucune place achetée.</p></div></div></section>'
    + adSlot(true)
    + '<section class="block"><div class="sec-head"><h2>Guides et conseils</h2><a href="' + link("guides") + '">Tous les guides →</a></div><div class="grid c3">'
    + GUIDES.slice(0, 3).map(function (g) { return '<article class="card"><span class="badge grey">' + esc(g.tag) + '</span><h3 style="margin-top:8px"><a href="' + link("guide/" + g.slug) + '">' + esc(g.title) + '</a></h3><p>' + esc(g.intro) + '</p><a href="' + link("guide/" + g.slug) + '" style="font-weight:700">Lire le guide →</a></article>'; }).join("")
    + "</div></section>" + trackerBlock() + "</div>";
}
function viewCentres(ctx) {
  var CENTRES = ctx.CENTRES;
  var list = sortCentres(CENTRES.filter(function (c) { return !c.suspended; }));
  return '<div class="wrap"><p class="crumb"><a href="' + link("") + '">Accueil</a> › Centres</p><h1 style="font-size:1.8rem">Centres de hijama vérifiés</h1>'
    + '<p class="sec-sub" style="margin-top:8px">Uniquement des centres contrôlés par notre équipe : contact direct, photos des locaux et vérification des critères d\'hygiène avant publication.</p>'
    + '<form class="toolbar" id="cSearch"><input type="search" id="cq" placeholder="Rechercher un centre, un service, une ville…"><button class="btn small" type="submit">Rechercher</button></form>'
    + (list.length ? '<div class="grid centres">' + list.map(centreCard).join("") + "</div>" : '<div class="empty"><h3 style="margin-bottom:6px">Aucun centre ne correspond</h3><p>Essayez un autre service ou parcourez les villes — de nouveaux centres sont ajoutés après chaque vérification.</p><p style="margin-top:12px"><a class="btn small" href="' + link("villes") + '">Voir les villes</a></p></div>')
    + adSlot(false) + trackerBlock() + "</div>";
}
function viewVilles(ctx) {
  var REGIONS = ctx.REGIONS, CENTRES = ctx.CENTRES;
  var html = '<div class="wrap"><p class="crumb"><a href="' + link("") + '">Accueil</a> › Villes</p><h1 style="font-size:1.8rem">Toutes les villes du Maroc</h1>'
    + '<p class="sec-sub" style="margin-top:8px">Les 375 villes et centres urbains du Royaume, région par région (périmètre urbain du recensement 2024). Cliquez sur une ville pour voir ses centres vérifiés — ou y inscrire le vôtre.</p>'
    + '<div class="toolbar"><input type="search" id="villeSearch" placeholder="Filtrer les villes… (ex. Tanger, Zagora, Sidi…)"></div><div id="villeList">';
  Object.keys(REGIONS).forEach(function (r) {
    html += '<div class="region" data-region="' + esc(r) + '"><h3>' + esc(r) + ' <span style="color:var(--ink2);font-weight:600;font-size:.85rem">(' + REGIONS[r].length + ')</span></h3><div class="chips">'
      + REGIONS[r].map(function (n) { var s = citySlug(n); var k = centresOf(s, CENTRES).length; return '<a class="chip" data-name="' + esc(n.toLowerCase()) + '" href="' + link("ville/" + s) + '">' + esc(n) + (k ? '<span class="n">' + k + " ✓</span>" : "") + "</a>"; }).join("") + "</div></div>";
  });
  html += "</div>" + adSlot(false) + "</div>";
  return html;
}
function viewVille(city, ctx) {
  var CENTRES = ctx.CENTRES, REGIONS = ctx.REGIONS;
  var slug = city.slug;
  var list = centresOf(slug, CENTRES);
  return '<div class="wrap"><p class="crumb"><a href="' + link("") + '">Accueil</a> › <a href="' + link("villes") + '">Villes</a> › ' + esc(city.name) + '</p>'
    + '<h1 style="font-size:1.8rem">Hijama à ' + esc(city.name) + '</h1><p class="sec-sub" style="margin-top:8px">Région ' + esc(city.region) + ". Centres de hijama vérifiés à " + esc(city.name) + " : admission contrôlée, hygiène vérifiée, fiche rédigée par notre équipe.</p>"
    + (list.length ? '<div class="grid centres">' + list.map(centreCard).join("") + "</div>"
      : '<div class="empty"><h3 style="margin-bottom:6px">Aucun centre vérifié pour le moment à ' + esc(city.name) + '</h3><p>Nous n\'avons pas encore validé de centre dans cette ville — et nous préférons une page vide à une fiche non vérifiée. Vous y gérez un centre ? Passez la vérification et soyez le premier publié ici.</p><p style="margin-top:14px"><a class="btn small" href="' + link("inscription?ville=" + slug) + '">Inscrire un centre à ' + esc(city.name) + "</a></p></div>")
    + adSlot(false)
    + '<section class="block"><div class="sec-head"><h2>Autres villes de la région</h2><a href="' + link("villes") + '">Toutes les villes →</a></div><div class="chips">'
    + REGIONS[city.region].filter(function (n) { return n !== city.name; }).slice(0, 18).map(function (n) { return '<a class="chip" href="' + link("ville/" + citySlug(n)) + '">' + esc(n) + "</a>"; }).join("") + "</div></section>"
    + trackerBlock() + "</div>";
}
function avisPublishedHTML(c, avisList) {
  if (!avisList.length) {
    return '<div class="empty" style="margin-top:12px"><p style="font-size:1.6rem;margin:0 0 4px" aria-hidden="true">☆☆☆☆☆</p><h3 style="margin-bottom:6px">Aucun avis publié pour le moment</h3><p>Vous avez fait une séance dans ce centre ? Soyez le premier à partager votre expérience — votre avis paraîtra après relecture par notre équipe.</p></div>';
  }
  var sum = 0; avisList.forEach(function (a) { sum += (a.note || 0); });
  var avg = (sum / avisList.length).toFixed(1).replace(".", ",");
  var head = '<p class="avis-line" style="margin-top:12px"><span class="stars" aria-hidden="true">' + "★".repeat(Math.round(sum / avisList.length)) + "☆".repeat(5 - Math.round(sum / avisList.length)) + "</span><span><b>" + avg + " / 5</b> — " + avisList.length + " avis publié" + (avisList.length > 1 ? "s" : "") + " sur cet annuaire</span></p>";
  var shown = avisList.slice(0, 3);
  var cards = shown.map(function (a) {
    var st = "★".repeat(a.note || 0) + "☆".repeat(5 - (a.note || 0));
    return '<article class="card" style="margin-top:12px;box-shadow:none"><div class="avis-line"><span class="stars" aria-hidden="true">' + st + "</span><b>" + esc(a.nom || "Visiteur") + "</b>" + (a.dateSeance ? "<span>· Séance du " + esc(a.dateSeance) + "</span>" : "") + '</div><p style="margin-top:8px">' + esc(a.texte || "") + "</p></article>";
  }).join("");
  return head + cards + ((avisList.length > 3) ? '<div style="text-align:center;margin-top:12px"><button class="btn ghost" type="button" id="avisMore">Voir les ' + avisList.length + " avis</button></div>" : "");
}
function viewCentre(c, ctx) {
  var CENTRES = ctx.CENTRES;
  var avisList = ctx.avisByCentre[c.slug] || [];
  var photos = c.photos || [];
  var pinSrc = c.logo || (photos.length ? photos[0] : null) || c.cover || null;
  var pinLetter = esc(((c.name || "?").replace(/^\s+/, "").charAt(0) || "?").toUpperCase());
  var nSvc = (c.services || []).length;
  var sinceTxt = sinceLabel(c);
  var waNum = (c.phoneIntl || "").replace(/[^0-9]/g, "");
  var waHref = waNum ? "https://wa.me/" + waNum + "?text=" + encodeURIComponent("Bonjour, je vous contacte depuis l'Annuaire Hijama.") : "";
  var descLong = (c.desc || "").length > 280;
  var aboutHTML = descLong
    ? '<p><span id="aboutShort">' + esc(c.desc.slice(0, 280)) + '…</span><span id="aboutFull" hidden>' + esc(c.desc) + '</span> <a href="javascript:void(0)" id="aboutToggle">Lire la suite</a></p>'
    : "<p>" + esc(c.desc) + "</p>";
  var others = centresOf(citySlug(c.city), CENTRES).filter(function (x) { return x.slug !== c.slug; });
  var similarHTML = others.length ? '<section class="block" style="margin-top:26px"><div class="sec-head"><h2>Autres centres dans la même ville</h2></div><p class="sec-sub">D\'autres centres de hijama vérifiés à ' + esc(c.city) + '.</p><div class="grid">' + others.map(function (x) { return centreCard(x); }).join("") + "</div></section>" : "";
  return '<div class="wrap fiche' + (c.cover ? "" : " no-cover") + '"><p class="crumb"><a href="' + link("") + '">Accueil</a> › <a href="' + link("centres") + '">Centres</a> › ' + esc(c.city) + "</p>"
    + coverHTML(c, "fiche-cover", true)
    + '<div class="fiche-id"><div class="fiche-pin">' + (pinSrc ? '<img src="' + pinSrc + '" alt="Logo — ' + esc(c.name) + '">' : '<span class="pin-letter">' + pinLetter + "</span>") + "</div>"
    + '<div class="fiche-id-txt"><span class="fiche-slug">@' + esc(c.slug) + "</span>"
    + "<h1>" + esc(c.name) + (c.verified ? ' <span class="badge" style="vertical-align:middle">✓ Vérifié</span>' : "") + "</h1>"
    + '<p class="fiche-sub">Centre de hijama · 📍 ' + esc(c.city) + "</p></div></div>"
    + '<div class="fiche-pills">'
    + (sinceTxt ? '<span class="fiche-pill">Membre depuis ' + esc(sinceTxt) + "</span>" : "")
    + '<span class="fiche-pill">' + nSvc + " service" + (nSvc > 1 ? "s" : "") + "</span>"
    + '<span class="fiche-pill" id="pillAvis">' + (c.ratingCount || 0) + " avis</span></div>"
    + '<div class="fiche-cols"><div class="fiche-main">'
    + '<section class="card fiche-sec"><h3>À propos</h3>' + aboutHTML + "</section>"
    + '<section class="card fiche-sec"><h3>Services <span class="pill-count">' + nSvc + ' services</span></h3>' + serviceListHTML(c) + '<p style="font-size:.88rem;margin-top:12px">Les tarifs sont communiqués par le centre lors de la prise de rendez-vous.</p></section>'
    + adSlot(false)
    + (photos.length ? '<section class="card fiche-sec"><h3>Photos du centre</h3><p>Photos transmises par le centre et relues par notre équipe avant publication.</p><div class="gallery">' + photos.map(function (p, i) { return '<a href="' + p + '" target="_blank" rel="noopener"><img src="' + p + '" alt="Photo ' + (i + 1) + " — " + esc(c.name) + '" loading="lazy"></a>'; }).join("") + "</div></section>" : "")
    + '<section class="card fiche-sec" id="avisCard"><span class="badge gold">Avis de l\'annuaire</span><h3 style="margin-top:8px">Les avis de nos visiteurs</h3>'
    + '<p>Les avis publiés ici sont <b>ceux de cet annuaire</b> — déposés sur cette page, relus par notre équipe avant publication. Nous n\'importons ni n\'affichons les avis d\'autres plateformes.</p>'
    + '<div id="avisZone"><form class="avis" id="avisForm" novalidate>'
    + '<div><label>Votre note *</label><div class="stars-input" id="starsInput">'
    + [5, 4, 3, 2, 1].map(function (n) { return '<label class="staropt"><input type="radio" name="a-note" value="' + n + '"><span class="st">★</span>' + n + "</label>"; }).join("")
    + "</div></div>"
    + '<div><label for="a-name">Votre nom ou prénom *</label><input type="text" id="a-name" placeholder="Ex. Salma B."></div>'
    + '<div><label for="a-text">Votre avis *</label><textarea id="a-text" rows="3" placeholder="Accueil, propreté, déroulement de la séance, suivi… Racontez votre expérience."></textarea></div>'
    + '<p class="notice" style="margin:0">Votre avis sera relu par notre équipe avant publication.</p>'
    + '<div style="text-align:center"><button class="btn" type="submit" id="avisSubmit">Envoyer mon avis pour relecture</button></div></form></div>'
    + '<div id="avisPublished">' + avisPublishedHTML(c, avisList) + "</div></section>"
    + '<section class="card fiche-sec"><h3>Horaires</h3><table class="hours" style="margin-top:8px">' + c.hours.map(function (h) { return "<tr><td>" + esc(hourDay(h)) + "</td><td>" + esc(hourRange(h)) + "</td></tr>"; }).join("") + "</table></section>"
    + '</div><aside class="fiche-side">'
    + '<div class="card"><h3>Contact</h3>'
    + '<div class="phone-box"><div><span class="ph-label">TÉLÉPHONE</span><span class="ph-num">' + esc(phoneDisplay(c.phoneIntl)) + '</span></div><button class="ph-copy" type="button" id="copyPhoneIcon" data-phone="' + esc(c.phoneIntl) + '" aria-label="Copier le numéro" title="Copier le numéro">📋</button></div>'
    + '<a class="btn" href="tel:' + c.phoneIntl + '" style="width:100%;justify-content:center;margin-top:10px">📞 Appeler le centre</a>'
    + '<button class="btn ghost" type="button" id="copyPhoneBtn" data-phone="' + esc(c.phoneIntl) + '" style="width:100%;justify-content:center;margin-top:8px">📋 Copier le numéro</button>'
    + (waHref ? '<a class="btn" href="' + waHref + '" target="_blank" rel="noopener" style="width:100%;justify-content:center;margin-top:8px">💬 WhatsApp</a>' : "")
    + '<div style="display:flex;gap:8px;margin-top:10px"><button class="btn ghost small" type="button" id="shareBtn" style="flex:1">↗ Partager</button><button class="btn ghost small like-btn" type="button" id="likeBtn" style="flex:1" aria-pressed="false">♡ J\'aime</button></div></div>'
    + '<div class="card"><h3>Adresse</h3>'
    + '<a class="mini-map" href="' + esc(c.maps) + '" target="_blank" rel="noopener" aria-label="Voir sur Google Maps"><span class="mini-pin" aria-hidden="true">📍</span></a>'
    + '<p style="font-weight:700;margin:12px 0 4px">' + esc(c.address) + "</p>"
    + '<p style="margin:0 0 10px"><a href="' + esc(c.maps) + '" target="_blank" rel="noopener">Voir sur Google Maps</a></p>'
    + '<a class="pill-link" href="' + esc(c.maps) + '" target="_blank" rel="noopener">Itinéraire →</a></div>'
    + (function () { var sh = socialHTML(c); return sh ? '<div class="card"><h3>Réseaux sociaux</h3>' + sh + "</div>" : ""; })()
    + (c.verified ? '<div class="card"><h3>Fiche vérifiée</h3><p><span class="badge gold">Hygiène contrôlée</span></p><p style="margin-top:10px">Cette fiche a été créée par l\'équipe de l\'annuaire après contact avec le centre, réception de photos de ses locaux et contrôle des critères d\'hygiène.</p><a href="' + link("verification") + '" style="font-weight:700">Notre processus de vérification →</a></div>' : "")
    + '<div class="own-space"><span aria-hidden="true" style="font-size:1.3rem;line-height:1">🔑</span><p style="margin:0"><b>C\'est votre centre ?</b> Ce centre a son propre Espace centre, réservé à son responsable : il y modifie cette fiche — informations, horaires, visuels — et y ajoute ses autres services s\'il en propose. Chaque modification est publiée immédiatement sur sa fiche publique.<br><a href="#/espace" style="font-weight:700">Ouvrir mon Espace centre →</a></p></div>'
    + adSlot(true)
    + "</aside></div>"
    + similarHTML
    + trackerBlock()
    + "</div>";
}
function viewService(c, i) {
  var svcs = c.services || [];
  var s = svcs[i];
  var svcPhotos = c.servicePhotos || {};
  var photos = c.photos || [];
  var src = svcPhotos[s] || photos[i] || null;
  var prices = c.servicePrices || {};
  var descs = c.serviceDesc || {};
  var price = prices[s];
  var hasPrice = (typeof price === "number" && isFinite(price) && price > 0);
  var priceBox = hasPrice ? '<div class="price-box"><span class="price-label">Tarif</span><span class="price-val">' + price + " DH</span></div>" : "";
  var priceNote = '<p class="notice" style="margin-top:0">Les tarifs sont communiqués par le centre lors de la prise de rendez-vous.</p>';
  var desc = descs[s] || "";
  var waNum = (c.phoneIntl || "").replace(/[^0-9]/g, "");
  var waHref = waNum ? "https://wa.me/" + waNum + "?text=" + encodeURIComponent("Bonjour, je vous contacte depuis l'Annuaire Hijama au sujet de : " + s) : "";
  return '<div class="wrap fiche"><p class="crumb"><a href="' + link("") + '">Accueil</a> › <a href="' + link("centres") + '">Centres</a> › <a href="' + link("centre/" + c.slug) + '">' + esc(c.name) + "</a> › " + esc(s) + "</p>"
    + '<span class="badge gold">Hijama</span>'
    + '<h1 style="font-size:1.9rem;line-height:1.15;margin:10px 0 4px">' + esc(s) + "</h1>"
    + '<p class="fiche-sub">Service proposé par <a href="' + link("centre/" + c.slug) + '" style="font-weight:700">' + esc(c.name) + "</a> · 📍 " + esc(c.city) + "</p>"
    + '<div class="svc-layout"><div class="svc-info">'
    + ((!src && hasPrice) ? priceBox : (!hasPrice ? priceNote : ""))
    + (desc ? '<section class="card fiche-sec"><h3>À propos de ce service</h3><p>' + esc(desc) + "</p></section>" : "")
    + '<div class="card"><h3>' + esc(c.name) + "</h3><p style=\"margin:4px 0\">📍 " + esc(c.city) + "</p><p style=\"margin:0 0 10px\">" + esc(c.address) + '</p><a class="btn" href="' + link("centre/" + c.slug) + '" style="width:100%;justify-content:center">Voir la fiche du centre</a></div>'
    + '<div class="card"><h3>Contact</h3>'
    + '<div class="phone-box"><div><span class="ph-label">TÉLÉPHONE</span><span class="ph-num">' + esc(phoneDisplay(c.phoneIntl)) + '</span></div><button class="ph-copy" type="button" id="copyPhoneIcon" data-phone="' + esc(c.phoneIntl) + '" aria-label="Copier le numéro" title="Copier le numéro">📋</button></div>'
    + '<a class="btn" href="tel:' + c.phoneIntl + '" style="width:100%;justify-content:center;margin-top:10px">📞 Appeler le centre</a>'
    + '<button class="btn ghost" type="button" id="copyPhoneBtn" data-phone="' + esc(c.phoneIntl) + '" style="width:100%;justify-content:center;margin-top:8px">📋 Copier le numéro</button>'
    + (waHref ? '<a class="btn" href="' + waHref + '" target="_blank" rel="noopener" style="width:100%;justify-content:center;margin-top:8px">💬 WhatsApp</a>' : "")
    + "</div></div>"
    + (src ? '<div class="svc-media"><div class="svc-hero"><img src="' + src + '" alt="Photo — ' + esc(s) + '" loading="lazy" id="svcPhotoImg"></div>' + priceBox + "</div>" : "")
    + "</div>"
    + '<p style="margin-top:18px"><a href="' + link("centre/" + c.slug) + '" style="font-weight:700">← Retour à la fiche de ' + esc(c.name) + "</a></p>"
    + "</div>";
}
function viewGuides(ctx) {
  var GUIDES = ctx.GUIDES;
  return '<div class="wrap"><p class="crumb"><a href="' + link("") + '">Accueil</a> › Guides</p><h1 style="font-size:1.8rem">Guides et conseils hijama</h1>'
    + '<p class="sec-sub" style="margin-top:8px">Des textes écrits par notre équipe : choisir un centre, comprendre l\'hygiène exigée, préparer une première séance.</p>'
    + '<div class="grid c2">' + GUIDES.map(function (g) { return '<article class="card"><span class="badge grey">' + esc(g.tag) + '</span><h3 style="margin-top:8px"><a href="' + link("guide/" + g.slug) + '">' + esc(g.title) + '</a></h3><p>' + esc(g.intro) + '</p><a href="' + link("guide/" + g.slug) + '" style="font-weight:700">Lire le guide →</a></article>'; }).join("") + "</div>"
    + adSlot(false) + "</div>";
}
function viewGuide(g, ctx) {
  var GUIDES = ctx.GUIDES;
  return '<div class="wrap"><p class="crumb"><a href="' + link("") + '">Accueil</a> › <a href="' + link("guides") + '">Guides</a> › ' + esc(g.tag) + "</p>"
    + '<span class="badge grey">' + esc(g.tag) + '</span><h1 style="font-size:1.8rem;margin-top:10px;max-width:760px">' + esc(g.title) + "</h1>"
    + '<p class="sec-sub" style="margin-top:10px">' + esc(g.intro) + "</p>"
    + '<div class="card" style="max-width:820px"><ol style="margin:0;padding-left:22px;display:grid;gap:12px">' + g.points.map(function (p) { return "<li>" + esc(p) + "</li>"; }).join("") + "</ol></div>"
    + adSlot(false)
    + '<section class="block"><div class="sec-head"><h2>Autres guides</h2><a href="' + link("guides") + '">Tous les guides →</a></div><div class="grid c3">'
    + GUIDES.filter(function (x) { return x.slug !== g.slug; }).slice(0, 3).map(function (x) { return '<article class="card"><span class="badge grey">' + esc(x.tag) + '</span><h3 style="margin-top:8px"><a href="' + link("guide/" + x.slug) + '">' + esc(x.title) + '</a></h3><a href="' + link("guide/" + x.slug) + '" style="font-weight:700">Lire →</a></article>'; }).join("") + "</div></section></div>";
}
function viewVerification() {
  return '<div class="wrap"><p class="crumb"><a href="' + link("") + '">Accueil</a> › Vérification</p><h1 style="font-size:1.8rem">Nous acceptons les centres — un par un, à la main</h1>'
    + '<p class="sec-sub" style="margin-top:8px">Cet annuaire n\'est pas un formulaire ouvert où chacun se publie tout seul. C\'est nous qui contrôlons les inscriptions, nous qui rédigeons les fiches, et nous qui décidons de publier — ou de refuser.</p>'
    + '<div class="steps"><div class="step"><div class="num">1</div><h3>La demande</h3><p>Le centre envoie sa demande via le formulaire d\'inscription : nom, ville, coordonnées, services.</p></div>'
    + '<div class="step"><div class="num">2</div><h3>Le contact</h3><p>Nous joignons le responsable pour confirmer que le centre existe, qu\'il reçoit du public et qu\'il répond de ses informations.</p></div>'
    + '<div class="step"><div class="num">3</div><h3>Les photos et l\'hygiène</h3><p>Le centre nous envoie des photos réelles de ses locaux et de ses salles de soins. Nous vérifions : ventouses et lames à usage unique, stérilisation, désinfection entre clients, gestion des déchets médicaux, questionnaire de santé avant séance.</p></div>'
    + '<div class="step"><div class="num">4</div><h3>La décision</h3><p>Critères remplis : nous publions la fiche. Critères manquants : la demande est mise en attente, avec ce qu\'il faut corriger. Aucun paiement n\'achète une acceptation.</p></div></div>'
    + '<div class="notice" style="margin-top:22px"><b>Pourquoi ce contrôle ?</b> Parce qu\'un annuaire qui publie tout le monde ne protège personne. Une fiche « vérifiée » doit vouloir dire quelque chose — pour les clients qui réservent, et pour les centres sérieux qui font l\'effort.</div>'
    + '<p style="margin-top:20px"><a class="btn" href="' + link("inscription") + '">Déposer une demande d\'inscription</a></p>'
    + adSlot(false) + trackerBlock() + "</div>";
}
function viewInscription(preselect, ctx) {
  var cityOpts = majorCityOptions(preselect, ctx.CITIES, ctx.REGIONS, ctx.MAJOR_CITIES);
  return '<div class="wrap"><p class="crumb"><a href="' + link("") + '">Accueil</a> › Inscription</p><h1 style="font-size:1.8rem">Inscrire votre centre de hijama</h1>'
    + '<p class="sec-sub" style="margin-top:8px">Remplissez la demande ci-dessous. Elle ne publie rien automatiquement : notre équipe vous contactera, vous demandera des photos de vos locaux et vérifiera vos critères d\'hygiène avant toute acceptation.</p>'
    + '<div id="regZone"><form class="reg card" id="regForm" novalidate>'
    + '<div class="half"><div><label for="r-name">Nom du centre *</label><input id="r-name" required placeholder="Ex. Centre Al Baraka"></div>'
    + '<div><label for="r-city">Ville *</label><select id="r-city" required><option value="">Choisir la ville…</option>' + cityOpts + "</select></div></div>"
    + '<div class="half"><div><label for="r-owner">Nom du responsable *</label><input id="r-owner" required placeholder="Nom et prénom"></div>'
    + '<div><label for="r-phone">Téléphone du centre *</label><input id="r-phone" type="tel" required placeholder="06 XX XX XX XX"></div></div>'
    + '<div class="half"><div><label for="r-email">E-mail du centre *</label><input id="r-email" type="email" required placeholder="centre@exemple.ma"></div>'
    + '<div><label for="r-addr">Adresse complète</label><input id="r-addr" placeholder="Quartier, rue, repère connu…"></div></div>'
    + '<div><label for="r-desc">Présentation du centre</label><textarea id="r-desc" placeholder="Ancienneté, équipe, équipements, jours et horaires d\'ouverture…"></textarea></div>'
    + '<div class="notice"><b>Votre Espace centre — le vôtre, pour votre fiche uniquement :</b> dès l\'acceptation de votre centre, notre équipe crée votre compte personnel avec l\'e-mail indiqué ci-dessus et vous transmet le mot de passe. Un compte par centre : vous n\'y verrez que votre propre fiche. Vous pourrez alors la gérer vous-même — corriger vos informations, mettre à jour vos visuels (couverture, logo, photos) et ajouter vos services, un par un, avec leur nom, leur photo et leur tarif — chaque modification étant validée par notre équipe avant publication.</div>'
    + '<fieldset style="border:1.5px solid var(--line);border-radius:12px;padding:16px;display:grid;gap:14px;margin:0"><legend style="font-weight:800;font-size:.92rem;padding:0 6px">Les visuels de votre fiche — 2 emplacements dédiés</legend>'
    + '<p style="margin:0;font-size:.9rem;color:var(--ink2)">Votre fiche s\'affiche ainsi : la <b>photo de couverture</b> en grand en haut de la fiche, votre <b>logo / photo de profil</b> dans une pastille en forme de goutte juste en dessous, puis vos informations. Déposez une image dans chaque emplacement ci-dessous : son nom est joint à votre demande. Les fichiers eux-mêmes vous seront demandés par l\'équipe lors de son contact — et <b>le choix final des visuels publiés est validé par l\'équipe de l\'annuaire</b>, qui peut recadrer une image ou en écarter une qui ne correspond pas aux locaux réels. Vos services (nom, photo, tarif) s\'ajoutent ensuite, un par un, dans votre Espace centre.</p>'
    + '<div class="slot"><div class="slot-head"><span class="slot-num">1</span><h4>Photo de couverture</h4><span class="badge gold">En haut de la fiche</span></div>'
    + '<p>La devanture ou l\'intérieur de votre centre, en format large (paysage). C\'est la première image que voient les visiteurs, dès la liste des centres.</p>'
    + '<div><label for="r-cover">Déposer la photo de couverture</label><input type="file" id="r-cover" accept="image/jpeg,image/png,image/webp"></div>'
    + '<span class="formats">Formats acceptés : JPG, PNG ou WebP — 1 seule photo, format paysage recommandé</span>'
    + '<span class="picked" id="r-cover-picked"></span></div>'
    + '<div class="slot"><div class="slot-head"><span class="slot-num">2</span><h4>Logo / photo de profil</h4><span class="badge gold">Pastille sous la couverture</span></div>'
    + '<p>Votre logo, ou à défaut une photo représentative du centre. Elle s\'affiche dans une pastille en forme de goutte qui chevauche le bas de la couverture, au-dessus de vos informations.</p>'
    + '<div><label for="r-logo">Déposer le logo / la photo de profil</label><input type="file" id="r-logo" accept="image/jpeg,image/png,image/webp"></div>'
    + '<span class="formats">Formats acceptés : JPG, PNG ou WebP — 1 seule image, format carré recommandé</span>'
    + '<span class="picked" id="r-logo-picked"></span></div>'
    + "</fieldset>"
    + '<label class="check"><input type="checkbox" id="r-photos"><span><b>Photos des locaux :</b> je suis prêt à envoyer des photos réelles de mon centre et de mes salles de soins à l\'équipe de l\'annuaire lors de son contact, pour la vérification d\'hygiène. La photo déposée dans l\'emplacement n° 1 ci-dessus deviendra la <b>photo de couverture</b> de ma fiche, visible dès la liste des centres, après validation par l\'équipe.</span></label>'
    + '<label class="check"><input type="checkbox" id="r-hygiene"><span><b>Engagement d\'hygiène :</b> j\'utilise des ventouses et du matériel à usage unique, je désinfecte entre chaque client et je gère les déchets médicaux de façon adaptée. *</span></label>'
    + '<div class="notice">Votre demande est <b>transmise directement à l\'équipe de l\'annuaire</b> dès l\'envoi du formulaire : elle arrive dans son tableau de bord, en attente de traitement. Aucune donnée n\'est transmise à un tiers.</div>'
    + '<div><button class="btn" type="submit" id="regSubmit" style="width:100%">Envoyer ma demande d\'inscription</button></div></form></div>'
    + adSlot(false) + "</div>";
}

/* ------------------------------------------------------------------ */
/* Assemblage d'une page complète à partir du gabarit index.html       */
/* ------------------------------------------------------------------ */
function setHeadMeta(html, title, desc, url) {
  function rep(re, val) { if (!re.test(html)) console.warn("  [avertissement] balise méta introuvable : " + re); html = html.replace(re, val); }
  rep(/<title>[^<]*<\/title>/, "<title>" + esc(title) + "</title>");
  rep(/<meta name="description" content="[^"]*" \/>/, '<meta name="description" content="' + esc(desc) + '" />');
  rep(/<link rel="canonical" href="[^"]*" \/>/, '<link rel="canonical" href="' + esc(url) + '" />');
  rep(/<meta property="og:title" content="[^"]*" \/>/, '<meta property="og:title" content="' + esc(title) + '" />');
  rep(/<meta property="og:description" content="[^"]*" \/>/, '<meta property="og:description" content="' + esc(desc) + '" />');
  rep(/<meta property="og:url" content="[^"]*" \/>/, '<meta property="og:url" content="' + esc(url) + '" />');
  rep(/<meta name="twitter:title" content="[^"]*" \/>/, '<meta name="twitter:title" content="' + esc(title) + '" />');
  rep(/<meta name="twitter:description" content="[^"]*" \/>/, '<meta name="twitter:description" content="' + esc(desc) + '" />');
  return html;
}
function syncSeed(html, centres) {
  var lit = extractLiteral(html, "var CENTRES", "[", "]");
  var i = html.indexOf(lit);
  return html.slice(0, i) + JSON.stringify(centres) + html.slice(i + lit.length);
}
function setApp(html, body, useMarkers) {
  html = html.replace(/<!-- PRERENDER:home -->[\s\S]*?<!-- \/PRERENDER -->/, "");
  var inner = useMarkers ? "<!-- PRERENDER:home -->\n" + body + "\n<!-- /PRERENDER -->" : body;
  if (!/<main id="app">[\s\S]*?<\/main>/.test(html)) throw new Error("Conteneur <main id=\"app\"> introuvable dans index.html.");
  return html.replace(/<main id="app">[\s\S]*?<\/main>/, '<main id="app">' + inner + "</main>");
}
function pageUrl(route) { return route === "" ? SITE + "/" : SITE + "/" + route + "/"; }
function outPath(route) { return route === "" ? path.join(ROOT, "index.html") : path.join(ROOT, route, "index.html"); }

const SITEMAP_META = [
  [/^$/, 1.0, "daily"],
  [/^centres$/, 0.8, "weekly"],
  [/^villes$/, 0.8, "weekly"],
  [/^guides$/, 0.8, "weekly"],
  [/^centre\//, 0.9, "weekly"],
  [/^ville\//, 0.7, "monthly"],
  [/^guide\//, 0.7, "monthly"],
  [/^service\//, 0.6, "monthly"],
  [/^inscription$/, 0.5, "monthly"],
  [/^verification$/, 0.5, "monthly"]
];
function sitemapMeta(route) {
  for (var i = 0; i < SITEMAP_META.length; i++) {
    if (SITEMAP_META[i][0].test(route)) return { priority: SITEMAP_META[i][1], changefreq: SITEMAP_META[i][2] };
  }
  return { priority: 0.5, changefreq: "monthly" };
}

/* ------------------------------------------------------------------ */
/* Programme principal                                                 */
/* ------------------------------------------------------------------ */
async function main() {
  console.log("== build-static.js — " + TODAY + " ==");
  const tpl = loadTemplateData();
  console.log("Gabarit lu : régions=" + Object.keys(tpl.REGIONS).length, "guides=" + tpl.GUIDES.length, "centres (seed)=" + tpl.CENTRES.length);

  // Villes (même construction que l'application).
  const CITIES = [];
  Object.keys(tpl.REGIONS).forEach(function (r) { tpl.REGIONS[r].forEach(function (n) { CITIES.push({ name: n, region: r, slug: citySlug(n) }); }); });
  console.log("Villes : " + CITIES.length);

  // Grandes villes inconnues de REGIONS (faute de frappe dans MAJOR_CITIES) : avertir.
  tpl.MAJOR_CITIES.forEach(function (n) {
    if (!CITIES.some(function (c) { return c.name === n; })) console.warn("  [avertissement] MAJOR_CITIES : ville introuvable dans REGIONS : " + n);
  });

  console.log("Lecture de Firestore (centres + fiches_etat + avis publiés)…");
  const live = await loadLiveData(tpl.apiKey);
  console.log("Firestore : " + live.centres.length + " centre(s), " + live.etat.length + " fiche(s) d'état, " + live.avis.length + " avis publié(s).");

  const merged = mergeCentres(tpl.CENTRES, live.centres, live.etat, CITIES);
  validateCentres(merged);

  // Notes des centres (avis publiés) — mêmes chiffres que l'application.
  var avisByCentre = {};
  live.avis.forEach(function (a) { if (!a.centreSlug) return; (avisByCentre[a.centreSlug] = avisByCentre[a.centreSlug] || []).push(a); });
  merged.forEach(function (c) {
    var list = avisByCentre[c.slug] || [];
    c.ratingCount = list.length;
    c.ratingAvg = list.length ? list.reduce(function (s, a) { return s + (a.note || 0); }, 0) / list.length : 0;
  });

  // Écarts seed / Firestore (à signaler, jamais résolus ici).
  tpl.CENTRES.forEach(function (seed) {
    var m = merged.find(function (x) { return x.slug === seed.slug; });
    if (!m) return;
    if (centreSig(seed) !== centreSig(m)) {
      var diffs = [];
      if (seed.name !== m.name) diffs.push("nom « " + seed.name + " » → « " + m.name + " »");
      if (JSON.stringify(seed.services) !== JSON.stringify(m.services)) diffs.push("services " + seed.services.length + " → " + m.services.length);
      if (JSON.stringify(seed.hours) !== JSON.stringify(m.hours)) diffs.push("horaires modifiés");
      if (seed.address !== m.address) diffs.push("adresse modifiée");
      console.log("  [écart seed/Firestore] " + seed.slug + " : " + (diffs.join(", ") || "autres champs"));
    }
  });

  const ctx = {
    CENTRES: merged, CITIES: CITIES, REGIONS: tpl.REGIONS, GUIDES: tpl.GUIDES, MAJOR_CITIES: tpl.MAJOR_CITIES,
    citiesBySlug: {}, centresBySlug: {}, guidesBySlug: {}, avisByCentre: avisByCentre
  };
  CITIES.forEach(function (c) { ctx.citiesBySlug[c.slug] = c; });
  merged.forEach(function (c) { ctx.centresBySlug[c.slug] = c; });
  tpl.GUIDES.forEach(function (g) { ctx.guidesBySlug[g.slug] = g; });

  // Routes à générer.
  var routes = ["", "centres", "villes", "guides", "inscription", "verification"];
  tpl.GUIDES.forEach(function (g) { routes.push("guide/" + g.slug); });
  var citySlugsWithCentres = {};
  merged.filter(function (c) { return !c.suspended; }).forEach(function (c) {
    routes.push("centre/" + c.slug);
    (c.services || []).forEach(function (s, i) { routes.push("service/" + c.slug + "/" + i); });
    citySlugsWithCentres[citySlug(c.city)] = 1;
  });
  Object.keys(citySlugsWithCentres).forEach(function (s) { routes.push("ville/" + s); });
  GENERATED = new Set(routes);
  console.log("Routes à générer : " + routes.length + " (dont " + Object.keys(citySlugsWithCentres).length + " ville(s) avec centre).");

  // Nettoyage des sorties générées (une page de centre supprimé disparaît).
  ["ville", "centre", "service", "guide", "centres", "villes", "guides", "inscription", "verification"].forEach(function (d) {
    var p = path.join(ROOT, d);
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
  });

  // Gabarit : seed synchronisée avec les données fusionnées.
  const template = syncSeed(tpl.html, merged);

  // Rendu de chaque route.
  var manifestUrls = [];
  for (var ri = 0; ri < routes.length; ri++) {
    var route = routes[ri];
    var seg = route.split("/").filter(Boolean);
    var body;
    if (route === "") body = viewHome(ctx);
    else if (route === "centres") body = viewCentres(ctx);
    else if (route === "villes") body = viewVilles(ctx);
    else if (route === "guides") body = viewGuides(ctx);
    else if (route === "inscription") body = viewInscription(null, ctx);
    else if (route === "verification") body = viewVerification(ctx);
    else if (seg[0] === "guide") body = viewGuide(ctx.guidesBySlug[seg[1]], ctx);
    else if (seg[0] === "centre") body = viewCentre(ctx.centresBySlug[seg[1]], ctx);
    else if (seg[0] === "service") body = viewService(ctx.centresBySlug[seg[1]], parseInt(seg[2], 10));
    else if (seg[0] === "ville") body = viewVille(ctx.citiesBySlug[seg[1]], ctx);
    else throw new Error("Route inconnue : " + route);

    var meta = metaFor(route, { cities: ctx.citiesBySlug, centres: ctx.centresBySlug, guides: ctx.guidesBySlug });
    var url = pageUrl(route);
    var html = setHeadMeta(template, meta.title, meta.desc, url);
    html = setApp(html, body, route === "");
    var out = outPath(route);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, html, "utf8");
    // Contrôle : la page écrite contient bien son titre et son contenu.
    var check = fs.readFileSync(out, "utf8");
    if (check.indexOf("<title>" + esc(meta.title) + "</title>") < 0) throw new Error("Page sans titre : " + out);
    if (check.indexOf('id="app"') < 0 || check.indexOf("<!-- PRERENDER:home -->") < 0 && route === "") throw new Error("Page sans contenu pré-rendu : " + out);
    var sm = sitemapMeta(route);
    manifestUrls.push({ loc: url, lastmod: TODAY, changefreq: sm.changefreq, priority: sm.priority });
    console.log("  " + url);
  }

  // Manifeste + sitemap.
  fs.writeFileSync(path.join(ROOT, "static-manifest.json"), JSON.stringify({ generatedAt: TODAY, urls: manifestUrls }, null, 2) + "\n", "utf8");
  execFileSync("node", ["gen_sitemap.js"], { cwd: ROOT, stdio: "inherit" });

  console.log("== OK : " + routes.length + " pages statiques, " + merged.length + " centre(s), " + Object.keys(citySlugsWithCentres).length + " ville(s) avec centre. ==");
  console.log("Manifeste : static-manifest.json — Sitemap : sitemap.xml (" + manifestUrls.length + " URL).");
  console.log("Rappel : soumettre les nouvelles URL dans Google Search Console (manuel).");
}

main().catch(function (e) {
  console.error("ERREUR : " + e.message);
  process.exit(1);
});
