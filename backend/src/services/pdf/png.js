'use strict';

// Decode the creator's drawn signature into something a PDF can embed.
//
// The signature arrives as a `data:image/png;base64,…` URL produced by
// canvas.toDataURL() on the signing page — always an 8-bit non-interlaced PNG,
// in practice RGBA. PDF cannot consume a PNG file directly: it wants raw
// samples plus a filter it understands. Rather than carry the alpha channel
// through as a separate /SMask, we composite the strokes onto white and emit a
// single DeviceGray plane. That is both simpler and the correct result for a
// printed contract, where the signature sits on a white page anyway.

const zlib = require('zlib');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Bytes per pixel for the colour types we accept (all at bit depth 8).
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

function parseDataUrl(dataUrl) {
  const match = /^data:image\/png;base64,([\s\S]+)$/i.exec(String(dataUrl || '').trim());
  if (!match) return null;
  const buf = Buffer.from(match[1], 'base64');
  return buf.length ? buf : null;
}

// Walk the PNG chunk sequence, collecting the header and the (possibly split)
// image data. Anything else — gAMA, pHYs, tEXt — is irrelevant here.
function readChunks(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('not a PNG');
  }
  let offset = 8;
  let header = null;
  const idat = [];
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end > buf.length) break;
    if (type === 'IHDR') {
      header = {
        width: buf.readUInt32BE(start),
        height: buf.readUInt32BE(start + 4),
        bitDepth: buf[start + 8],
        colorType: buf[start + 9],
        interlace: buf[start + 12],
      };
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(start, end));
    } else if (type === 'IEND') {
      break;
    }
    offset = end + 4; // skip the trailing CRC
  }
  if (!header) throw new Error('PNG has no IHDR');
  return { header, data: Buffer.concat(idat) };
}

// Undo the per-scanline PNG filters (RFC 2083 §6). Each row is prefixed with a
// filter byte and predicted from the pixel to its left (`a`) and the row above
// (`b`, and `c` diagonally), so the rows must be reconstructed in order.
function unfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos];
    pos += 1;
    const rowStart = y * stride;
    const prevStart = rowStart - stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[pos + x];
      const a = x >= bpp ? out[rowStart + x - bpp] : 0;
      const b = y > 0 ? out[prevStart + x] : 0;
      const c = y > 0 && x >= bpp ? out[prevStart + x - bpp] : 0;
      let recon;
      switch (filter) {
        case 0: recon = value; break;
        case 1: recon = value + a; break;
        case 2: recon = value + b; break;
        case 3: recon = value + ((a + b) >> 1); break;
        case 4: {
          // Paeth predictor: pick whichever neighbour the gradient a+b-c is
          // closest to.
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          recon = value + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`unsupported PNG filter ${filter}`);
      }
      out[rowStart + x] = recon & 0xff;
    }
    pos += stride;
  }
  return out;
}

// Flatten the decoded samples to one grey byte per pixel, composited over a
// white background.
function toGray(pixels, width, height, colorType) {
  const bpp = CHANNELS[colorType];
  const gray = Buffer.alloc(width * height);
  for (let i = 0, p = 0; i < gray.length; i += 1, p += bpp) {
    let lum;
    let alpha = 255;
    if (colorType === 0) {
      lum = pixels[p];
    } else if (colorType === 4) {
      lum = pixels[p];
      alpha = pixels[p + 1];
    } else {
      lum = 0.299 * pixels[p] + 0.587 * pixels[p + 1] + 0.114 * pixels[p + 2];
      if (colorType === 6) alpha = pixels[p + 3];
    }
    // over-white composite: out = a*C + (1-a)*255
    gray[i] = Math.round((alpha * lum + (255 - alpha) * 255) / 255);
  }
  return gray;
}

// The signature canvas is far wider than the ink drawn on it, so embedding it
// as-is would place a small squiggle inside a large empty box. Crop to the
// drawn pixels (with a little breathing room) so the signature can be scaled to
// a sensible size on the page.
function trimWhitespace(gray, width, height, threshold = 250) {
  let top = height;
  let bottom = -1;
  let left = width;
  let right = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if (gray[row + x] < threshold) {
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }
  if (bottom < 0) return null; // nothing was drawn

  const padX = Math.max(2, Math.round(width * 0.01));
  const padY = Math.max(2, Math.round(height * 0.04));
  left = Math.max(0, left - padX);
  right = Math.min(width - 1, right + padX);
  top = Math.max(0, top - padY);
  bottom = Math.min(height - 1, bottom + padY);

  const w = right - left + 1;
  const h = bottom - top + 1;
  const out = Buffer.alloc(w * h);
  for (let y = 0; y < h; y += 1) {
    gray.copy(out, y * w, (top + y) * width + left, (top + y) * width + left + w);
  }
  return { width: w, height: h, gray: out };
}

// Decode a canvas signature data URL into { width, height, data } where `data`
// is a Flate-compressed DeviceGray plane ready to become a PDF image XObject.
// Returns null for anything we can't read — a missing signature must never be
// the reason a contract PDF fails to generate.
function decodeSignature(dataUrl, { trim = true } = {}) {
  try {
    const buf = parseDataUrl(dataUrl);
    if (!buf) return null;
    const { header, data } = readChunks(buf);
    if (header.bitDepth !== 8 || header.interlace !== 0) return null;
    const bpp = CHANNELS[header.colorType];
    if (!bpp) return null;
    if (!header.width || !header.height) return null;

    const raw = zlib.inflateSync(data);
    const expected = (header.width * bpp + 1) * header.height;
    if (raw.length < expected) return null;

    const pixels = unfilter(raw, header.width, header.height, bpp);
    let image = {
      width: header.width,
      height: header.height,
      gray: toGray(pixels, header.width, header.height, header.colorType),
    };
    if (trim) {
      const trimmed = trimWhitespace(image.gray, image.width, image.height);
      if (!trimmed) return null; // a blank canvas is the same as no signature
      image = trimmed;
    }

    return {
      width: image.width,
      height: image.height,
      data: zlib.deflateSync(image.gray, { level: 9 }),
    };
  } catch {
    return null;
  }
}

module.exports = { decodeSignature };
