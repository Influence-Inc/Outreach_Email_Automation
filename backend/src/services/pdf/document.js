'use strict';

// A very small PDF writer — just enough to typeset the executed contract.
//
// It deliberately avoids a PDF library: the backend has five runtime
// dependencies and none of them pull in a rendering stack, so a document made
// of flowing text, hairline rules and one embedded signature image is cheaper
// to write than to depend on. The supported feature set is exactly that: a
// single page size, the three Helvetica variants, greyscale images, and a
// top-to-bottom cursor that starts a new page when it runs out of room.

const zlib = require('zlib');
const { BASE_FONTS, encodeWinAnsi, stringWidth, wrapText } = require('./metrics');

// US Letter in points, matching the brands and creators this is sent to.
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 54;

const FONT_KEYS = { helvetica: 'F1', bold: 'F2', italic: 'F3' };

// Escape a string into a PDF literal-string body. The bytes are WinAnsi, so the
// result is handled as latin1 all the way to the output Buffer.
function pdfString(text) {
  let out = '';
  for (const byte of encodeWinAnsi(text)) {
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) out += '\\';
    out += String.fromCharCode(byte);
  }
  return out;
}

function pdfDate(date) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `D:${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z00'00'`
  );
}

class PdfDocument {
  constructor({ title = '', margin = MARGIN } = {}) {
    this.title = title;
    this.margin = margin;
    this.width = PAGE_WIDTH;
    this.height = PAGE_HEIGHT;
    this.contentWidth = PAGE_WIDTH - margin * 2;
    // Leave a band at the foot of every page for the page-number line.
    this.bottom = margin + 26;
    this.pages = [];
    this.images = [];
    this.page = null;
    this.y = 0;
    this.addPage();
  }

  addPage() {
    this.page = { ops: [], images: new Set() };
    this.pages.push(this.page);
    this.y = this.height - this.margin;
    return this.page;
  }

  // Reserve `height` points of vertical space, breaking to a new page first if
  // the current one can't hold it.
  ensureSpace(height) {
    if (this.y - height < this.bottom) this.addPage();
  }

  space(height) {
    this.y -= height;
  }

  op(str) {
    this.page.ops.push(str);
  }

  setFill(gray) {
    this.op(`${gray} g`);
  }

  // Draw a single line of text at an absolute position. Callers that need flow
  // layout use text()/keyValue() instead.
  drawText(text, x, y, { font = 'helvetica', size = 10, gray = 0.1 } = {}) {
    const key = FONT_KEYS[font] || FONT_KEYS.helvetica;
    this.setFill(gray);
    this.op(`BT /${key} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${pdfString(text)}) Tj ET`);
  }

  // Flowing paragraph. Returns the height consumed.
  text(value, opts = {}) {
    const {
      font = 'helvetica',
      size = 10,
      gray = 0.1,
      leading = size * 1.35,
      x = this.margin,
      width = this.contentWidth,
      indent = 0,
      spaceAfter = 0,
    } = opts;
    const lines = wrapText(value, font, size, width - indent);
    for (const line of lines) {
      this.ensureSpace(leading);
      this.y -= leading;
      this.drawText(line, x + indent, this.y, { font, size, gray });
    }
    if (lines.length) this.y -= spaceAfter;
    return lines.length * leading + (lines.length ? spaceAfter : 0);
  }

  // Section heading: small caps-ish label with a hairline under it. Kept with
  // at least a couple of lines of its section so a heading never strands at the
  // foot of a page.
  heading(value, { keepWith = 42 } = {}) {
    this.ensureSpace(22 + keepWith);
    this.y -= 16;
    this.drawText(value, this.margin, this.y, { font: 'bold', size: 11, gray: 0.1 });
    this.y -= 6;
    this.rule({ gray: 0.82 });
    this.y -= 8;
  }

  rule({ gray = 0.88, width = this.contentWidth, x = this.margin } = {}) {
    this.op(`${gray} G 0.7 w ${x.toFixed(2)} ${this.y.toFixed(2)} m ${(x + width).toFixed(2)} ${this.y.toFixed(2)} l S`);
  }

  // Label / value row, the layout the signing page uses for every term. The
  // value wraps in its own column so a long clause stays aligned; embedded
  // newlines (a postal address) are kept as hard breaks.
  keyValue(label, value, { labelWidth = 148, size = 10, valueFont = 'helvetica' } = {}) {
    if (value == null || value === '') return;
    const leading = size * 1.35;
    const valueX = this.margin + labelWidth;
    const valueWidth = this.contentWidth - labelWidth;
    const lines = String(value)
      .split('\n')
      .flatMap((part) => wrapText(part, valueFont, size, valueWidth));
    if (!lines.length) return;

    this.ensureSpace(leading * lines.length + 4);
    // The label sits on the first line of the value block.
    let first = true;
    for (const line of lines) {
      this.y -= leading;
      if (first) {
        if (label) this.drawText(label, this.margin, this.y, { size: size - 0.5, gray: 0.45 });
        first = false;
      }
      this.drawText(line, valueX, this.y, { font: valueFont, size, gray: 0.1 });
    }
    this.y -= 4;
  }

  bullet(value, { size = 10 } = {}) {
    const leading = size * 1.35;
    const indent = 14;
    const lines = wrapText(value, 'helvetica', size, this.contentWidth - indent);
    if (!lines.length) return;
    this.ensureSpace(leading * lines.length);
    lines.forEach((line, i) => {
      this.y -= leading;
      if (i === 0) this.drawText('•', this.margin + 2, this.y, { size, gray: 0.45 });
      this.drawText(line, this.margin + indent, this.y, { size, gray: 0.1 });
    });
  }

  // Register a greyscale image (from pdf/png.js) and draw it at the cursor.
  // `boxWidth` / `boxHeight` bound the drawn size; aspect ratio is preserved.
  image(img, { boxWidth = 200, boxHeight = 60, x = this.margin } = {}) {
    if (!img || !img.width || !img.height) return;
    const scale = Math.min(boxWidth / img.width, boxHeight / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    this.ensureSpace(h);
    this.y -= h;
    const index = this.images.push(img) - 1;
    const name = `Im${index + 1}`;
    this.page.images.add(name);
    this.op(
      `q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${this.y.toFixed(2)} cm /${name} Do Q`,
    );
  }

  // Stamp "Page N of M" plus an optional caption on every page. Called at the
  // end, once the total page count is known.
  addFooters(caption = '') {
    const total = this.pages.length;
    this.pages.forEach((page, i) => {
      const saved = this.page;
      this.page = page;
      const y = this.margin - 12;
      if (caption) this.drawText(caption, this.margin, y, { size: 7.5, gray: 0.55 });
      const label = `Page ${i + 1} of ${total}`;
      const x = this.width - this.margin - stringWidth(label, 'helvetica', 7.5);
      this.drawText(label, x, y, { size: 7.5, gray: 0.55 });
      this.page = saved;
    });
  }

  // Serialise everything to a PDF file.
  end() {
    const objects = []; // 1-indexed on write; objects[i] is object i+1
    const add = (body) => objects.push(body) ;

    const catalogId = 1;
    const pagesId = 2;
    add(null); // placeholder for catalog
    add(null); // placeholder for pages

    const fontIds = {};
    for (const [short, base] of Object.entries(BASE_FONTS)) {
      add(
        Buffer.from(
          `<< /Type /Font /Subtype /Type1 /BaseFont /${base} /Encoding /WinAnsiEncoding >>`,
          'latin1',
        ),
      );
      fontIds[FONT_KEYS[short]] = objects.length;
    }

    const imageIds = this.images.map((img) => {
      const dict =
        `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} ` +
        `/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${img.data.length} >>\nstream\n`;
      add(Buffer.concat([Buffer.from(dict, 'latin1'), img.data, Buffer.from('\nendstream', 'latin1')]));
      return objects.length;
    });

    const pageIds = [];
    for (const page of this.pages) {
      const stream = zlib.deflateSync(Buffer.from(page.ops.join('\n'), 'latin1'), { level: 9 });
      add(
        Buffer.concat([
          Buffer.from(`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
          stream,
          Buffer.from('\nendstream', 'latin1'),
        ]),
      );
      const contentId = objects.length;

      const fontRefs = Object.entries(fontIds)
        .map(([key, id]) => `/${key} ${id} 0 R`)
        .join(' ');
      const xobjectRefs = [...page.images]
        .map((name) => `/${name} ${imageIds[Number(name.slice(2)) - 1]} 0 R`)
        .join(' ');
      const resources =
        `<< /Font << ${fontRefs} >>` +
        (xobjectRefs ? ` /XObject << ${xobjectRefs} >>` : '') +
        ' >>';
      add(
        Buffer.from(
          `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${this.width} ${this.height}] ` +
            `/Resources ${resources} /Contents ${contentId} 0 R >>`,
          'latin1',
        ),
      );
      pageIds.push(objects.length);
    }

    const now = new Date();
    add(
      Buffer.from(
        `<< /Title (${pdfString(this.title)}) /Producer (Influence Deal Studio) ` +
          `/CreationDate (${pdfDate(now)}) /ModDate (${pdfDate(now)}) >>`,
        'latin1',
      ),
    );
    const infoId = objects.length;

    objects[catalogId - 1] = Buffer.from(
      `<< /Type /Catalog /Pages ${pagesId} 0 R >>`,
      'latin1',
    );
    objects[pagesId - 1] = Buffer.from(
      `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`,
      'latin1',
    );

    const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
    let offset = chunks[0].length;
    const offsets = [];
    objects.forEach((body, i) => {
      const head = Buffer.from(`${i + 1} 0 obj\n`, 'latin1');
      const tail = Buffer.from('\nendobj\n', 'latin1');
      offsets.push(offset);
      chunks.push(head, body, tail);
      offset += head.length + body.length + tail.length;
    });

    const xrefStart = offset;
    let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
    xref +=
      `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\n` +
      `startxref\n${xrefStart}\n%%EOF\n`;
    chunks.push(Buffer.from(xref, 'latin1'));

    return Buffer.concat(chunks);
  }
}

module.exports = { PdfDocument };
