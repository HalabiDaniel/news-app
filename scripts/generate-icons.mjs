/**
 * Draws the app icons from one SVG source.
 *
 * The PNGs are committed, so this runs approximately never — but "how was the
 * icon made" is an annoying question to answer from a binary, and a home-screen
 * icon is the one asset you cannot regenerate by hand at four sizes.
 *
 * `sharp` is not a dependency of this project; it arrives as an optional
 * dependency of Next.js, which is enough for a one-off local script:
 *
 *   node scripts/generate-icons.mjs
 *
 * iOS specifics that drove the shapes below:
 *   * apple-touch-icon.png must be 180x180 and OPAQUE. Transparency renders as
 *     black, and iOS applies its own rounding — so no transparent corners here.
 *   * the maskable icon is cropped to a circle on some launchers, so its motif
 *     stays inside the middle 80% and the background bleeds to the edge.
 *   * the badge is a monochrome silhouette (Android tints it; iOS ignores it),
 *     so it is white-on-transparent and much bolder than it looks at 1x.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

// The palette is the light theme's from app/globals.css: the accent brown and
// the warm paper it sits on. The icon should look like the app it opens.
const ACCENT = '#9a4a1f';
const PAPER = '#fbfaf7';

/**
 * The motif: a page of prose with one word picked out — which is the whole
 * product. Four full lines, one short closing line, and the second line broken
 * so a highlighted word sits inside it in the paper colour's negative space.
 *
 * @param inset fraction of the canvas kept clear around the motif. The maskable
 * icon needs a big one; the ordinary icons look weak with anything over 0.16.
 */
function iconSvg({ background, ink, inset }) {
  const S = 512;
  const left = S * inset;
  const width = S * (1 - inset * 2);
  const bar = width * 0.115; // line thickness
  const gap = bar * 1.62;
  const radius = bar / 2;
  const top = S / 2 - (bar * 5 + gap * 4) / 2;

  // [start, length] as fractions of the motif width. The gap in line two is the
  // glossed word; the last line is short, the way a paragraph ends.
  const lines = [
    [[0, 1]],
    [[0, 0.38], [0.46, 0.54]],
    [[0, 1]],
    [[0, 1]],
    [[0, 0.56]],
  ];

  const rects = lines
    .flatMap((segments, row) =>
      segments.map(([start, length]) => {
        const y = top + row * (bar + gap);
        const x = left + width * start;
        return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(width * length).toFixed(1)}" height="${bar.toFixed(1)}" rx="${radius.toFixed(1)}" fill="${ink}"/>`;
      }),
    )
    .join('');

  const backdrop = background ? `<rect width="${S}" height="${S}" fill="${background}"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">${backdrop}${rects}</svg>`;
}

async function render(name, svg, size) {
  const png = await sharp(Buffer.from(svg)).resize(size, size).png({ compressionLevel: 9 }).toBuffer();
  await writeFile(path.join(PUBLIC_DIR, name), png);
  console.log(`${name.padEnd(24)} ${size}x${size}  ${(png.length / 1024).toFixed(1)} kB`);
}

const standard = iconSvg({ background: ACCENT, ink: PAPER, inset: 0.16 });

await render('icon-192.png', standard, 192);
await render('icon-512.png', standard, 512);
// Full-bleed background, motif pulled well inside the safe zone.
await render('icon-maskable-512.png', iconSvg({ background: ACCENT, ink: PAPER, inset: 0.28 }), 512);
// Opaque by construction — the background rect covers the whole canvas.
await render('apple-touch-icon.png', standard, 180);
// Silhouette: no background at all, so the launcher can tint it.
await render('badge-72.png', iconSvg({ background: null, ink: '#ffffff', inset: 0.1 }), 72);
