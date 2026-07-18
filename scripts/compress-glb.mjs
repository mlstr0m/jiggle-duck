/**
 * duck.dev.glb -> duck.ktx2.glb : compression GPU des textures.
 *
 * 1. WebP/JPEG -> PNG (toktx ne lit pas le WebP) via l'API gltf-transform ;
 * 2. normal map -> KTX2 UASTC (l'ETC1S detruit les normales) ;
 * 3. baseColor + metallicRoughness -> KTX2 ETC1S (6x moins de VRAM).
 *
 * Necessite `toktx` (KTX-Software) dans le PATH.
 * VRAM des 3 textures : 16.8 Mo (WebP decompresse) -> 2.8 Mo (KTX2).
 */
import { execSync } from "node:child_process";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { textureCompress } from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";
import sharp from "sharp";

const SRC = "assets-src/duck.dev.glb";
const DST = "public/duck.ktx2.glb";
const TMP_PNG = "/tmp/duck-png.glb";
const TMP_UASTC = "/tmp/duck-uastc.glb";

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ "meshopt.decoder": MeshoptDecoder, "meshopt.encoder": MeshoptEncoder });

const doc = await io.read(SRC);
await doc.transform(textureCompress({ encoder: sharp, targetFormat: "png" }));
await io.write(TMP_PNG, doc);

execSync(`npx gltf-transform uastc ${TMP_PNG} ${TMP_UASTC} --slots "normalTexture" --level 2`, {
  stdio: "inherit",
});
execSync(`npx gltf-transform etc1s ${TMP_UASTC} ${DST} --quality 200`, { stdio: "inherit" });

console.log(`\nOK -> ${DST}`);
