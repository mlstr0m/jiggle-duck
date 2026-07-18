import * as THREE from "three";
import { Lensflare, LensflareElement } from "three/examples/jsm/objects/Lensflare.js";

/**
 * Lens flare du soleil, facon Sky : un halo doux + un anneau + des points
 * fantomes, entierement REGLABLE depuis le panneau (intensite, tailles,
 * decalage, chaleur de teinte). Textures generees en canvas (degrades
 * radiaux) — aucun asset a charger.
 *
 * Chaque changement de reglage REBUILD le flare : Lensflare.dispose() jette
 * aussi les textures des elements, donc on les regenere a chaque fois (des
 * petits canvas, cout nul — et ca n'arrive qu'en reglage).
 */

function discTexture(size, stops) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [t, col] of stops) g.addColorStop(t, col);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function ringTexture(size) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(
    size / 2,
    size / 2,
    size * 0.3,
    size / 2,
    size / 2,
    size * 0.48,
  );
  g.addColorStop(0.0, "rgba(255,255,255,0)");
  g.addColorStop(0.55, "rgba(255,245,225,0.55)");
  g.addColorStop(0.7, "rgba(255,245,225,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * @param {THREE.Object3D} anchor Objet positionne sur le soleil visuel.
 * @returns Controleur : reglages + rebuild() + visible.
 */
export function createSunFlare(anchor) {
  const ctl = {
    anchor,
    // — reglages (panneau, defauts = JSON d'Aurelien) ————
    intensity: 2.0, // luminosite globale (module la couleur des elements)
    glowSize: 330, // halo principal (px ecran)
    ringSize: 0, // anneau fantome (0 = pas d'anneau)
    ringOffset: 0, // position de l'anneau sur l'axe soleil-centre (0..1)
    dots: 0.2, // opacite des petits points fantomes (0 = off)
    warmth: 0.5, // 0 = blanc froid, 1 = bien dore

    flare: null,
    _visible: true,

    rebuild() {
      if (this.flare) {
        this.anchor.remove(this.flare);
        this.flare.dispose();
      }

      // teinte chaude : interpole blanc -> dore selon warmth
      const w = this.warmth;
      const warm = (a) => `rgba(255,${Math.round(250 - 35 * w)},${Math.round(240 - 105 * w)},${a})`;
      const cool = (a) => `rgba(235,240,255,${a})`;

      const glow = discTexture(128, [
        [0, warm(0.85)],
        [0.25, warm(0.35)],
        [1, warm(0)],
      ]);
      const dot = discTexture(64, [
        [0, cool(0.5)],
        [1, cool(0)],
      ]);

      const f = new Lensflare();
      const tint = (v) => new THREE.Color(v, v, v);
      f.addElement(new LensflareElement(glow, this.glowSize, 0, tint(this.intensity)));
      if (this.ringSize > 1) {
        f.addElement(
          new LensflareElement(
            ringTexture(128),
            this.ringSize,
            this.ringOffset,
            tint(this.intensity),
          ),
        );
      }
      if (this.dots > 0.01) {
        f.addElement(new LensflareElement(dot, 60, 0.55, tint(this.dots * this.intensity)));
        f.addElement(new LensflareElement(dot, 35, 0.8, tint(this.dots * this.intensity)));
      }
      f.visible = this._visible;
      this.anchor.add(f);
      this.flare = f;
    },

    get visible() {
      return this._visible;
    },
    set visible(v) {
      this._visible = v;
      if (this.flare) this.flare.visible = v;
    },
  };

  ctl.rebuild();
  return ctl;
}
