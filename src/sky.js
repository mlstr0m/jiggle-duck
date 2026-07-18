import * as THREE from "three";

/**
 * Ciel facon "Sky: Children of the Light" — v3, volumetrique.
 *
 * Les v1/v2 (fbm 2D projete sur le dome) ne pouvaient PAS ressembler aux
 * references : les nuages de Sky sont des volumes — silhouettes 3D, dessus
 * eclaires, dessous auto-ombres. Ici on raymarche une vraie couche de nuages
 * (slab horizontal sous le canard) dans un champ de densite fbm 3D :
 *
 * - ~24 pas par rayon, arret anticipe quand le nuage est opaque ;
 * - densite modelee en hauteur : sommets arrondis (seuil plus dur en haut du
 *   slab), bases plates ;
 * - eclairage : 1 echantillon de densite vers le soleil par pas -> les faces
 *   cote soleil s'allument, les creux s'ombrent en bleu. C'est ce qui donne
 *   le RELIEF ;
 * - perspective aerienne : les nuages lointains fondent vers la couleur
 *   d'horizon, ce qui fabrique le mur de cumulus au loin ;
 * - jitter du point de depart par pixel pour casser le banding.
 *
 * Au-dessus de l'horizon : degrade + soleil + une couche fine de cirrus 2D.
 * Le defilement suit l'avant du canard (offset vectoriel accumule).
 *
 * L'AfterimagePass est coupee par defaut : sa remanence PAR CANAL laisse des
 * franges chromatiques sur chaque bord de nuage des que le fond defile en
 * continu (constat utilisateur). Le mouvement est vendu par le raymarching
 * lui-meme + l'advection du champ de densite.
 */

/**
 * Bornes verticales du slab de nuages (unites monde). Exportees parce que la
 * CAMERA en depend : le raymarch coupe tous les nuages d'un coup si l'oeil
 * passe sous CLOUD_TOP (condition ro.y > CLOUD_TOP) — le rig camera derive
 * son clamp vertical de cette valeur, pas d'un nombre recopie.
 */
export const CLOUD_TOP = -0.45;
export const CLOUD_BOT = -7.5;

const vertexShader = /* glsl */ `
  varying vec3 vWorldPos;
  void main() {
    vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;
  varying vec3 vWorldPos;
  uniform vec2 uOffset;     // advection du champ (defilement du vol)
  uniform vec2 uMotionDir;  // direction de vol, plan xz
  uniform float uStretch;   // etirement des nuages le long du vol
  uniform float uCoverage;  // couverture 0..1
  uniform float uScale;     // echelle du motif (frequence de base)
  uniform int uSteps;       // pas de raymarching (qualite)
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uShadow;     // couleur des creux/dessous de nuages
  uniform vec3 uDeep;       // l'ocean vu a travers les trous de nuages
  uniform vec3 uSunDir;
  uniform float uGradLo;    // position de l'horizon dans le degrade (elevation)
  uniform float uGradHi;    // position du zenith dans le degrade (elevation)
  uniform float uShadowAmt; // force de l'ombrage des nuages (0 = plats)
  uniform float uRays;      // intensite des faisceaux de soleil (0 = off)
  uniform float uContrast;  // gain de l'ombrage directionnel des nuages
  uniform float uLitBoost;  // luminosite des faces eclairees
  uniform float uFar;       // opacite du mur de cumulus lointains (0 = off)
  uniform float uFarHeight; // hauteur des silhouettes lointaines

  // TOP remonte : les domes ont besoin de headroom, sinon le plan d'entree du
  // raymarch les decapite a plat. La base du deck, elle, vient de l'ancrage
  // des spheres sur qBot — pas de ce plan. Valeurs injectees depuis le JS
  // (exports CLOUD_TOP/CLOUD_BOT) : source unique.
  const float CLOUD_TOP = ${CLOUD_TOP.toFixed(2)};
  const float CLOUD_BOT = ${CLOUD_BOT.toFixed(2)};
  // Volontairement court : au-dela, les pas deviennent si grands que ça bande
  // aux angles rasants — la brume d'horizon fait le raccord.
  const float MAX_DIST = 62.0;

  // ——— bruit 3D ———
  float hash3(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float noise3(vec3 x) {
    vec3 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), f.x),
          mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), f.x), f.y),
      mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), f.x),
          mix(hash3(i + vec3(0, 1, 1)), hash3(i + vec3(1, 1, 1)), f.x), f.y),
      f.z);
  }
  float fbm3(vec3 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 3; i++) {
      v += a * noise3(p);
      p = p * 2.17 + 9.7;
      a *= 0.5;
    }
    return v;
  }

  float hash2(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }
  float noise2(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash2(i), hash2(i + vec2(1, 0)), u.x),
               mix(hash2(i + vec2(0, 1)), hash2(i + vec2(1, 1)), u.x), u.y);
  }
  // 3 octaves (au lieu de 4) : le fbm2 ne sert qu'au masque de placement,
  // aux cirrus et aux rayons — des motifs larges ou la 4e octave etait un
  // detail invisible paye a CHAQUE echantillon du raymarch.
  float fbm2(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 3; i++) {
      v += a * noise2(p);
      p = p * 2.03 + 31.7;
      a *= 0.5;
    }
    return v;
  }

  // ——— champ de densite du slab : METABALLS, pas du bruit ———
  //
  // Les nuages de Sky ne sont pas du noise : ce sont des assemblages de gros
  // LOBES spheriques art-directed. Un champ fbm, meme bien regle, ne donnera
  // jamais cette rondeur — elle doit etre dans la STRUCTURE du champ.
  //
  // Ici : une grille de cellules en xz, chaque cellule porte une sphere
  // pseudo-aleatoire (position, rayon, hauteur hashes). La densite est
  // l'union lisse des spheres voisines (3x3), modulee par le masque de
  // placement grande echelle (les iles). Et surtout : on retient la sphere
  // DOMINANTE au point echantillonne -> normale analytique -> ombrage
  // lambertien large et doux, par lobe. C'est ce degrade-la qui fait Sky.
  // Bonus perf : la normale remplace l'echantillon d'occlusion vers le
  // soleil (une evaluation complete du champ economisee par pas).

  vec3 cloudCoord(vec3 p) {
    vec2 xz = p.xz;
    float along = dot(xz, uMotionDir);
    xz -= uMotionDir * along * (1.0 - 1.0 / uStretch);
    return vec3(xz.x, p.y * 1.6, xz.y) * (0.14 * uScale) + vec3(uOffset.x, 0.0, uOffset.y) * 0.5;
  }

  const float CELL = 1.05; // taille de cellule en espace nuage

  // Texture de surface partagee entre le champ (deformation des lobes) et
  // l'ombrage (grain du degrade) — echantillonnee UNE fois par point.
  float gSurf;

  // union LISSE : max() cousait des aretes la ou deux lobes se rencontrent
  // — visibles comme des "calques" dans les masses. Le smooth-max fusionne.
  float smax(float a, float b, float k) {
    float h = max(k - abs(a - b), 0.0) / k;
    return max(a, b) + h * h * k * 0.25;
  }

  // Champ + normale du lobe dominant. La sortie nrm n'est valide que si d > 0.
  float densityN(vec3 p, out vec3 nrm) {
    float hgt = clamp((p.y - CLOUD_BOT) / (CLOUD_TOP - CLOUD_BOT), 0.0, 1.0);
    nrm = vec3(0.0, 1.0, 0.0);
    gSurf = 0.5;
    // fondu du bas LARGE : les bases se dissolvent en brume bien avant le
    // plan de sortie du raymarch — sinon ce plan tranche les nuages net
    // (retour utilisateur : "le cut est tres sec en bas")
    float floorFade = smoothstep(0.0, 0.28, hgt);
    if (floorFade < 0.01) return 0.0;

    vec3 q = cloudCoord(p);

    // placement grande echelle : les iles de cumulus. Coupure FRANCHE en
    // bordure : un masque residuel faisait un semis de micro-lobes ratatines
    // au bord des iles — le "mouchete sombre" des captures.
    float mask = smoothstep(0.6 - uCoverage * 0.3, 0.85 - uCoverage * 0.3, fbm2(q.xz * 0.3));
    if (mask < 0.12) return 0.0;

    // IMPURETES (retour utilisateur : "jamais tout lisse") : le meme bruit
    // deforme la distance aux spheres — lobes irreguliers, surfaces
    // bosselees, bords qui accrochent — et texture ensuite l'ombrage.
    gSurf = fbm3(q * 2.3);

    // bornes du slab en espace nuage (pour poser les centres des spheres)
    float k = 0.14 * uScale * 1.6;
    float qTop = CLOUD_TOP * k;
    float qBot = CLOUD_BOT * k;

    vec2 base = floor(q.xz / CELL);
    float dens = 0.0;
    float best = 0.0;

    for (int dx = -1; dx <= 1; dx++) {
      for (int dz = -1; dz <= 1; dz++) {
        vec2 cell = base + vec2(float(dx), float(dz));
        // 1 seul hash par cellule, les autres parametres en derivent
        float h0 = hash2(cell + 0.17);
        float h1 = fract(h0 * 41.7);
        float h2 = fract(h0 * 113.9);
        float h3 = fract(h0 * 271.3);

        // Rayon en loi quadratique : beaucoup de bosses, quelques grosses
        // tours. Module par le masque (les lobes retrecissent aux bords des
        // iles au lieu d'etre coupes net).
        // Base 0.8 x CELL : les voisins d'une meme ile se CHEVAUCHENT
        // toujours -> masses fusionnees, pas un semis de ballons isoles.
        // La variation (h1^2) fait la variete de hauteur des domes (ancres
        // au meme sol, un grand rayon = une tour).
        // le retrecissement au bord des iles est PLAFONNE : plus de lobes
        // miniatures qui mouchetent, la bordure est faite de lobes un peu
        // plus petits, pas de gravier
        float r = CELL * (0.8 + 0.7 * h1 * h1) * (0.7 + 0.3 * smoothstep(0.15, 0.7, mask));

        // ANCRAGE : tous les lobes posent sur la meme base — un deck de
        // domes, comme la mer de nuages des refs. Pas de spheres flottantes.
        vec3 center = vec3(
          (cell.x + 0.5 + (h0 - 0.5) * 0.5) * CELL,
          qBot + r * 0.85 + h2 * 0.15 * CELL,
          (cell.y + 0.5 + (h3 - 0.5) * 0.5) * CELL
        );

        // forme propre a chaque lobe : ecrasement vertical variable — des
        // galettes, des domes, des tours, jamais deux fois la meme boule
        float sq = 0.68 + 0.3 * fract(h0 * 613.7);
        vec3 dv = q - center;
        dv.y *= sq;
        float dist = length(dv);
        // deformation par le bruit de surface : lobes irreguliers, bosseles
        dist += (gSurf - 0.5) * r * 0.55;
        // bord proportionnel serre : c'est lui qui garde les lobes DEFINIS
        // (la version "epaisseur constante" diluait tout en dalles informes)
        float c = smoothstep(r, r * 0.72, dist);
        if (c > best) {
          best = c;
          nrm = normalize(vec3(dv.x, dv.y / sq, dv.z));
        }
        dens = max(dens, c); // union franche : les lobes restent lisibles
      }
    }

    // bordure d'ile : fondu ETROIT — juste assez pour casser les dents de
    // scie des bords etires, sans creer de franges laiteuses
    return min(dens, 1.0) * floorFade * smoothstep(0.12, 0.22, mask);
  }

  // Variante sans normale (bissection du point d'entree)
  float density(vec3 p) {
    vec3 n;
    return densityN(p, n);
  }

  void main() {
    vec3 ro = cameraPosition;
    vec3 rd = normalize(vWorldPos - cameraPosition);
    float h = rd.y;

    // ——— fond : degrade (positions horizon/zenith pilotables) + soleil ———
    vec3 col = mix(uHorizon, uZenith, pow(smoothstep(uGradLo, uGradHi, h), 0.8));
    float sd = max(dot(rd, uSunDir), 0.0);
    float sunGlow = pow(sd, 1400.0) * 1.6 + pow(sd, 60.0) * 0.5 + pow(sd, 5.0) * 0.22;

    // ——— mur de cumulus LOINTAINS : silhouettes 2D parallaxees ———
    // Technique classique de skybox : a cette distance il n'y a plus de
    // parallaxe interne, un profil de bruit au-dessus de l'horizon suffit.
    // Deux couches (lente/fondue puis plus rapide/lisible) vendent la
    // profondeur ; echantillonnage sur le cercle unite -> pas de couture.
    if (uFar > 0.001 && h > -0.03 && h < 0.35) {
      vec2 cd = normalize(rd.xz);
      vec3 litFar = vec3(1.0, 0.99, 0.96);
      // la BASE du mur fond exactement dans la brume d'horizon : sans ce
      // fondu, la ou le mur s'arrete (ligne d'horizon) il restait plus clair
      // que le fond -> ligne horizontale qui coupait les domes (constate)
      float baseFade = smoothstep(-0.01, 0.07, h);
      // couche ARRIERE : haute, quasi immobile, mangee par la brume
      {
        float n = fbm2(cd * 1.7 + uOffset * 0.03 + 7.0);
        float th = max(0.0, n - 0.42) * 0.5 * uFarHeight;
        float r = clamp(h / max(th, 1e-4), 0.0, 1.0);
        float m = smoothstep(th, th - 0.02, h);
        vec3 cA = mix(uHorizon, litFar, (0.18 + 0.35 * r) * baseFade);
        col = mix(col, cA, m * uFar * 0.85);
      }
      // couche AVANT : plus basse, un peu plus rapide, cretes eclairees
      {
        float n = fbm2(cd * 3.3 + uOffset * 0.08 + 41.0);
        float th = max(0.0, n - 0.5) * 0.34 * uFarHeight;
        float r = clamp(h / max(th, 1e-4), 0.0, 1.0);
        float m = smoothstep(th, th - 0.015, h);
        vec3 cB = mix(uHorizon, litFar, (0.3 + 0.45 * r) * baseFade);
        // crete legerement eclairee cote soleil : le liseret qui fait "Sky"
        cB += litFar * 0.08 * smoothstep(th * 0.55, th, h) * (0.4 + 0.6 * sd) * baseFade;
        col = mix(col, cB, m * uFar);
      }
    }

    // ——— cirrus 2D au-dessus de l'horizon, discrets ———
    if (h > 0.03) {
      vec2 cp = rd.xz / max(h, 0.08) * uScale * 0.6 + uOffset * 0.25;
      float ci = fbm2(cp);
      float cir = smoothstep(0.68, 0.9, ci) * smoothstep(0.03, 0.2, h);
      col = mix(col, vec3(1.0), cir * 0.3);
    }

    // ——— volumetrique : slab sous l'horizon ———
    if (h < -0.005 && ro.y > CLOUD_TOP) {
      float t0 = (CLOUD_TOP - ro.y) / h;
      float t1 = min((CLOUD_BOT - ro.y) / h, MAX_DIST);

      if (t0 < MAX_DIST) {
        float span = t1 - t0;
        float dt = span / float(uSteps);
        // Jitter minimal : avec des nuages OPAQUES, seule la frange fine du
        // bord dither encore — le grain de l'interieur disparait avec la
        // transparence. (Retour utilisateur : plus de grain visible.)
        float t = t0 + dt * 0.18 * hash2(gl_FragCoord.xy);

        vec3 acc = vec3(0.0);
        float T = 1.0; // transmittance

        vec3 litCol = vec3(1.05, 1.02, 0.98) * uLitBoost;
        // Retro-diffusion facon SSS : quand on regarde vers le soleil, la
        // lumiere traverse les BORDS fins des nuages et les fait rougeoyer
        // chaud. C'est le seul endroit ou Sky laisse "passer" la lumiere —
        // l'interieur, lui, est plein.
        float forward = pow(sd, 8.0);

        // Avec des nuages opaques, la qualite percue vient surtout de la
        // precision du POINT D'ENTREE dans le volume : quantifie au pas de
        // marche, il dessine des contours en escalier sur les silhouettes.
        // A la premiere rencontre, on raffine par bissection (3 iterations,
        // une seule fois par rayon) -> silhouettes lisses sans payer plus
        // de pas partout.
        bool wasEmpty = true;
        float tPrev = t;

        for (int i = 0; i < 40; i++) {
          if (i >= uSteps || T < 0.02 || t > t1) break;
          vec3 p = ro + rd * t;
          vec3 n;
          float d = densityN(p, n);
          if (d > 0.015) {
            if (wasEmpty) {
              float ta = tPrev;
              float tb = t;
              for (int j = 0; j < 3; j++) {
                float tm = 0.5 * (ta + tb);
                if (density(ro + rd * tm) > 0.015) tb = tm;
                else ta = tm;
              }
              t = tb;
              p = ro + rd * t;
              d = densityN(p, n);
              wasEmpty = false;
            }
            // Ombrage LAMBERTIEN sur la normale du lobe dominant : degrade
            // large et rond, PAR lobe — la signature visuelle de Sky. Le
            // "contraste nuages" durcit ou adoucit la rampe.
            float lam = clamp(dot(n, uSunDir) * 0.5 + 0.5, 0.0, 1.0);
            float shade = pow(lam, 0.6 + uContrast * 0.35);
            // grain du degrade : le bruit de surface (gSurf, echantillonne au
            // meme point par densityN) casse le lisse plastique de la rampe
            shade *= 0.8 + 0.4 * gSurf;
            float hgt = clamp((p.y - CLOUD_BOT) / (CLOUD_TOP - CLOUD_BOT), 0.0, 1.0);

            vec3 cCol = mix(uShadow, litCol, clamp(mix(1.0, shade * 0.85 + hgt * 0.2, uShadowAmt), 0.0, 1.0));
            // frange SSS : uniquement la ou la densite est faible (bords)
            cCol += vec3(1.0, 0.9, 0.75) * forward * (1.0 - clamp(d * 2.2, 0.0, 1.0)) * 0.7;
            // perspective aerienne : le lointain fond vers l'horizon (et la
            // brume avale le banding des grands pas au loin)
            cCol = mix(cCol, uHorizon, smoothstep(12.0, 42.0, t));

            // Opacification RAPIDE : les nuages de Sky sont pleins, pas
            // vaporeux. Toute densite franche devient opaque en 1-2 pas ;
            // seule la frange du bord reste douce.
            float a = 1.0 - exp(-d * 10.0 * dt);
            // dissolution a distance : l'ALPHA fond avant le plan de coupe
            // MAX_DIST — sans ça, les masses lointaines etaient tranchees en
            // murs verticaux nets
            a *= 1.0 - smoothstep(42.0, 60.0, t);
            acc += cCol * a * T;
            T *= 1.0 - a;
            tPrev = t;
            t += dt;
          } else {
            // SAUT D'ESPACE VIDE : dans les trous on avance plus vite.
            // Modere (x1.4) : trop agressif, il striait les domes lointains
            // effleures en angle rasant.
            wasEmpty = true;
            tPrev = t;
            t += dt * 1.4;
          }
        }

        // ce que le rayon n'a pas rencontre laisse voir l'OCEAN en dessous :
        // bleu profond sature (refs Sky), qui fond vers l'horizon au loin
        vec3 deep = mix(uDeep, uHorizon, smoothstep(20.0, 55.0, t1));
        col = acc + deep * T;
      }
    }

    // ——— faisceaux de soleil (rayons crepusculaires) ———
    // Motif purement ANGULAIRE autour de l'axe du soleil : constant le long
    // du rayon, donc des stries qui emanent du soleil. Echantillonne sur le
    // cercle unite -> continu, pas de couture. Par-dessus les nuages : c'est
    // de la diffusion atmospherique devant la scene.
    if (uRays > 0.001) {
      vec3 sx = normalize(cross(uSunDir, vec3(0.0, 1.0, 0.0)));
      vec3 sy = cross(sx, uSunDir);
      vec2 sp = vec2(dot(rd, sx), dot(rd, sy));
      float spl = length(sp);
      if (spl > 1e-4) {
        vec2 aDir = sp / spl;
        // derive lente avec le vol pour que les faisceaux vivent
        float rays = fbm2(aDir * 2.6 + vec2(uOffset.x * 0.05, uOffset.y * 0.05) + 31.0);
        float shaft = smoothstep(0.52, 0.85, rays);
        // concentres autour du soleil, fondus avant le disque lui-meme
        float focus = pow(sd, 3.5) * (1.0 - pow(sd, 300.0));
        col += vec3(1.0, 0.96, 0.86) * shaft * focus * uRays;
      }
    }

    // brume d'horizon discrete + halo solaire par-dessus tout
    col += uHorizon * 0.10 * exp(-abs(h) * 16.0);
    col += vec3(1.0, 0.97, 0.90) * sunGlow;

    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export class Sky {
  constructor(scene) {
    this.speed = 0.6; // vitesse de vol — reglage Aurelien (lent, contemplatif)
    // Etirement des nuages le long du vol, en DIRECT (1 = rond, 6 = file).
    // Avant c'etait vitesse x facteur : opaque a regler — demande utilisateur.
    this.stretch = 6.0; // etirement max — reglage Aurelien

    this.uniforms = {
      uOffset: { value: new THREE.Vector2(0, 0) },
      uMotionDir: { value: new THREE.Vector2(0, -1) },
      uStretch: { value: 1.0 },
      uCoverage: { value: 0.6 },
      uScale: { value: 2.0 },
      uSteps: { value: 40 },
      // Palette Sky (calibree POST tone mapping ACES, saturee a dessein) :
      // azur vif au zenith, horizon cyan pale, dessous lavande, et l'ocean
      // bleu profond dans les trouees. Reglable au panneau (color pickers).
      // Defauts = reglages valides par Aurelien en session (18/07, v2) :
      // bleus satures, ombres bleu-acier, ocean quasi noir.
      // setRGB BRUT obligatoire : le color picker de lil-gui ecrit les canaux
      // sans conversion d'espace colorimetrique, alors que new Color(hex)
      // convertit sRGB -> lineaire. Pour restituer EXACTEMENT ce que le
      // panneau affichait, on pose les memes valeurs brutes que lui.
      uZenith: { value: new THREE.Color().setRGB(15 / 255, 71 / 255, 240 / 255) },
      uHorizon: { value: new THREE.Color().setRGB(0x4d / 255, 0x94 / 255, 0xff / 255) },
      uShadow: { value: new THREE.Color().setRGB(0x47 / 255, 0x6b / 255, 0xb3 / 255) },
      uDeep: { value: new THREE.Color().setRGB(2 / 255, 6 / 255, 8 / 255) },
      uSunDir: { value: new THREE.Vector3(0, 0.4, -0.9).normalize() },
      uGradLo: { value: 0.02 }, // elevation ou commence le degrade (horizon)
      uGradHi: { value: 0.1 }, // elevation ou le zenith est atteint
      uShadowAmt: { value: 1.5 }, // force de l'ombrage des nuages
      uRays: { value: 0.4 }, // faisceaux de soleil
      uContrast: { value: 6.4 }, // gain de l'ombrage directionnel (modele)
      uLitBoost: { value: 1.26 }, // luminosite des faces eclairees
      uFar: { value: 0.7 }, // mur de cumulus lointains (opacite)
      uFarHeight: { value: 1.0 }, // hauteur des silhouettes lointaines
    };

    const mat = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: this.uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });

    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(60, 48, 24), mat);
    this.mesh.name = "sky";
    this.mesh.renderOrder = -1000;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  /** Fixe le soleil (direction monde). A appeler une fois a l'init. */
  setSun(dir) {
    this.uniforms.uSunDir.value.copy(dir).normalize();
  }

  /**
   * @param {number} dt
   * @param {THREE.Vector3} forward Avant du canard en monde (projete a plat).
   */
  update(dt, forward) {
    const fx = forward.x;
    const fz = forward.z;
    const len = Math.hypot(fx, fz);
    if (len > 1e-4) {
      const nx = fx / len;
      const nz = fz / len;
      this.uniforms.uOffset.value.x += nx * this.speed * dt;
      this.uniforms.uOffset.value.y += nz * this.speed * dt;
      const md = this.uniforms.uMotionDir.value;
      md.x += (nx - md.x) * Math.min(1, dt * 4);
      md.y += (nz - md.y) * Math.min(1, dt * 4);
      md.normalize();
    }
    const s = this.uniforms.uStretch;
    s.value += (this.stretch - s.value) * Math.min(1, dt * 2);
  }
}
