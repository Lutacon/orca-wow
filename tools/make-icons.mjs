// Draws the addon's icons from Orca's logo (white on a black badge, like Orca's app
// icon) and writes them as the uncompressed 32-bit TGAs the game reads:
//
//   node tools/make-icons.mjs [outDir] [--png]
//
// outDir defaults to addon/OrcaWow/Media. --png also writes PNG previews.
//
// The glyph is the path from Orca's resources/logo.svg (https://github.com/stablyai/orca,
// MIT licence), with that file's translate(-6.6666669,-70.666669) applied below.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePNG } from '../bridge/src/codec.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const png = args.includes('--png');
const outDir = args.find((a) => !a.startsWith('--')) || path.join(HERE, '..', 'addon', 'OrcaWow', 'Media');

const LOGO_PATH = 'm 177.81311,248.33334 c 23.82304,-41.29793 40.54045,-66.84626 49.51207,-75.66667 6.81685,-6.70196 10.07373,-8.7374 20.07265,-12.54475 34.57822,-13.16655 61.04674,-26.78733 72.37222,-37.24295 9.62924,-8.88966 9.34286,-9.01142 -23.43671,-9.964 -35.71756,-1.03796 -43.72989,0.42119 -62.17546,11.323 -16.72118,9.88265 -34.20103,30.11225 -42.74704,49.47157 -2.57353,5.82985 -14.81294,44.3056 -27.96399,87.90747 -2.86036,9.48343 -3.02466,11.71633 -0.86213,11.71633 0.44382,0 7.29659,-11.25 15.22839,-25 z m -65.14644,-8.32267 C 120,239.3326 130.5,237.50979 136,235.95998 c 5.5,-1.5498 12.25,-3.13783 15,-3.52895 2.75,-0.39111 5,-0.95485 5,-1.25275 0,-0.29789 2.15135,-7.58487 4.78078,-16.19328 8.49209,-27.80201 12.21334,-40.41629 21.13747,-71.65166 4.81891,-16.86667 11.23502,-39.185 14.25802,-49.596301 5.12803,-17.66103 5.74763,-23.07037 2.64253,-23.07037 -1.84887,0 -4.07048,6.908293 -16.72243,52.000001 -21.78975,77.65896 -20.80806,74.74393 -26.84794,79.72251 -7.5925,6.25838 -25.03916,14.82524 -36.10856,17.73044 -17.0947,4.48656 -33.410599,3.86724 -53.116765,-2.01622 -18.569242,-5.54403 -23.142662,-5.80284 -33.639754,-1.9037 -5.875424,2.18242 -9.864152,5.04363 -16.716684,11.99127 -4.95,5.0187 -9.0000001,10.02884 -9.0000001,11.13364 0,1.75174 5.9276921,2.00299 46.3333351,1.96383 25.483334,-0.0247 52.333338,-0.59969 59.666668,-1.27777 z M 252.69513,104.63708 c 12.18267,-3.48651 15.77304,-7.895503 9.63821,-11.835773 -10.19296,-6.546726 -36.19849,-1.77301 -41.19436,7.561863 -1.2556,2.3461 -0.98698,3.2037 1.68353,5.375 2.69471,2.19098 4.59991,2.47691 12.53928,1.88189 5.14899,-0.3859 12.94899,-1.72824 17.33334,-2.98298 z';
const TRANSLATE = [-6.6666669, -70.666669];

// SVG path data (M, L, H, V, C, Z, absolute or relative) flattened to closed polygons.
function flatten(d) {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g);
  const polys = [];
  let poly = null;
  let cmd = null;
  let x = 0;
  let y = 0;
  let i = 0;
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++];
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    switch (cmd.toUpperCase()) {
      case 'M':
        x = ox + num();
        y = oy + num();
        poly = [[x, y]];
        polys.push(poly);
        cmd = rel ? 'l' : 'L'; // further pairs are line-tos
        break;
      case 'L':
        x = ox + num();
        y = oy + num();
        poly.push([x, y]);
        break;
      case 'H':
        x = ox + num();
        poly.push([x, y]);
        break;
      case 'V':
        y = oy + num();
        poly.push([x, y]);
        break;
      case 'C': {
        const p1 = [ox + num(), oy + num()];
        const p2 = [ox + num(), oy + num()];
        const p3 = [ox + num(), oy + num()];
        const p0 = [x, y];
        for (let k = 1; k <= 16; k++) {
          const t = k / 16;
          const u = 1 - t;
          poly.push([0, 1].map((a) => u * u * u * p0[a] + 3 * u * u * t * p1[a] + 3 * u * t * t * p2[a] + t * t * t * p3[a]));
        }
        [x, y] = p3;
        break;
      }
      case 'Z':
        [x, y] = poly[0];
        break;
      default:
        throw new Error(`path command ${cmd} isn't handled`);
    }
  }
  return polys.map((p) => p.map(([px, py]) => [px + TRANSLATE[0], py + TRANSLATE[1]]));
}

function inPolys(x, y, polys) {
  let inside = false;
  for (const poly of polys) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

// The glyph in unit coordinates, centred, its wider side `fill` of the badge.
function placeGlyph(fill) {
  const polys = flatten(LOGO_PATH);
  const pts = polys.flat();
  const [minX, maxX] = [Math.min(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[0]))];
  const [minY, maxY] = [Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[1]))];
  const s = fill / Math.max(maxX - minX, maxY - minY);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return polys.map((p) => p.map(([px, py]) => [0.5 + (px - cx) * s, 0.5 + (py - cy) * s]));
}

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const TOP = hex('#333333');
const BOTTOM = hex('#050505');
const GLYPH = hex('#f2f2f2');
const RIM = hex('#8c8c8c');

// Colour of one sample point, or null outside the badge. `rim` is the edge ring's width.
function sample(x, y, glyph, rim) {
  const dx = x - 0.5;
  const dy = y - 0.5;
  const r = Math.sqrt(dx * dx + dy * dy);
  if (r > 0.5) return null;
  if (rim && r > 0.5 - rim) return RIM;
  if (inPolys(x, y, glyph)) return GLYPH;
  return mix(TOP, BOTTOM, Math.min(1, Math.max(0, y)));
}

// Supersampled render: RGBA rows, top row first.
function render(size, glyph, rim) {
  const ss = 6;
  const rgba = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const sum = [0, 0, 0];
      let a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = sample((px + (sx + 0.5) / ss) / size, (py + (sy + 0.5) / ss) / size, glyph, rim);
          if (!c) continue;
          for (let k = 0; k < 3; k++) sum[k] += c[k];
          a++;
        }
      }
      const o = (py * size + px) * 4;
      for (let k = 0; k < 3; k++) rgba[o + k] = a ? Math.round(sum[k] / a) : 0;
      rgba[o + 3] = Math.round((a / (ss * ss)) * 255);
    }
  }
  return rgba;
}

// Uncompressed true-colour TGA, BGRA, top-left origin with 8 alpha bits (descriptor 0x28).
function tga(size, rgba) {
  const head = Buffer.alloc(18);
  head[2] = 2;
  head.writeUInt16LE(size, 12);
  head.writeUInt16LE(size, 14);
  head[16] = 32;
  head[17] = 0x28;
  const body = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    body[i * 4] = rgba[i * 4 + 2];
    body[i * 4 + 1] = rgba[i * 4 + 1];
    body[i * 4 + 2] = rgba[i * 4];
    body[i * 4 + 3] = rgba[i * 4 + 3];
  }
  return Buffer.concat([head, body]);
}

// Over a mid-grey backdrop, for previews only.
function preview(size, rgba) {
  const data = Buffer.alloc(size * size * 3);
  for (let i = 0; i < size * size; i++) {
    const a = rgba[i * 4 + 3] / 255;
    for (let c = 0; c < 3; c++) data[i * 3 + c] = Math.round(rgba[i * 4 + c] * a + 96 * (1 - a));
  }
  return encodePNG({ width: size, height: size, data });
}

// The portrait is masked round by the game; the minimap icon and side tab carry their
// own round edge. Small icons get a larger glyph so it stays readable.
const ICONS = [
  { name: 'portrait', size: 128, fill: 0.68, rim: 0 },
  { name: 'icon', size: 64, fill: 0.68, rim: 0.04 },
  { name: 'minimap', size: 32, fill: 0.78, rim: 0 },
];

fs.mkdirSync(outDir, { recursive: true });
for (const { name, size, fill, rim } of ICONS) {
  const rgba = render(size, placeGlyph(fill), rim);
  fs.writeFileSync(path.join(outDir, `${name}.tga`), tga(size, rgba));
  if (png) fs.writeFileSync(path.join(outDir, `${name}.png`), preview(size, rgba));
  console.log(`${name}.tga ${size}x${size}`);
}
