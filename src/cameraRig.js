import * as THREE from "three";
import { CLOUD_TOP } from "./sky.js";

/**
 * Rig camera : suivi leger du canard + dezoom a l'arrivee des copains +
 * FOV kick a l'acceleration (le classique du game feel : elargir le champ
 * de vision vend la vitesse — Mario Kart, Zelda, tous les jeux de course).
 *
 * Le suivi et le dezoom s'appliquent en DELTAS sur l'etat d'OrbitControls,
 * pour cohabiter avec l'orbite et le zoom manuels (mode debug).
 *
 * Clamp vertical DERIVE de CLOUD_TOP (sky.js) : sous le toit du slab, le
 * raymarch coupe tous les nuages d'un coup (condition ro.y > CLOUD_TOP) —
 * la camera ne doit jamais y descendre, ni monter au point de perdre le
 * slab de vue. Le canard, lui, va ou il veut : seule la camera est bornee.
 */
export function createCameraRig({ camera, controls }) {
  const camRig = {
    follow: 0.6, // fraction de la position du canard suivie par la cible
    smooth: 2.6, // reactivite du suivi (bas = plus planant)
    zoomPerBird: 0.2, // dezoom par copain arrive
    zoomSmooth: 0.5, // lenteur du dezoom (tres doux)
    basePos: camera.position.clone(),
    baseTarget: controls.target.clone(),
    followOffset: new THREE.Vector3(), // part de suivi deja appliquee
    zoom: 1,
    zoomTarget: 1,
    zoomAnchor: 0, // copains deja "absorbes" par un reset camera
    // bornes de l'offset vertical : camera au pire a 0.1 au-dessus du toit
    // des nuages, et jamais plus haut que la vue du slab ne le permet
    yMin: CLOUD_TOP + 0.1 - camera.position.y,
    yMax: 1.2,
    // FOV kick : degres ajoutes a pleine vitesse (speedNorm 1) ; la vrille
    // depasse 1 (clamp 1.5) pour un punch supplementaire
    fovKick: 7,
    baseFov: camera.fov,
    _fov: camera.fov,

    /** A brancher sur flock.onArrival. */
    onArrival(n) {
      this.zoomTarget = 1 + Math.max(0, n - this.zoomAnchor) * this.zoomPerBird;
    },

    /** @param {number} activeBirds Copains deja arrives (flock.active). */
    reset(activeBirds = 0) {
      camera.position.copy(this.basePos);
      controls.target.copy(this.baseTarget);
      this.followOffset.set(0, 0, 0);
      // le cadrage courant redevient la reference : les copains deja la ne
      // re-dezooment pas, seuls les prochains arrivants le feront
      this.zoomAnchor = activeBirds;
      this.zoom = 1;
      this.zoomTarget = 1;
    },

    /**
     * @param {THREE.Vector3} src Point suivi (canard, ou home pendant l'intro).
     * @param {number} speedNorm Vitesse normalisee 0..1+ ((facteur-1)/(max-1)).
     */
    update(dt, src, speedNorm = 0) {
      const k = Math.min(1, dt * this.smooth);
      const wantY = Math.min(this.yMax, Math.max(this.yMin, src.y * this.follow));
      const dx = (src.x * this.follow - this.followOffset.x) * k;
      const dy = (wantY - this.followOffset.y) * k;
      const dz = (src.z * this.follow - this.followOffset.z) * k;
      this.followOffset.x += dx;
      this.followOffset.y += dy;
      this.followOffset.z += dz;
      controls.target.x += dx;
      controls.target.y += dy;
      controls.target.z += dz;
      camera.position.x += dx;
      camera.position.y += dy;
      camera.position.z += dz;

      // FOV kick, lisse : accelere = le champ s'ouvre, ralentit = il revient
      const targetFov = this.baseFov + this.fovKick * Math.min(1.5, Math.max(0, speedNorm));
      this._fov += (targetFov - this._fov) * Math.min(1, dt * 3);
      if (Math.abs(this._fov - camera.fov) > 1e-3) {
        camera.fov = this._fov;
        camera.updateProjectionMatrix();
      }

      const prevZoom = this.zoom;
      this.zoom += (this.zoomTarget - this.zoom) * Math.min(1, dt * this.zoomSmooth);
      if (Math.abs(this.zoom - prevZoom) > 1e-6) {
        // scaling RELATIF de l'offset camera-cible : preserve l'orbite et le
        // zoom molette de l'utilisateur, ajoute juste le delta de dezoom
        camera.position
          .sub(controls.target)
          .multiplyScalar(this.zoom / prevZoom)
          .add(controls.target);
      }
    },
  };

  return camRig;
}
