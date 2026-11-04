import { crc32, deflateRawSync, deflateSync } from "node:zlib";

// Book-length created documents for measurement only. Text is deterministic
// pseudo-prose; generator counts are the independent oracle for search totals.
// Vocabulary uses consonant-vowel syllables, so it never forms the query words.
export const COMMON_WORD = "lantern";
export const RARE_WORD = "quartzfinal";
export const PDF_OPENING = "REPRESENTATIVE PDF OPENING";
export const EPUB_OPENING = "REPRESENTATIVE EPUB OPENING";

export interface RepresentativeDocument {
  bytes: Buffer;
  commonCount: number;
  rareLocation: number;
  /** Physical pages for PDF, spine chapters for EPUB. */
  units: number;
  words: number;
  images: number;
}

function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function prose(seed: number) {
  const next = random(seed);
  const consonants = "bdfgklmnprstvz";
  const vowels = "aeiou";
  const vocabulary = Array.from({ length: 2000 }, () => {
    let word = "";
    const syllables = 1 + Math.floor(next() * 3);
    for (let i = 0; i < syllables; i++)
      word +=
        consonants.charAt(Math.floor(next() * consonants.length)) +
        vowels.charAt(Math.floor(next() * vowels.length));
    return word;
  });
  let common = 0;
  return {
    get common() {
      return common;
    },
    /** About one common query word per 150 words. */
    words(count: number) {
      const out: string[] = [];
      for (let i = 0; i < count; i++) {
        if (next() < 1 / 150) {
          out.push(COMMON_WORD);
          common++;
        } else
          out.push(vocabulary[Math.floor(next() * vocabulary.length)] ?? "");
      }
      return out;
    },
  };
}

/** RGB gradient image; distinct per index so images are not deduplicated. */
function gradient(width: number, height: number, index: number) {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3;
      pixels[offset] = (x * 255) / width;
      pixels[offset + 1] = (y * 255) / height;
      pixels[offset + 2] = (index * 37) % 256;
    }
  return pixels;
}

function png(width: number, height: number, index: number) {
  const pixels = gradient(width, height, index);
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++)
    pixels.copy(
      rows,
      y * (width * 3 + 1) + 1,
      y * width * 3,
      (y + 1) * width * 3,
    );
  const chunk = (kind: string, data: Buffer) => {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(kind, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([header, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function representativePdf(pages = 400): RepresentativeDocument {
  const text = prose(0x5eed01);
  const rarePage = pages - 3;
  const objects: Buffer[] = [Buffer.alloc(0), Buffer.alloc(0)];
  const add = (object: Buffer | string) =>
    objects.push(Buffer.isBuffer(object) ? object : Buffer.from(object)) &&
    objects.length;
  const stream = (dictionary: string, data: Buffer) =>
    add(
      Buffer.concat([
        Buffer.from(
          `<< ${dictionary} /Filter /FlateDecode /Length ${data.length} >>\nstream\n`,
        ),
        data,
        Buffer.from("\nendstream"),
      ]),
    );
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const kids: number[] = [];
  let words = 0;
  let images = 0;
  for (let page = 1; page <= pages; page++) {
    const lines: string[] = [];
    for (let line = 0; line < 44; line++) {
      const row = text.words(12);
      if (page === rarePage && line === 20) row[5] = RARE_WORD;
      words += row.length;
      lines.push(row.join(" "));
    }
    const title = page === 1 ? PDF_OPENING : `Page heading ${page}`;
    let content = `BT /F1 16 Tf 54 740 Td (${title}) Tj ET\nBT /F1 11 Tf 15 TL 54 712 Td\n${lines.map((line) => `(${line}) '`).join("\n")}\nET\n`;
    let resources = `/Font << /F1 ${font} 0 R >>`;
    if (page % 25 === 0) {
      // A full-colour illustration every 25 pages, drawn under the text block.
      const image = stream(
        "/Type /XObject /Subtype /Image /Width 480 /Height 320 /ColorSpace /DeviceRGB /BitsPerComponent 8",
        deflateSync(gradient(480, 320, page)),
      );
      images++;
      content = `q 360 0 0 240 126 60 cm /Im1 Do Q\n${content}`;
      resources += ` /XObject << /Im1 ${image} 0 R >>`;
    }
    const contents = stream("", deflateSync(content));
    kids.push(
      add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << ${resources} >> /Contents ${contents} 0 R >>`,
      ),
    );
  }
  objects[0] = Buffer.from("<< /Type /Catalog /Pages 2 0 R >>");
  objects[1] = Buffer.from(
    `<< /Type /Pages /Count ${kids.length} /Kids [${kids.map((kid) => `${kid} 0 R`).join(" ")}] >>`,
  );
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n")];
  let length = parts[0]?.length ?? 0;
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(length);
    const part = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`),
      object,
      Buffer.from("\nendobj\n"),
    ]);
    parts.push(part);
    length += part.length;
  });
  parts.push(
    Buffer.from(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
        .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
        .join(
          "",
        )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`,
    ),
  );
  return {
    bytes: Buffer.concat(parts),
    commonCount: text.common,
    rareLocation: rarePage,
    units: pages,
    words,
    images,
  };
}

function zip(entries: { path: string; data: Buffer; store?: boolean }[]) {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const { path, data, store } of entries) {
    const name = Buffer.from(path);
    const body = store ? data : deflateRawSync(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(store ? 0 : 8, 8);
    header.writeUInt16LE(0x5c21, 12); // 2026-01-01 date
    header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    header.copy(record, 8, 6, 30);
    record.writeUInt32LE(offset, 42);
    local.push(header, name, body);
    central.push(record, name);
    offset += header.length + name.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

export function representativeEpub(chapters = 40): RepresentativeDocument {
  const text = prose(0x5eed02);
  const rareChapter = chapters - 2;
  const entries: { path: string; data: Buffer; store?: boolean }[] = [
    {
      path: "mimetype",
      data: Buffer.from("application/epub+zip"),
      store: true,
    },
    {
      path: "META-INF/container.xml",
      data: Buffer.from(
        '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      ),
    },
  ];
  const manifest: string[] = [];
  const spine: string[] = [];
  const toc: string[] = [];
  let words = 0;
  let images = 0;
  for (let chapter = 1; chapter <= chapters; chapter++) {
    const paragraphs: string[] = [];
    for (let paragraph = 0; paragraph < 30; paragraph++) {
      const row = text.words(100);
      if (chapter === rareChapter && paragraph === 17) row[40] = RARE_WORD;
      words += row.length;
      paragraphs.push(`<p>${row.join(" ")}</p>`);
    }
    let image = "";
    if (chapter % 5 === 0) {
      const href = `image-${chapter}.png`;
      entries.push({ path: href, data: png(800, 600, chapter), store: true });
      manifest.push(
        `<item id="img${chapter}" href="${href}" media-type="image/png"/>`,
      );
      image = `<p><img src="${href}" width="800" height="600" alt="Illustration ${chapter}" style="max-width:100%;height:auto"/></p>`;
      images++;
    }
    const title = chapter === 1 ? EPUB_OPENING : `Chapter heading ${chapter}`;
    const href = `chapter-${chapter}.xhtml`;
    entries.push({
      path: href,
      data: Buffer.from(
        `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head><body><h1>${title}</h1>${paragraphs.slice(0, 10).join("")}${image}${paragraphs.slice(10).join("")}</body></html>`,
      ),
    });
    manifest.push(
      `<item id="c${chapter}" href="${href}" media-type="application/xhtml+xml"/>`,
    );
    spine.push(`<itemref idref="c${chapter}"/>`);
    toc.push(`<li><a href="${href}">${title}</a></li>`);
  }
  entries.push(
    {
      path: "nav.xhtml",
      data: Buffer.from(
        `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol>${toc.join("")}</ol></nav></body></html>`,
      ),
    },
    {
      path: "book.opf",
      data: Buffer.from(
        `<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">urn:uuid:4f1f0a52-7bd4-4c39-9a44-8d2f0d7c5e11</dc:identifier><dc:title>Borges representative measurement book</dc:title><dc:language>en</dc:language><meta property="dcterms:modified">2026-01-01T00:00:00Z</meta></metadata><manifest>${manifest.join("")}<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine>${spine.join("")}</spine></package>`,
      ),
    },
  );
  return {
    bytes: zip(entries),
    commonCount: text.common,
    rareLocation: rareChapter,
    units: chapters,
    words,
    images,
  };
}
