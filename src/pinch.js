import { LM } from "./handTracking.js";
import { OneEuroFilter, OneEuroVec } from "./oneEuro.js";

/**
 * Detection du pincement pouce + index.
 *
 * Deux pieges evites ici :
 *
 * 1. NORMALISATION. Un seuil en distance brute ne marche pas : plus la main est
 *    loin de la webcam, plus les landmarks sont proches en pixels. Le meme geste
 *    donnerait "pince" a 2m et "ouvert" a 30cm. On divise donc par une longueur
 *    de reference de la main (poignet -> base de l'index), qui subit exactement
 *    la meme mise a l'echelle. Le ratio obtenu est invariant a la distance.
 *
 * 2. HYSTERESIS. Un seuil unique fait clignoter l'etat quand on stationne
 *    autour. On ferme a 0.45 et on ouvre a 0.62 : entre les deux, l'etat
 *    precedent est conserve.
 */
export class PinchDetector {
  constructor({ closeAt = 0.45, openAt = 0.62, aspect = 4 / 3 } = {}) {
    this.closeAt = closeAt;
    this.openAt = openAt;
    this.aspect = aspect;

    this.isPinching = false;
    this.justPressed = false;
    this.justReleased = false;
    this.ratio = 1;

    // Le point de pincement bouge beaucoup plus que le ratio -> filtres separes.
    // minCutoff 2.0 : valeur trouvee en conditions reelles (webcam + vraie main).
    this.pointFilter = new OneEuroVec(2, { minCutoff: 2.0, beta: 0.015 });
    this.ratioFilter = new OneEuroFilter({ minCutoff: 2.0, beta: 0.005 });
    this.rollFilter = new OneEuroFilter({ minCutoff: 1.5, beta: 0.01 });

    /** Point de pincement en NDC (-1..1), pret pour le raycaster. */
    this.ndc = { x: 0, y: 0 };

    /**
     * Roll de la main en radians, dans le repere ecran que voit l'utilisateur.
     * 0 = main verticale ; positif = le haut de la main penche vers SA droite.
     *
     * Base sur le vecteur poignet -> base du majeur (0 -> 9) : les MCP ne
     * bougent quasiment pas pendant un pincement, contrairement aux bouts de
     * doigts. MediaPipe ne fournit pas de matrice d'orientation pour la main
     * (seul le face landmarker en a une), donc on la reconstruit d'ici.
     */
    this.roll = 0;
  }

  /**
   * @param {Array<{x:number,y:number}>|null} landmarks Landmarks normalises 0..1.
   */
  update(landmarks, timestamp = performance.now() / 1000) {
    this.justPressed = false;
    this.justReleased = false;

    if (!landmarks) {
      if (this.isPinching) {
        this.isPinching = false;
        this.justReleased = true;
      }
      this.pointFilter.reset();
      this.ratioFilter.reset();
      this.rollFilter.reset();
      return false;
    }

    const thumb = landmarks[LM.THUMB_TIP];
    const index = landmarks[LM.INDEX_TIP];
    const wrist = landmarks[LM.WRIST];
    const indexMcp = landmarks[LM.INDEX_MCP];
    const middleMcp = landmarks[LM.MIDDLE_MCP];
    const pinkyMcp = landmarks[LM.PINKY_MCP];

    // x et y sont normalises independamment sur des cotes inegaux : sans
    // correction d'aspect, les distances sont fausses sur l'axe horizontal.
    const dist = (a, b) => Math.hypot((a.x - b.x) * this.aspect, a.y - b.y);

    // Reference robuste a l'INCLINAISON : la camera d'un portable regarde la
    // main par en dessous — le segment poignet->index, quasi vertical,
    // s'ecrase en perspective et le ratio explosait (pinch impossible a
    // declencher sur MacBook, constate et reproduit). L'empan des
    // articulations index->auriculaire, horizontal, ne s'ecrase pas : on
    // prend le max des deux, ramenes a la meme echelle (l'empan vaut
    // ~0.62x la longueur de paume).
    const refLength = Math.max(dist(wrist, indexMcp), dist(indexMcp, pinkyMcp) / 0.62);
    // Main de profil ou tres loin : la reference s'effondre, le ratio explose.
    if (refLength < 1e-4) return this.isPinching;

    this.ratio = this.ratioFilter.filter(dist(thumb, index) / refLength, timestamp);

    const wasPinching = this.isPinching;
    if (this.isPinching) {
      if (this.ratio > this.openAt) this.isPinching = false;
    } else if (this.ratio < this.closeAt) {
      this.isPinching = true;
    }

    if (this.isPinching && !wasPinching) this.justPressed = true;
    if (!this.isPinching && wasPinching) this.justReleased = true;

    // Le curseur est le milieu pouce/index : c'est la que l'utilisateur
    // "voit" sa prise, plus stable que l'un des deux bouts.
    const [fx, fy] = this.pointFilter.filter(
      [(thumb.x + index.x) / 2, (thumb.y + index.y) / 2],
      timestamp,
    );

    // Passage en NDC.
    //   x : la video est affichee en miroir (scaleX(-1)), on inverse donc.
    //   y : l'image descend, le NDC monte.
    this.ndc.x = 1 - 2 * fx;
    this.ndc.y = 1 - 2 * fy;

    // Roll : angle du vecteur poignet -> base du majeur, exprime dans le meme
    // repere ecran-miroir que le NDC (le miroir est donc deja gere), avec la
    // meme correction d'aspect que les distances.
    const rvx = 2 * (wrist.x - middleMcp.x) * this.aspect;
    const rvy = 2 * (wrist.y - middleMcp.y);
    this.roll = this.rollFilter.filter(Math.atan2(rvx, rvy), timestamp);

    return this.isPinching;
  }

  setParams({ closeAt, openAt, minCutoff, beta }) {
    if (closeAt !== undefined) this.closeAt = closeAt;
    if (openAt !== undefined) this.openAt = openAt;
    if (minCutoff !== undefined || beta !== undefined) {
      this.pointFilter.setParams({ minCutoff, beta });
    }
  }
}
