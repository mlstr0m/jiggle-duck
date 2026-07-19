/**
 * REGLAGES BAKES — la source de verite unique des valeurs artistiques.
 *
 * Ce fichier a EXACTEMENT la forme du JSON produit par le bouton
 * "copier reglages (JSON)" du panneau debug (#debug) : le workflow de
 * tuning est donc — regler au panneau, exporter, coller l'objet ici,
 * commit. Un diff de bake se lit d'un coup d'oeil, et rien ne s'oublie.
 *
 * Les modules gardent des defauts raisonnables ; applySettings() ecrase
 * tout au boot avec les valeurs ci-dessous. Les couleurs sont des hex BRUTS
 * (tels qu'affiches par lil-gui, sans conversion sRGB -> lineaire) : c'est
 * la valeur que le panneau montrait a Aurelien, restituee a l'identique.
 */
export const SETTINGS = {
  camera: {
    position: [3.0439, 0.0264, -4.0655],
    target: [-0.3684, 0.103, -0.4117],
  },
  ciel: {
    vitesse: 0.6,
    etirement: 6.0,
    couverture: 0.6,
    echelle: 2.0,
    pas: 40,
    rayons: 0.4,
    gradLo: 0.02,
    gradHi: 0.1,
    forceOmbre: 1.5,
    contraste: 6.4,
    luminosite: 1.26,
    lointains: 0.7,
    lointainsHauteur: 1.0,
    zenith: "#0f47f0",
    horizon: "#4d94ff",
    ombre: "#476bb3",
    ocean: "#020608",
  },
  grading: {
    contraste: 1.22,
    saturation: 1.07,
    luminosite: 0.01,
    teinteOmbres: "#3400c2",
    forceTeinte: 0.1,
    vignette: 0.8,
  },
  bloom: { intensite: 0.24, rayon: 0.14, seuil: 0.64 },
  vent: { intensite: 1.0, vitesse: 3.4, longueur: 0.65 },
  paillettes: { intensite: 1.15, taille: 1.85, derive: 3.0, teinte: "#ffc400" },
  // flare DESACTIVE (19/07, Aurelien : "je l'aime pas finalement") — le
  // module et le dossier Flare du panneau restent la pour le reactiver
  flare: {
    actif: false,
    intensite: 2.0,
    halo: 330,
    chaleur: 0.5,
    anneau: 0,
    decalageAnneau: 0,
    points: 0.2,
    x: -0.99,
    y: 0.75,
  },
  trainees: { intensite: 0.3, largeur: 0.012, fuite: 2.4 },
  fond: { opacite: 0.5, taille: 1, vitesse: 1 },
  corps: {
    raideur: 130,
    amorti: 12,
    inclinaison: 0.9,
    rollMain: 1.0,
    vieAuRepos: 0.6,
    battementCroisiere: 0.72,
  },
  battement: { amplitude: 0.7, frequence: 2.4 },
  vitesse: {
    min: 0.6,
    max: 4.0,
    boostExtra: 4.5,
    impulsion: 4.0,
    dureeVrille: 0.85,
    avance: 1.6,
    dureeAvance: 3.2,
  },
  migration: {
    copains: 5,
    raideur: 55,
    amorti: 13,
    profondeur: 1.35,
    largeur: 1.4,
    dispersion: 1.2,
    vagabondage: 0.6,
    battAmp: 0.5,
    battHz: 2.6,
    intervalle: 7,
    regards: 1,
    espacementRegards: 1,
  },
  // suivi 0 : camera VERROUILLEE (demande Aurelien — le leger suivi du canard
  // se lisait comme une derive parasite vers les bords du cadre)
  camRig: { suivi: 0, reactivite: 2.6, dezoomParCopain: 0.2, fovKick: 7 },
  wiggle: {
    "Cou + tete": 320,
    "Aile gauche": 520,
    "Aile droite": 520,
    "Patte droite": 280,
    "Patte gauche": 280,
  },
};

/** Hex "#rrggbb" -> canaux BRUTS (meme convention que le color picker lil-gui). */
const rawHex = (color, hex) => {
  const n = parseInt(hex.slice(1), 16);
  color.setRGB(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};

/**
 * Applique SETTINGS sur les systemes construits. A appeler au boot, apres
 * la construction de tout le monde et AVANT la creation du rig camera (qui
 * capture la position de base) et le lancement de l'intro.
 */
export function applySettings(s, ctx) {
  const {
    camera,
    controls,
    sky,
    grade,
    bloom,
    wind,
    sparkles,
    farBirds,
    flare,
    trails,
    grab,
    idle,
    flap,
    speedCtl,
    flock,
    headLook,
    duck,
  } = ctx;

  camera.position.fromArray(s.camera.position);
  controls.target.fromArray(s.camera.target);

  const u = sky.uniforms;
  speedCtl.bases.sky = s.ciel.vitesse;
  sky.stretch = s.ciel.etirement;
  u.uCoverage.value = s.ciel.couverture;
  u.uScale.value = s.ciel.echelle;
  u.uSteps.value = s.ciel.pas;
  u.uRays.value = s.ciel.rayons;
  u.uGradLo.value = s.ciel.gradLo;
  u.uGradHi.value = s.ciel.gradHi;
  u.uShadowAmt.value = s.ciel.forceOmbre;
  u.uContrast.value = s.ciel.contraste;
  u.uLitBoost.value = s.ciel.luminosite;
  u.uFar.value = s.ciel.lointains;
  u.uFarHeight.value = s.ciel.lointainsHauteur;
  rawHex(u.uZenith.value, s.ciel.zenith);
  rawHex(u.uHorizon.value, s.ciel.horizon);
  rawHex(u.uShadow.value, s.ciel.ombre);
  rawHex(u.uDeep.value, s.ciel.ocean);

  const g = grade.material.uniforms;
  g.uContrast.value = s.grading.contraste;
  g.uSaturation.value = s.grading.saturation;
  g.uBrightness.value = s.grading.luminosite;
  rawHex(g.uShadowTint.value, s.grading.teinteOmbres);
  g.uShadowTintAmt.value = s.grading.forceTeinte;
  g.uVignette.value = s.grading.vignette;

  bloom.strength = s.bloom.intensite;
  bloom.radius = s.bloom.rayon;
  bloom.threshold = s.bloom.seuil;

  wind.intensity = s.vent.intensite;
  speedCtl.bases.wind = s.vent.vitesse;
  wind.length = s.vent.longueur;

  sparkles.intensity = s.paillettes.intensite;
  sparkles.size = s.paillettes.taille;
  speedCtl.bases.spark = s.paillettes.derive;
  rawHex(sparkles.color, s.paillettes.teinte);

  flare.visible = s.flare.actif;
  flare.intensity = s.flare.intensite;
  flare.glowSize = s.flare.halo;
  flare.warmth = s.flare.chaleur;
  flare.ringSize = s.flare.anneau;
  flare.ringOffset = s.flare.decalageAnneau;
  flare.dots = s.flare.points;
  flare.screen.x = s.flare.x;
  flare.screen.y = s.flare.y;
  flare.rebuild();

  farBirds.opacity = s.fond.opacite;
  farBirds.size = s.fond.taille;
  farBirds.speed = s.fond.vitesse;

  trails.intensity = s.trainees.intensite;
  trails.width = s.trainees.largeur;
  speedCtl.bases.trail = s.trainees.fuite;

  grab.stiffness = s.corps.raideur;
  grab.damping = s.corps.amorti;
  grab.tilt = s.corps.inclinaison;
  grab.rollGain = s.corps.rollMain;
  idle.amount = s.corps.vieAuRepos;
  flap.cruise = s.corps.battementCroisiere;

  flap.amplitude = s.battement.amplitude;
  flap.frequency = s.battement.frequence;

  speedCtl.min = s.vitesse.min;
  speedCtl.max = s.vitesse.max;
  speedCtl.boost.extra = s.vitesse.boostExtra;
  speedCtl.boost.impulse = s.vitesse.impulsion;
  speedCtl.boost.dur = s.vitesse.dureeVrille;
  speedCtl.boost.sepAmp = s.vitesse.avance;
  speedCtl.boost.sepDur = s.vitesse.dureeAvance;

  const m = s.migration;
  // les champs qui figent la geometrie des slots ne sont relus qu'au
  // rebuild() : on ne reconstruit la volee que si le bake en change un
  const needsRebuild =
    flock.count !== m.copains ||
    flock.stiffness !== m.raideur ||
    flock.spacing !== m.profondeur ||
    flock.side !== m.largeur ||
    flock.scatter !== m.dispersion;
  flock.count = m.copains;
  flock.stiffness = m.raideur;
  flock.damping = m.amorti;
  flock.spacing = m.profondeur;
  flock.side = m.largeur;
  flock.scatter = m.dispersion;
  flock.wander = m.vagabondage;
  flock.flapAmp = m.battAmp;
  flock.flapFreq = m.battHz;
  flock.arrivalInterval = m.intervalle;
  headLook.amount = m.regards;
  headLook.interval = m.espacementRegards;
  if (needsRebuild) flock.rebuild();

  for (const [label, stiffness] of Object.entries(s.wiggle)) {
    const chain = duck.chains.find((c) => c.label === label);
    if (chain) duck.setChainParams(chain, { stiffness });
    else console.warn(`[settings] chaine wiggle inconnue : "${label}"`);
  }

  return s;
}
