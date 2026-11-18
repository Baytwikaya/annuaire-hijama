# Annuaire Hijama — hijama.site

Annuaire des centres de hijama (حجامة) vérifiés au Maroc : 375 villes,
fiches rédigées par l'équipe, contrôle d'hygiène avant publication.
Site statique (GitHub Pages) : une application monopage (`index.html`)
+ des pages statiques pré-rendues pour Google (voir ci-dessous).

## Pages statiques (pré-rendu)

Le site est une SPA à ancres (`#/ville/casablanca`) : Google ignore le
contenu après `#`, donc seule la page d'accueil pouvait être indexée.
`build-static.js` génère une vraie page HTML par route, avec le contenu
complet + titre / méta / canonique dans le HTML brut :

- accueil (contenu pré-rendu injecté dans `index.html`)
- sections : `/centres`, `/villes`, `/guides`, `/inscription`, `/verification`
- guides : `/guide/<slug>` (4 guides)
- chaque centre réel : `/centre/<slug>` + ses pages services `/service/<slug>/<n>`
- pages villes **uniquement** pour les villes qui ont au moins un centre
  (aujourd'hui : Casablanca seulement)

Une ville sans centre n'a **pas** de page statique — elle reste joignable
via `/villes` et la recherche de l'application. Quand un centre est
approuvé dans une ville, sa page est créée automatiquement au prochain
build.

### Source de vérité : Firestore

Les centres sont lus en direct depuis Firestore (API publique, sans
secret — la clé est déjà dans `index.html`). Les données Firestore
priment sur la liste codée en dur dans `index.html` (même fusion que
l'application). Le build synchronise aussi cette liste avec les données
fusionnées, pour que l'application affiche les mêmes données que les
pages statiques au démarrage. Conséquence voulue : un centre nouveau
(sans entrée codée en dur) apparaît automatiquement sur le site après
un build.

### Rebuild manuel

```bash
node build-static.js   # régénère les pages + static-manifest.json + sitemap.xml
```

Puis vérifier, committer et pousser. Le script échoue (exit 1) si
Firestore est injoignable ou si la liste fusionnée est vide/invalide —
ne jamais pousser un build partiel.

### Automatisation (aucun rebuild manuel)

Le workflow `.github/workflows/build-static.yml` exécute le build tous
les jours à 03:30 UTC (et à la demande : onglet Actions → *Build static
pages* → *Run workflow*). Si le build produit des changements (nouveau
centre → nouvelles pages, sitemap mis à jour), il les committe et les
pousse tout seul.

**La seule partie manuelle : l'indexation.** Soumettre les nouvelles
URL dans Google Search Console, de temps en temps, quand des centres
sont ajoutés. Le sitemap (`sitemap.xml`) liste exactement les URL
statiques générées — jamais d'URL avec `#`, jamais de page pour une
ville sans centre.

### Ajouter un centre / une ville

Rien à faire dans ce dépôt : approuvez le centre dans Firestore
(`directUpdated: true`). Le prochain build (manuel ou automatique)
crée la page du centre, ses pages services et, si la ville n'en avait
pas, sa page ville.

## Formulaire d'inscription

Le sélecteur de ville propose les 375 villes, regroupées par région,
avec les grandes villes **en tête de liste** (Casablanca, Tanger,
Rabat, puis les autres — liste `MAJOR_CITIES` dans `index.html`).
La valeur sélectionnée reste le slug de la ville : le flux
d'inscription est inchangé.

## Notes connues

- **Écart seed / Firestore (non résolu, décision du propriétaire en
  attente)** : la liste codée en dur dans `index.html` indique 7
  services, des horaires 8h30–16h30 et le nom « Bayt Al-Wiqaya » ;
  Firestore (qui prime à l'affichage) indique 5 services, des horaires
  8h30–16h00 et le nom « Bayt Wiqaya ». Les pages générées utilisent
  les données Firestore.
- **Pas de publicité** sur les fiches centres : les emplacements
  « Espace publicitaire » visibles sur les fiches sont des emplacements
  réservés (aucun code publicitaire), en attente d'une décision.
