import fs from "fs-extra";
import XLSX from "xlsx";
import { chromium } from "playwright";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import PDFDocument from "pdfkit";
import sharp from "sharp";

const contextDir = './auth-session';

let cookieAccepted = false;
let isGatedLogin = false;

const config = {
  devBase: "http://localhost:3000",
  prodBase: "https://recordati-plus.de",
  excelFile: "urls.xlsx",
  screenshotDir: "screenshots",
  reportPath: "reports/result-2.pdf"
};

function getEnvironment(url) {
  if (url.includes("localhost")) return "local";
  if (url.includes("dev.")) return "Dev";
  if (url.includes("stage.")) return "Stage";
  return "Prod";
}

async function readUrlsFromExcel(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`Excel file not found: ${filePath}`);
  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(sheet);
  if (!data.length) throw new Error('Excel file is empty');
  const firstColumnName = Object.keys(data[0])[0];
  return data
    .map(row => {
      const fullUrl = row[firstColumnName];
      if (!fullUrl) return null;
      try {
        const url = new URL(fullUrl);
        return url.pathname;
      } catch {
        const cleanUrl = fullUrl.toString().trim();
        return cleanUrl.startsWith('/') ? cleanUrl : `/${cleanUrl}`;
      }
    })
    .filter(Boolean);
}

async function ensureLoggedIn(page) {
  await page.goto(`${config.devBase}/de_DE/overview-page`, { waitUntil: "domcontentloaded" });
  if (page.url().includes("sso.omnizia.com")) {
    console.log("🔑 Login required. Please complete login in the opened browser...");
    await page.waitForURL(url => url.toString().startsWith(config.devBase), { timeout: 120000 });
    console.log("✅ Login successful.");
  } else {
    console.log("✅ Already logged in.");
  }
}

async function ensureLoggedInAndNavigate(page) {
  await page.goto(`${config.devBase}/de_DE/account/signin`, {waitUntil: "domcontentloaded"});
  if (page.url().includes("/account/signin")) {
    console.log("🔑 DEV Login required. Please complete login in the opened browser...");
    await page.waitForURL(url => url.toString().startsWith(config.devBase) && !url.toString().includes("/account/signin"), {timeout: 120000});
    console.log("✅ DEV Login successful.");
  } else {
    console.log("✅ DEV Already logged in.");
  }
  await page.goto(`${config.prodBase}/de_DE/account/signin`, {waitUntil: "domcontentloaded"});
  if (page.url().includes("/account/signin")) {
    console.log("🔑 PROD Login required. Please complete login in the opened browser...");
    await page.waitForURL(url => url.toString().startsWith(config.prodBase) && !url.toString().includes("/account/signin"), {timeout: 120000});
    console.log("✅ PROD Login successful.");
  } else {
    console.log("✅ PROD Already logged in.");
  }
  isGatedLogin = true;
}

async function captureScreenshot(page, url, outputPath) {
  await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForLoadState("domcontentloaded");
  if (!cookieAccepted) {
    try {
      const cookieButton = page.locator('button.cky-btn-accept[aria-label="Alle akzeptieren"]').first();
      if (await cookieButton.isVisible()) {
        await cookieButton.click();
        await page.waitForTimeout(500);
      }
    } catch {}
  }
  await page.addStyleTag({
    content: `
      .app_container.theme { position: static !important; height: auto !important; }
      .layout { position: relative !important; height: auto !important; }
      .theme .content { position: static !important; display: block !important; }
    `
  });
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(3000);
  await page.screenshot({ 
    path: outputPath, 
    fullPage: true, 
    type: 'jpeg', 
    quality: 100 // Aggressive compression for small size
  });
}

function padImage(img, targetWidth, targetHeight) {
  if (img.width === targetWidth && img.height === targetHeight) return img;
  const padded = new PNG({ width: targetWidth, height: targetHeight, fill: true });
  padded.data.fill(255);
  PNG.bitblt(img, padded, 0, 0, img.width, img.height, 0, 0);
  return padded;
}

async function compareScreenshots(img1Path, img2Path, diffPath) {
  // Convert JPEGs to PNG buffers for pixelmatch
  const img1Buffer = await sharp(img1Path).png().toBuffer();
  const img2Buffer = await sharp(img2Path).png().toBuffer();
  let img1 = PNG.sync.read(img1Buffer);
  let img2 = PNG.sync.read(img2Buffer);
  const width = Math.max(img1.width, img2.width);
  const height = Math.max(img1.height, img2.height);
  img1 = padImage(img1, width, height);
  img2 = padImage(img2, width, height);
  const diff = new PNG({ width, height });
  const numDiffPixels = pixelmatch(img1.data, img2.data, diff.data, width, height, { threshold: 0.1 });

  // Save diff as JPEG (optimized)
  const diffJpgPath = diffPath.replace(/\.png$/, '.jpg');
  const diffPngBuffer = PNG.sync.write(diff);
  await sharp(diffPngBuffer)
    .jpeg({ quality: 100 }) // Aggressive compression
    .toFile(diffJpgPath);

  return { numDiffPixels, diffJpgPath };
}

async function generatePDFReport(results, summary, startTime, endTime) {
  const doc = new PDFDocument({
    autoFirstPage: false,
    margins: { top: 20, bottom: 20, left: 50, right: 50 }
  });
  const writeStream = fs.createWriteStream(config.reportPath);
  doc.pipe(writeStream);

  // Cover page
  doc.addPage();
  doc.fontSize(24).text('Visual Comparison Report', {align: 'center'});
  doc.moveDown(1.5);
  doc.fontSize(16).text(' 🚀 Performance Summary', {align: 'left'});
  doc.moveDown(0.5);
  doc.fontSize(12).text(`Total URLs processed: ${summary.totalUrls}`);
  doc.text(`Start time: ${startTime} - End time: ${endTime}`);
  doc.text(`Average task duration: ${summary.avgDuration.toFixed(2)}s`);
  doc.text(`Total execution time: ${summary.totalDuration.toFixed(2)}s`);
  doc.text(`Total time: ${(summary.totalDuration / 60).toFixed(2)} min / ${(summary.totalDuration / 3600).toFixed(2)} hr`);
  
  doc.moveDown(1);
  doc.fontSize(12).text(`Generated: ${new Date().toLocaleString()}`, {align: 'center'});

  // Helper to calculate dimensions for JPEG
  async function calculateDimensions(imgPath, imgWidth, imageMaxheight) {
    if (fs.existsSync(imgPath)) {
      const meta = await sharp(imgPath).metadata();
      let finalWidth = imgWidth;
      let finalHeight = (meta.height * imgWidth) / meta.width;
      if (finalHeight > imageMaxheight) {
        finalHeight = imageMaxheight;
        finalWidth = (meta.width * finalHeight) / meta.height;
      }
      return {width: finalWidth, height: finalHeight};
    }
    return { width: 0, height: 0};
  }

  // Draw images side by side (JPEG)
  async function drawImageWithLabel(imgPath, label, x, y, imgWidth, imageMaxheight) {
    if (fs.existsSync(imgPath)) {
      const resizedPath = imgPath.replace(/\.jpg$/, `_resized.jpg`);
      const meta = await sharp(imgPath).metadata();
      let finalWidth = imgWidth;
      let finalHeight = (meta.height * imgWidth) / meta.width;
      if (finalHeight > imageMaxheight) {
        finalHeight = imageMaxheight;
        finalWidth = (meta.width * finalHeight) / meta.height;
      }
      await sharp(imgPath)
        .resize({ width: Math.round(finalWidth), height: Math.round(finalHeight), fit: 'inside' })
        .jpeg({ quality: 80 }) // Higher quality for less blur
        .toFile(resizedPath);

      doc.fontSize(10).text(label, x, y, {width: finalWidth, align: 'center'});
      doc.image(resizedPath, x, y + 15, {width: finalWidth});
      fs.unlinkSync(resizedPath);
      return finalHeight;
    }
    return 0;
  }

  // For each result, add a page
  for (const result of results) {
    doc.addPage();
    doc.fontSize(16).text(`URL: ${result.url}`, {underline: true});
    doc.moveDown();

    const imgWidth = 180;
    const imgGap = 30;
    const pageWidth = doc.page.width;
    const totalWidth = imgWidth * 3 + imgGap * 2;
    const startX = (pageWidth - totalWidth) / 2;
    const y = doc.y;
    const imageMaxheight = 580;

    const devDims = await calculateDimensions(result.devPath, imgWidth, imageMaxheight);
    const prodDims = await calculateDimensions(result.prodPath, imgWidth, imageMaxheight);
    const diffDims = await calculateDimensions(result.diffPath, imgWidth, imageMaxheight);

    const devHeight = devDims.height ? await drawImageWithLabel(result.devPath, getEnvironment(config.devBase), startX, y, imgWidth, imageMaxheight) : 0;
    const prodHeight = prodDims.height ? await drawImageWithLabel(result.prodPath, getEnvironment(config.prodBase), startX + imgWidth + imgGap, y, imgWidth, imageMaxheight) : 0;
    const diffHeight = diffDims.height ? await drawImageWithLabel(result.diffPath, 'Compare', startX + (imgWidth + imgGap) * 2, y, imgWidth, imageMaxheight) : 0;

    const maxImgHeight = Math.max(devHeight, prodHeight, diffHeight);
    let descY = y + maxImgHeight + 45;

    doc.x = doc.page.margins.left;
    doc.y = descY;
    doc.moveDown();
    doc.fontSize(14).text(
      `Match: ${result.match ? '✅ No visual difference' : `❌ ${result.diffPixels} pixels differ`}`,
      {align: 'left', width: pageWidth - doc.page.margins.left - doc.page.margins.right}
    );
    if (!result.match) {
      doc.moveDown();
      doc.fontSize(12).fillColor('red').text(
        'Differences highlighted in the DIFF image above. Red/pink areas show where the screenshots differ.',
        {align: 'left', width: pageWidth - doc.page.margins.left - doc.page.margins.right}
      );
      doc.fillColor('black');
    }
  }

  doc.end();
  await new Promise(resolve => writeStream.on('finish', resolve));
  console.log(`📄 PDF report generated: ${config.reportPath}`);
}

async function runWithConcurrencyLimit(tasks, limit) {
  const results = [];
  const executing = [];
  for (const task of tasks) {
    const p = task().then(result => {
      executing.splice(executing.indexOf(p), 1);
      return result;
    });
    results.push(p);
    executing.push(p);
    if (executing.length >= limit) {
      await Promise.race(executing);
    }
  }
  return Promise.all(results);
}

async function main() {
  try {
    const startTime = Date.now();
    ['dev', 'prod', 'diff'].forEach(dir => {
      fs.emptyDirSync(`${config.screenshotDir}/${dir}`);
      fs.ensureDirSync(`${config.screenshotDir}/${dir}`);
    });
    fs.emptyDirSync('reports');
    fs.ensureDirSync('reports');

    const urls = await readUrlsFromExcel(config.excelFile);
    if (!urls.length) return console.log('No URLs to process. Exiting.');

    const browser = await chromium.launchPersistentContext(contextDir, {
      headless: false,
      args: ['--disable-blink-features=AutomationControlled'],
      viewport: null
    });

    const page = await browser.newPage();
    await ensureLoggedIn(page);
    if(!isGatedLogin) await ensureLoggedInAndNavigate(page);
    await page.close();

    const concurrency = 5;
    const tasks = urls.map(urlPath => async () => {
      const taskStartTime = Date.now();
      const cleanName = urlPath.replace(/\W+/g, '_');
      const paths = {
        dev: `${config.screenshotDir}/dev/${cleanName}.jpg`,
        prod: `${config.screenshotDir}/prod/${cleanName}.jpg`,
        diff: `${config.screenshotDir}/diff/${cleanName}_diff.jpg`
      };
      for (let attempt = 1; attempt <= 3; attempt++) {
        const tab = await browser.newPage();
        try {
          await captureScreenshot(tab, `${config.devBase}${urlPath}`, paths.dev);
          await captureScreenshot(tab, `${config.prodBase}${urlPath}`, paths.prod);
          const { numDiffPixels, diffJpgPath } = await compareScreenshots(paths.dev, paths.prod, paths.diff);
          await tab.close();
          const taskDuration = (Date.now() - taskStartTime) / 1000;
          return {
            url: urlPath,
            match: numDiffPixels === 0,
            diffPixels: numDiffPixels,
            devPath: paths.dev,
            prodPath: paths.prod,
            diffPath: diffJpgPath,
            duration: taskDuration
          };
        } catch (error) {
          await tab.close();
          if (attempt === 3) return null;
        }
      }
    });

    const results = (await runWithConcurrencyLimit(tasks, concurrency)).filter(Boolean);
    await browser.close();

    const totalDuration = (Date.now() - startTime) / 1000;
    const avgDuration = results.reduce((sum, r) => sum + r.duration, 0) / results.length;

    await generatePDFReport(results, {
      totalUrls: results.length,
      avgDuration,
      totalDuration,
      startTime,
      endTime: Date.now()
    });

  } catch (error) {
    console.error('❌ Process failed:', error.message);
    process.exit(1);
  }
}

main();