// Renders public/icons/icon.svg to the PNGs the web app manifest and iOS use.
//   node scripts/generate-icons.mjs
// Re-run after changing the SVG; the PNGs are committed.
import { readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";

const svg = await readFile(new URL("../public/icons/icon.svg", import.meta.url), "utf8");
// Maskable icons are cropped to a circle/squircle by the OS: use a full-bleed
// background (no rounded corners). The coin already sits inside the 80% safe zone.
const maskable = svg.replace('rx="112" ', "");

const outputs = [
  { file: "public/icons/icon-192.png", source: svg, size: 192 },
  { file: "public/icons/icon-512.png", source: svg, size: 512 },
  { file: "public/icons/icon-maskable-512.png", source: maskable, size: 512 },
  // iOS home screen icon (iOS rounds the corners itself).
  { file: "app/apple-icon.png", source: maskable, size: 180 },
];

for (const { file, source, size } of outputs) {
  const png = await sharp(Buffer.from(source)).resize(size, size).png().toBuffer();
  await writeFile(new URL(`../${file}`, import.meta.url), png);
  console.log(`${file} (${size}x${size})`);
}
