import { HAND_CONNECTIONS, LM } from "./handTracking.js";

/**
 * Overlay 2D du squelette de main, style MediaPipe/Google : segments clairs
 * entre les articulations, points sur les landmarks.
 *
 * Dessine dans les coordonnees natives (0..1) de l'image ; le miroir est gere
 * en CSS (`transform: scaleX(-1)` sur le canvas comme sur la video), donc on
 * n'inverse rien ici. Attention : c'est pour ça que le calcul NDC dans
 * pinch.js, lui, doit inverser x explicitement.
 */
export class HandOverlay {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.canvas;
    this.canvas.width = w * this.dpr;
    this.canvas.height = h * this.dpr;
  }

  _drawHand(landmarks, { stroke, fill, w, h }) {
    const { ctx } = this;
    const px = (lm) => [lm.x * w, lm.y * h];

    // Segments
    ctx.lineWidth = 3 * this.dpr;
    ctx.lineCap = "round";
    ctx.strokeStyle = stroke;
    ctx.beginPath();
    for (const [a, b] of HAND_CONNECTIONS) {
      const [x1, y1] = px(landmarks[a]);
      const [x2, y2] = px(landmarks[b]);
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
    }
    ctx.stroke();

    // Landmarks
    ctx.fillStyle = fill;
    for (let i = 0; i < landmarks.length; i++) {
      const [x, y] = px(landmarks[i]);
      const isTip = i === LM.THUMB_TIP || i === LM.INDEX_TIP;
      ctx.beginPath();
      ctx.arc(x, y, (isTip ? 6 : 3.5) * this.dpr, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /**
   * @param {Array|null} control  Main de controle (pince/attrape).
   * @param {Array|null} flapHand Deuxieme main (manette des gaz), en cyan.
   */
  draw(control, flapHand, { pinching = false, ratio = 1, throttle = 0 } = {}) {
    const { ctx, canvas } = this;
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);

    if (flapHand) {
      // vitesse de vol visible sur la couleur : cyan eteint (lent) -> vif (sprint)
      const a = 0.35 + 0.55 * throttle;
      this._drawHand(flapHand, {
        stroke: `rgba(56,189,248,${a})`,
        fill: `rgba(125,211,252,${a})`,
        w,
        h,
      });
    }

    if (control) {
      const accent = pinching ? "#4ade80" : "#ffffff";
      this._drawHand(control, {
        stroke: pinching ? "rgba(74,222,128,0.9)" : "rgba(255,255,255,0.75)",
        fill: accent,
        w,
        h,
      });

      // Trait pouce<->index : c'est la distance qui pilote le pincement,
      // le rendre visible rend le seuil comprehensible sans ouvrir la console.
      const px = (lm) => [lm.x * w, lm.y * h];
      const [tx, ty] = px(control[LM.THUMB_TIP]);
      const [ix, iy] = px(control[LM.INDEX_TIP]);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2 * this.dpr;
      ctx.setLineDash([4 * this.dpr, 4 * this.dpr]);
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(ix, iy);
      ctx.stroke();
      ctx.setLineDash([]);

      // Ratio de pincement, en clair (contre-miroir pour rester lisible).
      ctx.save();
      ctx.scale(-1, 1);
      ctx.font = `${11 * this.dpr}px ui-monospace, monospace`;
      ctx.fillStyle = accent;
      ctx.textAlign = "left";
      ctx.fillText(`pinch ${ratio.toFixed(2)}`, -w + 8 * this.dpr, 16 * this.dpr);
      ctx.restore();
    }
  }

  clear() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
}
