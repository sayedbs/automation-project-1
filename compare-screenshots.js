import fs from "fs-extra";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import PDFDocument from "pdfkit";
import path from "path";
import jpeg from "jpeg-js";

const config = {
  devDir: "screenshots/dev",
  prodDir: "screenshots/prod",
  diffDir: "screenshots/diff",
  reportPath: "reports/result-report.pdf"
};

fs.ensureDirSync(config.diffDir);
fs.ensureDirSync("reports");

// Helper to read PNG or JPG as {width, height, data}
function readImage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const buf = fs.readFileSync(filePath);
  if (ext === ".png") {
    return PNG.sync.read(buf);
  } else if (ext === ".jpg" || ext === ".jpeg") {
    const jpg = jpeg.decode(buf, { useTArray: true });
    // Convert JPEG (no alpha) to RGBA
    if (jpg.data.length === jpg.width * jpg.height * 4) {
      return { width: jpg.width, height: jpg.height, data: jpg.data };
    } else {
      // Add alpha channel if missing
      const rgba = Buffer.alloc(jpg.width * jpg.height * 4);
      for (let i = 0; i < jpg.width * jpg.height; i++) {
        rgba[i * 4 + 0] = jpg.data[i * 3 + 0];
        rgba[i * 4 + 1] = jpg.data[i * 3 + 1];
        rgba[i * 4 + 2] = jpg.data[i * 3 + 2];
        rgba[i * 4 + 3] = 255;
      }
      return { width: jpg.width, height: jpg.height, data: rgba };
    }
  } else {
    throw new Error(`Unsupported image format: ${filePath}`);
  }
}

// Pad image to target size (white background)
function padImage(img, targetWidth, targetHeight) {
  if (img.width === targetWidth && img.height === targetHeight) return img;
  const padded = Buffer.alloc(targetWidth * targetHeight * 4, 255);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const srcIdx = (y * img.width + x) * 4;
      const dstIdx = (y * targetWidth + x) * 4;
      img.data.copy(padded, dstIdx, srcIdx, srcIdx + 4);
    }
  }
  return { width: targetWidth, height: targetHeight, data: padded };
}

function getScreenshotPairs() {
  const devFiles = fs.readdirSync(config.devDir).filter(f => /\.(png|jpg|jpeg)$/i.test(f));
  return devFiles.map(file => ({
    name: file.replace(/\.(png|jpg|jpeg)$/i, ""),
    dev: path.join(config.devDir, file),
    prod: path.join(config.prodDir, file),
    diff: path.join(config.diffDir, file.replace(/\.(png|jpg|jpeg)$/i, "_diff.png"))
  })).filter(pair => fs.existsSync(pair.prod));
}

function compareScreenshots(devPath, prodPath, diffPath) {
  let devImg = readImage(devPath);
  let prodImg = readImage(prodPath);
  const width = Math.max(devImg.width, prodImg.width);
  const height = Math.max(devImg.height, prodImg.height);

  devImg = padImage(devImg, width, height);
  prodImg = padImage(prodImg, width, height);

  const diff = new PNG({ width, height });
  const diffPixels = pixelmatch(devImg.data, prodImg.data, diff.data, width, height, { threshold: 0.1 });
  fs.writeFileSync(diffPath, PNG.sync.write(diff));
  return diffPixels;
}

async function generatePDFReport(results) {
  const doc = new PDFDocument({ autoFirstPage: false });
  doc.pipe(fs.createWriteStream(config.reportPath));
  for (const r of results) {
    doc.addPage();
    doc.fontSize(14).text(`URL: ${r.name}`);
    doc.moveDown();
    doc.fontSize(12).text(`Match: ${r.diffPixels === 0 ? "✅ Yes" : `❌ No (${r.diffPixels} pixels differ)`}`);
    doc.moveDown();
    doc.image(r.dev, { width: 250, continued: true }).image(r.prod, { width: 250, align: "right" });
    if (r.diffPixels > 0) {
      doc.moveDown();
      doc.image(r.diff, { width: 250 });
    }
    doc.moveDown();
  }
  doc.end();
  console.log(`PDF report generated: ${config.reportPath}`);
}

async function main() {
  const pairs = getScreenshotPairs();
  const results = [];
  for (const pair of pairs) {
    const diffPixels = compareScreenshots(pair.dev, pair.prod, pair.diff);
    results.push({ ...pair, diffPixels });
    console.log(`${pair.name}: ${diffPixels === 0 ? "Match" : `Diff (${diffPixels} pixels)`}`);
  }
  await generatePDFReport(results);
}

main();