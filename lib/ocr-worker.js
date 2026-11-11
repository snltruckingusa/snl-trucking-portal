// OCR worker — runs Tesseract in a SEPARATE process.
// Usage: node lib/ocr-worker.js <imagePath>
// Prints JSON { text } to stdout on success; exits non-zero on failure.
// The parent (routes/loads.js) spawns this and treats ANY failure
// (crash, timeout, missing language data) as "OCR unavailable" — the
// main server must never crash because OCR failed.
//
// If tessdata/eng.traineddata exists next to the project root, it is used
// (no network fetch). Otherwise tesseract.js downloads the language data
// from its CDN at runtime.
const fs = require('fs');
const path = require('path');

async function main() {
  const imagePath = process.argv[2];
  if (!imagePath) {
    console.error('usage: node lib/ocr-worker.js <imagePath>');
    process.exit(2);
  }
  const Tesseract = require('tesseract.js');
  const langPath = path.join(__dirname, '..', 'tessdata');
  const opts = { logger: () => {} };
  // tesseract.js opens the gzipped file, so check for .gz.
  if (fs.existsSync(path.join(langPath, 'eng.traineddata.gz'))) {
    opts.langPath = langPath;
  }
  const result = await Tesseract.recognize(imagePath, 'eng', opts);
  process.stdout.write(JSON.stringify({ text: result.data.text || '' }));
  process.exit(0);
}

main().catch((err) => {
  console.error(err && err.message ? err.message : String(err));
  process.exit(1);
});
