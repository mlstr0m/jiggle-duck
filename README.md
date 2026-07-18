# Jiggle Duck

Short experience with MediaPipe. Tout tourne en local dans l'onglet : aucune
image ne sort du navigateur.

```bash
npm install
npm run patch:glb   # génère public/duck.dev.glb (voir « GLB » plus bas)
npm run dev
```

Puis `http://localhost:5173`, bouton **Activer la webcam**.
Pince pouce + index pour attraper le canard.

**Sans webcam** : `shift + clic` déplace le canard à la souris. Ça permet de
régler le wiggle et le rendu sans dépendre du tracking.

---

## Architecture

| Fichier | Rôle |
|---|---|
| `src/main.js` | Câblage des systèmes + boucle de rendu + fallback souris |
| `src/settings.js` | **Source de vérité des réglages bakés** (même forme que l'export JSON du panneau) |
| `src/scene.js` | Renderer, caméra, éclairage (RoomEnvironment) |
| `src/duck.js` | Chargement GLB, `RIG` (autorité des noms de bones), chaînes wiggle, audit du rig |
| `src/flock.js` | Migration : clones en V, arrivées progressives, battement, suivi ressort |
| `src/sky.js` | Ciel volumétrique métaballs (raymarch) — exporte `CLOUD_TOP` |
| `src/postChain.js` | RT ciel basse résolution + composer (bloom, grading, LUT, FXAA) |
| `src/governor.js` | Qualité adaptative : 5 paliers pilotés par le temps de frame mesuré |
| `src/cameraRig.js` | Suivi caméra + dézoom par copain + clamp vertical dérivé de `CLOUD_TOP` |
| `src/intro.js` | Séquence d'ouverture : iris, dézoom, entrée de l'oiseau hors champ |
| `src/speedControl.js` | Manette des gaz (2e main) + vrille boostée au poing |
| `src/grab.js` | Raycast + drag sur plan face caméra, ressort de corps, roll |
| `src/flap.js` | Battement d'ailes permanent du leader (axes auto-calibrés) |
| `src/headLook.js` | Regards : les oiseaux tournent la tête aléatoirement |
| `src/trails.js` | Traînées de bouts d'ailes (rubans, buffer circulaire) |
| `src/wind.js` / `src/sparkles.js` | Traits de vent / paillettes (1 draw call chacun) |
| `src/flare.js` | Lens flare réglable (contrôleur + rebuild) |
| `src/grading.js` | Passe de grading final (contraste, teinte ombres, vignette, iris, dither) |
| `src/handTracking.js` | Wrapper MediaPipe, indices des landmarks, connexions du squelette |
| `src/handOverlay.js` | Overlay 2D du squelette de main (style Google) |
| `src/pinch.js` | Détection de pincement normalisée + hystérésis |
| `src/oneEuro.js` | Filtre One Euro |
| `src/debugPanel.js` | Panneau lil-gui — chargé **dynamiquement**, uniquement en `#debug` |

Mode debug : URL terminée par `#debug`. Le workflow de réglage : panneau →
« copier reglages (JSON) » → coller dans `src/settings.js` → rebuild.
Handles console (debug uniquement) : `__duck`, `__grab`, `__speedCtl`,
`__flock`, `__tick(0, dt)` (stepping manuel), `__snapshot()`.

---

## Ce qui a été vérifié

Pas seulement « ça charge sans erreur » :

- **Rebond réel** — réponse à un échelon de position : le corps dépasse sa
  cible de **12,3 %**, rebondit une fois en dessous, se stabilise en ~1,2 s.
  (Un lerp ne peut par construction jamais dépasser sa cible — c'est pour ça
  que le projet utilise la variante ressort `wiggle/spring`, pas la variante
  lerp de la lib.)
- **Wiggle neutre au repos** — les longueurs de bones sont identiques avec et
  sans wiggle monté. Rien n'est collapsé au démarrage.
- **Raycast** — la carte de collision balayée en NDC dessine bien la silhouette
  du canard ; une prise dans le vide échoue correctement.
- **Profondeur constante** — sur 5 positions de drag, la profondeur en espace
  caméra dérive de exactement `0`. Le canard ne part jamais au loin.
- **Coût physique** — `grab.update` + `duck.update` : **0,05 ms/frame** au
  total. La physique n'est jamais le goulot d'étranglement.

> Note : le wiggle **fait pivoter** les bones, il ne les déplace pas
> (`step()` finit par `target.position.set(0,0,0)`). Mesurer la position d'un
> wiggle bone donnera toujours un résultat rigide — il faut mesurer la rotation.

### Bug corrigé : raycast flaky au démarrage

`SkinnedMesh.raycast` (three r180) teste `mesh.boundingSphere`, calculée
**une seule fois, paresseusement, au premier raycast** — et jamais rafraîchie.
Si ce premier raycast tombait pendant l'init transitoire des springs, la sphère
en cache était fausse et toutes les prises suivantes rataient. `tryGrab`
recalcule désormais matrices + sphère à chaque tentative (~1 ms, événement
rare) — ce qui rend aussi le raycast correct sur la pose déformée courante.

---

## Le GLB

### Anatomie du rig (déduite des poids de skinning)

Les bones s'appellent `Bone.001`…`Bone.013`. L'anatomie a été retrouvée en
calculant le centroïde des vertices influencés par chaque chaîne :

| Chaîne | Racine | Bones | Dynamiques | Rôle |
|---|---|---|---|---|
| A | `Bone.001` | 2 | 1 | Cou + tête |
| B | `Bone.003` | 2 | 1 | Aile gauche |
| C | `Bone.005` | 2 | 1 | Aile droite |
| D | `Bone.007` | 3 | 2 | Patte droite |
| E | `Bone.010` | 3 | 2 | Patte gauche |
| F | `Bone.013` | 1 | 0 | **Corps — ancre statique** |

`Bone.013` (le corps) ne doit surtout pas wiggler : c'est lui qu'on déplace au
pincement, et c'est son mouvement qui alimente toutes les autres chaînes. Il est
marqué `anchor: true` dans `CHAIN_PRESETS` et exclu du montage wiggle.

> ⚠️ GLTFLoader assainit les noms : `Bone.001` dans Blender devient `Bone001`
> ici. `duck.js` normalise avant de chercher, les deux écritures marchent.

### À corriger dans Blender (par priorité)

1. ~~**Normal map absente.**~~ **Contournée** : `scripts/patch-glb.mjs` injecte
   désormais `textures/Tasia-02_DefaultMaterial_Normal000.jpg` directement dans
   le GLB (le fichier exporté déclarait un `normalTexture` sans image). Le
   tricot rend correctement. Le fix propre reste le réexport avec
   `Pack Resources` — après quoi ce script se supprime.
   La **height map** n'est pas utilisée : glTF n'a pas de slot height, et la
   normal map porte déjà le relief (un bumpMap three.js ferait doublon).

2. **Chaînes trop courtes.** Le cou et les ailes n'ont qu'**un seul segment
   dynamique** : ça produit un mouvement de charnière, pas de peluche. Le cou
   est le plus visible — c'est là que le gain est le plus fort.
   → En Edit Mode sur l'armature : sélectionner le bone, `Subdivide`, viser
   3–4 bones par chaîne. Les poids se re-répartissent automatiquement.

3. **Deux couches de vertex colors** (`COLOR_0` et `COLOR_1`). Three.js n'en lit
   qu'une et la **multiplie** avec la base color. Le toggle « vertex colors »
   du panneau permet de trancher : si le canard s'éclaircit nettement en
   décochant, c'étaient des masques Blender internes, à ne pas exporter.

4. *(mineur)* `doubleSided: true` sur toute la peluche — double le coût
   fragment. À désactiver si le mesh est fermé.

### Ce qui était déjà bon

12 424 tris / 6 829 verts (bonne densité pour de la déformation), 4 influences
max par vertex, scale à 1 partout, zéro animation exportée, meshopt + WebP.

### Correction

J'avais suspecté un **miroir raté** sur les pattes et les ailes, à cause de
positions de bones asymétriques. C'était faux : le rendu montre un canard dans
une posture de marche, ailes déployées asymétriquement. L'asymétrie est la pose
du modèle, pas un défaut de rig.

---

## Réglage

Tout se règle à chaud dans le panneau, sans recharger. Ces valeurs se trouvent
à l'œil, pas au raisonnement.

**Wiggle membres** — ressorts (`wiggle/spring`). `raideur` bas = membre mou qui
traîne ; `amorti` bas = rebondit longtemps. Ratio d'amortissement =
`amorti / (2·√raideur)` : en dessous de 1 ça rebondit.

**Roll de la main** — tourner la main pendant la prise penche le canard du
même côté (repère miroir : main penchée à ta droite = canard penché à droite
à l'écran). Reconstruit depuis le vecteur poignet → base du majeur (landmarks
0 → 9, stables pendant un pincement — MediaPipe ne fournit pas de matrice
d'orientation pour la main). Appliqué en **delta depuis la prise** pour que le
canard ne saute pas à la saisie ; retour à plat au lâcher. Gain réglable
(« roll main »), 0 pour désactiver. Vérifié synthétiquement : main à +30,6° →
canard à −30,6° (signe écran correct), retour exact à 0° au lâcher.

**Vol (2e main)** — agiter la deuxième main fait battre les ailes. La vitesse
du poignet charge une enveloppe (attaque ~0,1 s, relâche ~0,45 s) qui module
une oscillation sinusoïdale appliquée aux **racines** des chaînes d'ailes —
exactement le modèle de la lib wiggle (bones statiques pilotés à la main), les
bouts d'ailes suivant via leurs springs. L'axe de battement est **calibré
automatiquement** au chargement : l'orientation locale des bones étant
arbitraire après l'export glTF, on teste les trois axes et on garde celui qui
fait monter le bout d'aile en monde (résultat sur ce rig : axe z local, signes
miroir +1/−1). La cadence accélère avec l'intensité du geste. Vérifié :
corrélation de phase 0,999 entre les deux ailes, retour à la rest pose exacte
quand la main s'arrête ou disparaît.

**Attribution des mains** — la main de contrôle (pince/attrape) est suivie par
**continuité de position** frame à frame, pas par handedness left/right :
MediaPipe confond régulièrement gauche/droite en miroir, alors qu'un poignet ne
se téléporte pas. L'autre main détectée pilote le vol (squelette cyan dans le
PIP, dont l'intensité suit l'enveloppe). Limite : si la main de contrôle sort
du champ, la main restante hérite du rôle de contrôle.

**Nuages volumétriques v4 : métaballs + impuretés** — la v3 pure était « trop
boule parfaite » (retour utilisateur) : un fbm3 déforme la distance aux
sphères (lobes irréguliers, bords qui accrochent), chaque lobe a un
écrasement vertical propre (galettes/dômes/tours), et le même échantillon de
bruit texture la rampe d'ombrage pour casser le lisse plastique. Un seul
fbm3 par point, partagé entre champ et shading. Base v3 : les nuages de Sky
sont des assemblages de gros **lobes sphériques** art-directed, pas du noise.
Le champ de densité est donc une **grille de sphères** (une par cellule,
position/rayon/existence hashés) : rayons assez grands pour que les voisines
d'une même île fusionnent en masses, **ancrage commun au bas du slab** (un
deck de dômes — un grand rayon = une tour, jamais de sphère flottante), bords
serrés. Et surtout : la sphère **dominante** au point échantillonné donne une
**normale analytique** → ombrage lambertien large et rond par lobe (la rampe
se règle avec « contraste nuages »). Bonus perf : cette normale remplace
l'échantillon d'occlusion vers le soleil — le champ v3 coûte MOINS cher que
le fbm v2 tout en étant plus proche des refs. Historique v2 (fbm raymarché) :

- **placement grande échelle** : un masque 2D basse fréquence décide *où*
  existent les cumulus → des îles distinctes séparées de trous bleu profond,
  pas une couche uniforme qui sature en blanc (l'erreur de la v1 volumétrique) ;
- **modelé en hauteur** : seuil durci vers le sommet (têtes arrondies), adouci
  vers la base (assise plate) ;
- **érosion haute fréquence sur les bords seulement** : le grumeleux
  chou-fleur des cumulus, l'intérieur reste plein ;
- **éclairage** : 1 échantillon de densité vers le soleil par pas — faces côté
  soleil allumées, creux ombrés bleu-lavande (`uShadow`). C'est ça, le relief ;
- **perspective aérienne** : le lointain fond vers l'horizon → mur de cumulus
  au fond ; jitter du départ de rayon par pixel contre le banding ;
- ~24 pas/rayon (slider « qualite nuages »), arrêt anticipé quand opaque, et
  sortie immédiate gratuite dans les trous du masque.

La **key light du canard est alignée sur le soleil du shader** — sinon
l'éclairage du mesh contredit le ciel. Au-dessus de l'horizon : dégradé +
soleil (disque + double halo) + cirrus 2D fins.

**Motion blur** — l'étirement du champ de densité le long du vol (slider
« trainees nuages ») vend la vitesse. L'**AfterimagePass** existe toujours
dans le pipeline (RenderPass → Afterimage → OutputPass, ACES appliqué une
seule fois par l'OutputPass — vérifié dans la source three r180 : le tone
mapping matériaux ne s'applique qu'au rendu écran) mais est **coupée par
défaut** : sa rémanence par canal laissait des franges chromatiques sur les
bords de nuages dès que le fond défile en continu. Le slider « motion blur »
la réactive.

**Ciel défilant** — skydome shader stylisé : dégradé bleu + deux couches de
nuages fbm en parallaxe au-dessus de l'horizon, **mer de nuages** dense en
dessous (on vole au-dessus de la couche — pas de sol). La sensation de vitesse
vient de la projection plane `d.xz / |d.y|`, qui étire le motif près de
l'horizon. Le défilement suit l'**avant du canard**, mesuré sur le rig au
chargement (direction corps → tête) puis suivi frame à frame à travers la
rotation du root ; l'offset d'échantillonnage s'accumule vectoriellement le
long de cet avant, donc le sens s'infléchit sans saut quand le canard tourne.
L'offset et l'échantillonnage partagent le même repère (`d.xz`) avec des
multiplicateurs positifs — aucune couche ne peut défiler à contresens.
Étalonnage ACES + sRGB dans le shader, mêmes chunks que le reste de la scène ;
les couleurs sources sont volontairement saturées pour compenser. Réglages
dans « Ciel » : vitesse, couverture, échelle. La grille est coupée par défaut
(réactivable dans Rendu).

**Corps** — le corps ne peut pas être un wiggle bone : les chaînes des membres
sont ses *sœurs* sous l'armature, pas ses enfants — le faire wiggler
détacherait visuellement le corps des racines des membres. Son rebond vient
d'un **ressort de position sur la racine** (raideur/amorti) plus une
**inclinaison pilotée par la vitesse** (il se penche dans le mouvement), le
tout dans `GrabController`. Ce mouvement nourrit les wiggle bones des membres
en rotation, pas seulement en translation.

**Qualité adaptative** — un gouverneur mesure le temps de frame réel et
descend une échelle de 5 paliers (ultra → mini) jusqu'à tenir 60 fps, puis y
reste (remontée très prudente après 20 s de marge, pour éviter le yo-yo et la
chauffe). Ordre des paliers = gain-perf / dégât-visuel : résolution du ciel
(poste dominant), pas de raymarch, pixel ratio, bloom en dernier. Toucher un
levier géré (résolution ciel, pas, pixel ratio) passe en manuel ; case
« qualite auto » dans Rendu. Le palier courant s'affiche dans le HUD.
Note : sur une machine qui tient tout juste 60 fps vsyncé, le gouverneur ne
remonte jamais (le temps de frame reste ~16,7 ms) — c'est voulu : rester au
palier qui tient, c'est la machine qui ne chauffe pas.

Autres optimisations structurelles : `antialias: false` (tout passe par le
composer, le MSAA du canvas ne s'appliquait à rien), **frustum culling actif**
sur les 6 oiseaux (sphère partagée gonflée ×1,6 — les copains hors champ ne
coûtent plus rien), matériau **FrontSide** (le double face du GLB doublait le
coût fragment), fbm2 à 3 octaves dans le ciel.

**Perf** — HUD en bas à droite : fps rendu + coût frame JS, et fps + coût de
l'inférence MediaPipe une fois la webcam active. C'est lui qui dit si un
manque de fluidité vient du rendu (→ baisser `pixel ratio` dans Rendu, premier
levier sur écran retina : DPR 2 = 4× plus de fragments que DPR 1) ou de
l'inférence (→ la main est mise à jour ~30 fps, c'est normal et indépendant du
rendu). La physique coûte 0,05 ms/frame, mesurée — ce n'est jamais elle.

**Pincement** — `ferme sous` / `ouvre au-dessus` forment l'hystérésis. Les
resserrer rend la prise plus nerveuse mais fait clignoter l'état ; les écarter
rend la prise plus sûre mais plus molle. Le ratio est affiché en direct sur
l'overlay webcam.

**One Euro** — `minCutoff` bas = plus lisse au repos, plus de lag. `beta` haut =
plus réactif en mouvement. Régler `minCutoff` main immobile d'abord, puis `beta`
en bougeant vite.

### Alternative : piloter le wiggle depuis Blender

`WiggleRig` lit `bone.userData.wiggleVelocity` (ou `wiggleStiffness` +
`wiggleDamping` pour le moteur à ressort). Ça correspond aux **custom properties**
Blender sur les bones, exportées en cochant *Custom Properties* dans l'exporteur
glTF. Ça permettrait de régler le wiggle dans Blender plutôt qu'en JS.

Le projet n'utilise pas cette voie pour l'instant : régler à chaud dans le
navigateur est bien plus rapide qu'un aller-retour Blender → export → reload.
À reconsidérer une fois les valeurs figées, pour qu'elles vivent dans le
`.blend` et non dans le code.

---

## Choix techniques

**Pas de `z` MediaPipe.** Le `z` des landmarks est relatif au poignet, mal
calibré et bruité. Le drag est projeté sur un plan face caméra passant par le
point d'accroche : le canard reste à la profondeur où on l'a saisi. Si on veut
un jour un axe de profondeur, le proxy le plus stable est la taille apparente de
la main (distance landmark 0 → 5), fortement filtrée.

**Pincement normalisé.** La distance pouce/index est divisée par la longueur
poignet → base de l'index. Sans ça, le seuil dépendrait de la distance à la
webcam.

**`requestVideoFrameCallback`**, pas `requestAnimationFrame` : la webcam sort
~30 fps, l'écran affiche à 60–120. En rAF on inférerait plusieurs fois la même
image pour rien.

**One Euro, pas un lerp.** Un lerp lisse pareil quelle que soit la vitesse :
soit ça tremble à l'arrêt, soit ça traîne en mouvement.

---

## Limites connues

- `wiggle@0.0.17` est **pré-1.0** — API non stabilisée, version épinglée
  exactement. Licence MIT ; à vérifier si le projet part chez un client.
- `WiggleBone` **reparente sa cible sous un clone** de celle-ci
  (`target.clone()` est récursif). Ça crée quelques Bones fantômes hors
  skeleton : sans effet sur le skinning, mais du poids inutile dans le graphe.
  Négligeable à 7 wiggle bones ; à surveiller si le rig grossit beaucoup.
- Une seule main suivie (`numHands: 1`). Passer à 2 demande de choisir quelle
  main pilote quoi.
- Pas de collision : rien n'empêche le bec de traverser le corps. Si ça se voit
  une fois les chaînes rallongées, ça se traite par contrainte d'angle, pas par
  vraie collision.
