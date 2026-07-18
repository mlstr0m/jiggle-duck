/**
 * TEMPORAIRE — à supprimer une fois duck.glb réexporté proprement depuis Blender.
 *
 * Le duck.glb exporte declare un `normalTexture` qui pointe vers une texture
 * sans aucune source d'image : la normal map n'a jamais ete embarquee
 * (probablement un chemin de fichier casse au moment de l'export).
 *
 * Ce script repare le fichier pour le dev :
 *   1. si `textures/Tasia-02_DefaultMaterial_Normal000.jpg` existe a cote du
 *      .blend, il est injecte dans le GLB et rebranche sur la texture vide ;
 *   2. sinon, la reference morte est retiree (fallback de l'ancienne version).
 *
 * La height map n'est PAS injectee : glTF n'a pas de slot height/bump, et la
 * normal map porte deja le relief du tricot. La brancher en bumpMap three.js
 * ferait doublon pour un fetch texture de plus.
 *
 * Fix definitif cote Blender : File > External Data > Pack Resources, reexport,
 * puis suppression de ce script.
 */
import fs from "node:fs";
import path from "node:path";

const SRC = process.argv[2] ?? "assets-src/duck.glb";
const DST = process.argv[3] ?? "assets-src/duck.dev.glb";
const NORMAL_JPG =
  process.argv[4] ??
  "/Users/aurelien/Documents/PERSONAL/JIGGLE_DUCK/textures/Tasia-02_DefaultMaterial_Normal000.jpg";

const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

function readGlb(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file}: pas un GLB`);
  const chunks = [];
  let off = 12;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    chunks.push({ type, data: buf.subarray(off + 8, off + 8 + len) });
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  return chunks;
}

function writeGlb(file, json, binData) {
  const jsonBuf = Buffer.from(JSON.stringify(json), "utf8");
  const jsonPad = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
  const binPad = Buffer.concat([binData, Buffer.alloc((4 - (binData.length % 4)) % 4, 0)]);

  const total = 12 + 8 + jsonPad.length + 8 + binPad.length;
  const out = Buffer.alloc(total);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);

  let off = 12;
  out.writeUInt32LE(jsonPad.length, off);
  out.writeUInt32LE(JSON_CHUNK, off + 4);
  jsonPad.copy(out, off + 8);
  off += 8 + jsonPad.length;

  out.writeUInt32LE(binPad.length, off);
  out.writeUInt32LE(BIN_CHUNK, off + 4);
  binPad.copy(out, off + 8);

  fs.writeFileSync(file, out);
  return total;
}

/** Une texture est exploitable si elle resout vers une image. */
function hasSource(tex) {
  if (tex.source !== undefined) return true;
  for (const ext of Object.values(tex.extensions ?? {})) {
    if (ext && typeof ext === "object" && ext.source !== undefined) return true;
  }
  return false;
}

/** Remappe recursivement tout slot `*Texture: { index }` dans les materiaux. */
function remapTextureRefs(node, remap, dropped, trail = []) {
  if (Array.isArray(node)) {
    node.forEach((v, i) => remapTextureRefs(v, remap, dropped, [...trail, i]));
    return;
  }
  if (!node || typeof node !== "object") return;

  for (const [key, value] of Object.entries(node)) {
    const isTextureSlot =
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof value.index === "number" &&
      /Texture$/.test(key);

    if (isTextureSlot) {
      const next = remap.get(value.index);
      if (next === undefined) {
        delete node[key];
        dropped.push([...trail, key].join("."));
        continue;
      }
      value.index = next;
    }
    remapTextureRefs(value, remap, dropped, [...trail, key]);
  }
}

const chunks = readGlb(SRC);
const jsonChunk = chunks.find((c) => c.type === JSON_CHUNK);
const binChunks = chunks.filter((c) => c.type === BIN_CHUNK);
if (binChunks.length !== 1) throw new Error(`attendu 1 chunk BIN, trouve ${binChunks.length}`);
let bin = binChunks[0].data;
const gltf = JSON.parse(jsonChunk.data.toString("utf8"));

const textures = gltf.textures ?? [];
const orphans = textures.map((t, i) => (hasSource(t) ? null : i)).filter((i) => i !== null);

if (orphans.length === 0) {
  console.log("Aucune texture orpheline. Copie telle quelle.");
  if (path.resolve(SRC) !== path.resolve(DST)) fs.copyFileSync(SRC, DST);
  process.exit(0);
}

if (fs.existsSync(NORMAL_JPG) && orphans.length === 1) {
  // — Voie 1 : injection de la normal map dans la texture vide —
  const img = fs.readFileSync(NORMAL_JPG);

  // L'image s'ajoute a la fin du buffer binaire, alignee sur 4 octets.
  const offset = Math.ceil(bin.length / 4) * 4;
  bin = Buffer.concat([bin, Buffer.alloc(offset - bin.length, 0), img]);

  gltf.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: img.length });
  gltf.images ??= [];
  gltf.images.push({
    bufferView: gltf.bufferViews.length - 1,
    mimeType: "image/jpeg",
    name: path.basename(NORMAL_JPG, ".jpg"),
  });

  const tex = textures[orphans[0]];
  tex.source = gltf.images.length - 1;
  delete tex.extensions; // l'objet extensions vide qui faisait planter gltf-transform

  // Le buffer 0 a grandi ; le buffer 1 (fallback meshopt) ne bouge pas.
  gltf.buffers[0].byteLength = bin.length;

  const size = writeGlb(DST, gltf, bin);
  console.log(
    `normal map injectee : ${path.basename(NORMAL_JPG)} (${(img.length / 1024).toFixed(0)} Ko)`,
  );
  console.log(`texture ${orphans[0]} -> image ${gltf.images.length - 1}`);
  console.log(`ecrit -> ${DST} (${(size / 1024 / 1024).toFixed(2)} Mo)`);
} else {
  // — Voie 2 : pas de fichier normal map, on retire les references mortes —
  const remap = new Map();
  let next = 0;
  textures.forEach((tex, i) => {
    if (hasSource(tex)) remap.set(i, next++);
  });

  const dropped = [];
  remapTextureRefs(gltf.materials ?? [], remap, dropped);
  gltf.textures = textures.filter((_, i) => hasSource(textures[i]));

  const size = writeGlb(DST, gltf, bin);
  console.log(`textures orphelines retirees : [${orphans.join(", ")}]`);
  console.log(`slots materiau supprimes     : ${dropped.length ? dropped.join(", ") : "(aucun)"}`);
  console.log(`ecrit -> ${DST} (${(size / 1024 / 1024).toFixed(2)} Mo)`);
  console.log(
    "\nRAPPEL: pas de normal map trouvee. Reexporte depuis Blender apres Pack Resources.",
  );
}
