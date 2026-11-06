# Bundled components

Borges is a personal build for x86-64 Arch Linux. No Calibre code or downloaded books are included.
Exact installed dependency versions/integrities are recorded by the source checkout's
pnpm-lock.yaml; this bundle records its hash and reader/runtime pins in BUILD-INFO.json.

- Electron/Chromium/Node: root LICENSE and LICENSES.chromium.html (upstream notices).
- React, React DOM and scheduler: resources/app/notices/*.LICENSE (MIT).
- PDF.js: resources/app/out/renderer/reader-assets/pdf/LICENSE (Apache-2.0).
  Its cmaps, standard_fonts and wasm directories retain their own license files,
  including Adobe CMaps, Foxit/Liberation fonts and image/colour/JavaScript decoders.
- foliate-js: resources/app/out/renderer/reader-assets/foliate/LICENSE (MIT).
  Its vendor assets retain upstream headers/notices and the bundled PDF.js/font/CMap
  licenses. Its minified zip.js (BSD-3-Clause) and fflate (MIT) omit upstream
  headers; their license texts are supplied in resources/app/notices/zip.js.LICENSE
  and fflate.LICENSE. Those texts were retrieved from the upstream v2.7.52/v0.8.2
  tags named by foliate's declared dependency ranges. The exact vendored bytes are
  pinned by the foliate commit and hashes in BUILD-INFO.json, not an inferred
  installed package version. The vendored PDF.js directory also receives the
  complete Apache-2.0 license from the installed PDF.js distribution.
- Borges' small book icon is created for this project. Interface fonts come from
  the operating system and are not redistributed here.

Reading assets are bundled locally. No installation-time package manager or runtime
download is needed. Keep the whole application directory and its notices together.
