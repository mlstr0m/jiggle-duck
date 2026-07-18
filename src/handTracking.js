import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";

/**
 * Indices des 21 landmarks MediaPipe.
 * https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker
 */
export const LM = {
  WRIST: 0,
  THUMB_CMC: 1,
  THUMB_MCP: 2,
  THUMB_IP: 3,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_PIP: 6,
  INDEX_DIP: 7,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
  MIDDLE_PIP: 10,
  MIDDLE_DIP: 11,
  MIDDLE_TIP: 12,
  RING_MCP: 13,
  RING_PIP: 14,
  RING_DIP: 15,
  RING_TIP: 16,
  PINKY_MCP: 17,
  PINKY_PIP: 18,
  PINKY_DIP: 19,
  PINKY_TIP: 20,
};

/** Le squelette "façon Google" : les segments a tracer entre les landmarks. */
export const HAND_CONNECTIONS = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4], // pouce
  [0, 5],
  [5, 6],
  [6, 7],
  [7, 8], // index
  [9, 10],
  [10, 11],
  [11, 12], // majeur
  [13, 14],
  [14, 15],
  [15, 16], // annulaire
  [0, 17],
  [17, 18],
  [18, 19],
  [19, 20], // auriculaire
  [5, 9],
  [9, 13],
  [13, 17], // paume
];

export class HandTracker {
  constructor(video) {
    this.video = video;
    this.landmarker = null;
    this.result = null;
    this.onFrame = null;
    this._running = false;
    this._lastVideoTime = -1;

    /**
     * Detection 1 frame video sur N : aux paliers de qualite bas, la main a
     * 15 Hz + le filtre One Euro reste tres jouable, et ça libere la moitie
     * du cout GPU de MediaPipe — le seul poste que le gouverneur ne voyait
     * pas. Pilote par quality.onApply dans main.js.
     */
    this.detectEveryN = 1;
    this._videoFrame = 0;

    /** Cout d'inference, moyenne glissante — pour savoir si MediaPipe est le
     *  goulot d'etranglement ou non, au lieu de le supposer. */
    this.stats = { detectMs: 0, detectFps: 0 };
    this._detectCount = 0;
    this._detectAccum = 0;
    this._statsSince = performance.now();
  }

  async init() {
    // wasm servi en local (public/mediapipe/wasm) : pas de dependance CDN au runtime.
    const fileset = await FilesetResolver.forVisionTasks("./mediapipe/wasm");

    this.landmarker = await HandLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: "./models/hand_landmarker.task",
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      numHands: 2, // main 1 : pincer/attraper — main 2 : battre des ailes
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
  }

  async startCamera() {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
      audio: false,
    });
    this.video.srcObject = stream;
    await this.video.play();
    return stream;
  }

  /**
   * On se cale sur les frames video, pas sur requestAnimationFrame.
   *
   * La webcam sort ~30fps, l'ecran affiche a 60-120fps. Avec rAF on appellerait
   * detectForVideo 2 a 4 fois sur la meme image : du GPU brule pour un resultat
   * identique. requestVideoFrameCallback ne se declenche que sur une vraie
   * nouvelle frame.
   */
  start() {
    if (this._running) return;
    this._running = true;

    const hasVFC = typeof this.video.requestVideoFrameCallback === "function";

    const tick = () => {
      if (!this._running) return;

      if (this.video.readyState >= 2 && this.video.currentTime !== this._lastVideoTime) {
        this._lastVideoTime = this.video.currentTime;
        if (++this._videoFrame % this.detectEveryN !== 0) {
          if (hasVFC) this.video.requestVideoFrameCallback(tick);
          else requestAnimationFrame(tick);
          return;
        }
        try {
          const t0 = performance.now();
          this.result = this.landmarker.detectForVideo(this.video, t0);
          this._detectAccum += performance.now() - t0;
          this._detectCount++;

          const elapsed = performance.now() - this._statsSince;
          if (elapsed > 500) {
            this.stats.detectMs = this._detectAccum / this._detectCount;
            this.stats.detectFps = (this._detectCount * 1000) / elapsed;
            this._detectAccum = 0;
            this._detectCount = 0;
            this._statsSince = performance.now();
          }

          this.onFrame?.(this.result);
        } catch (err) {
          console.error("[hand] detectForVideo a echoue", err);
        }
      }

      if (hasVFC) this.video.requestVideoFrameCallback(tick);
      else requestAnimationFrame(tick);
    };

    tick();
  }

  stop() {
    this._running = false;
    this.video.srcObject?.getTracks().forEach((t) => t.stop());
  }

  /** Toutes les mains detectees (0 a 2 jeux de landmarks). */
  get hands() {
    return this.result?.landmarks ?? [];
  }
}
