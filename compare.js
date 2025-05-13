import fs from "fs-extra";
import XLSX from "xlsx";
import { chromium } from "playwright";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import PDFDocument from "pdfkit";

const contextDir = './auth-session';

let cookieAccepted = false;

const config = {
  devBase: "https://dev.recordati-plus.de",
  prodBase: "https://recordati-plus.de",
  excelFile: "urls.xlsx",
  screenshotDir: "screenshots",
  reportPath: "reports/result.pdf"
};

async function readUrlsFromExcel(filePath) {
  try {
    if (!fs.existsSync(filePath)) throw new Error(`Excel file not found: ${filePath}`);
    const workbook = XLSX.readFile(filePath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(sheet);

    if (!data.length) throw new Error('Excel file is empty');
    const firstColumnName = Object.keys(data[0])[0];
    console.log('Using column:', firstColumnName);

    const urls = data
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

    if (!urls.length) throw new Error('No valid URLs found');
    console.log('Extracted paths:', urls);
    return urls;
  } catch (error) {
    console.error('Error reading Excel file:', error.message);
    return [];
  }
}

async function ensureLoggedIn(page) {
  console.log("🔐 Checking login status...");
  await page.goto(`${config.devBase}/de_DE/overview-page`, { waitUntil: "domcontentloaded" });

  if (page.url().includes("sso.omnizia.com")) {
    console.log("🔑 Login required. Please complete login in the opened browser...");
    await page.waitForURL(url => url.toString().startsWith(config.devBase), { timeout: 120000 });
    console.log("✅ Login successful.");
  } else {
    console.log("✅ Already logged in.");
  }
}

async function captureScreenshot(page, url, outputPath) {
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
    await page.waitForLoadState("domcontentloaded");

    // ✅ Handle German Cookie Banner (CookieYes)
    if (!cookieAccepted) {
      try {
        const cookieButton = await page.locator('button.cky-btn-accept[aria-label="Alle akzeptieren"]');
        if (await cookieButton.isVisible()) {
          await cookieButton.click();
          console.log('🍪 Cookie consent accepted');
          await page.waitForTimeout(500); // Give time to hide banner
        } else {
          console.log('🍪 Cookie consent not visible — skipping');
        }
      } catch (err) {
        console.warn('⚠️ Skipped cookie consent click:', err.message);
      }
    }

    await page.waitForTimeout(2000);
    await page.screenshot({ path: outputPath, fullPage: true });
    console.log(`✅ Screenshot captured: ${outputPath}`);
  } catch (error) {
    console.error(`❌ Error capturing screenshot for ${url}:`, error.message);
    throw error;
  }
}


function compareScreenshots(img1Path, img2Path, diffPath) {
  try {
    const img1 = PNG.sync.read(fs.readFileSync(img1Path));
    const img2 = PNG.sync.read(fs.readFileSync(img2Path));
    const compareWidth = Math.min(img1.width, img2.width);
    const compareHeight = Math.min(img1.height, img2.height);
    const diff = new PNG({ width: compareWidth, height: compareHeight });
    const diffPixels = pixelmatch(img1.data, img2.data, diff.data, compareWidth, compareHeight, { threshold: 0.1 });

    fs.writeFileSync(diffPath, PNG.sync.write(diff));
    return diffPixels;
  } catch (error) {
    console.error('Error comparing screenshots:', error.message);
    throw error;
  }
}

async function generatePDFReport(results) {
  try {
    const doc = new PDFDocument({ autoFirstPage: false });
    const writeStream = fs.createWriteStream(config.reportPath);
    doc.pipe(writeStream);

    doc.addPage();
    doc.fontSize(24).text('Visual Comparison Report', { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text(`Generated: ${new Date().toLocaleString()}`, { align: 'center' });

    for (const result of results) {
      doc.addPage();
      doc.fontSize(16).text(`URL: ${result.url}`, { underline: true });
      doc.moveDown();

      const imgWidth = 180;
      const margin = 30;
      const startX = 50;
      let y = doc.y;

      // DEV and PROD side by side in one row
      if (fs.existsSync(result.devPath)) {
        doc.image(result.devPath, startX, y, { width: imgWidth });
        doc.fontSize(10).text('DEV', startX, y + imgWidth + 5, { width: imgWidth, align: 'center' });
      }
      if (fs.existsSync(result.prodPath)) {
        doc.image(result.prodPath, startX + imgWidth + margin, y, { width: imgWidth });
        doc.fontSize(10).text('PROD', startX + imgWidth + margin, y + imgWidth + 5, { width: imgWidth, align: 'center' });
      }

      // Move below the first row for DIFF image
      y = y + imgWidth + 40;
      if (fs.existsSync(result.diffPath)) {
        doc.image(result.diffPath, startX, y, { width: imgWidth * 2 + margin });
        doc.fontSize(10).text('DIFF', startX, y + imgWidth + 5, { width: imgWidth * 2 + margin, align: 'center' });
      }

      doc.moveDown(18);
      doc.fontSize(14).text(
        `Match: ${result.match ? '✅ No visual difference' : `❌ ${result.diffPixels} pixels differ`}`,
        { align: 'left' }
      );

      if (!result.match) {
        doc.moveDown();
        doc.fontSize(12).fillColor('red').text(
          'Differences highlighted in the DIFF image above. Red/pink areas show where the screenshots differ.',
          { align: 'left' }
        );
        doc.fillColor('black');
      }
    }

    doc.end();
    await new Promise(resolve => writeStream.on('finish', resolve));
    console.log(`📄 PDF report generated: ${config.reportPath}`);
  } catch (error) {
    console.error('Error generating PDF:', error.message);
  }
}

async function main() {
  try {
    ['dev', 'prod', 'diff'].forEach(dir =>
        fs.ensureDirSync(`${config.screenshotDir}/${dir}`)
    );
    fs.ensureDirSync('reports');

    const urls = await readUrlsFromExcel(config.excelFile);
    if (!urls.length) return console.log('No URLs to process. Exiting.');

    const browser = await chromium.launchPersistentContext(contextDir, {
      headless: false  // 🚨 Visible browser to support login
    });

    const page = await browser.newPage();
    await ensureLoggedIn(page); // 🔑 Login check happens here

    const results = [];

    for (const urlPath of urls) {
      console.log(`\n🔍 Processing: ${urlPath}`);
      const cleanName = urlPath.replace(/\W+/g, '_');
      const paths = {
        dev: `${config.screenshotDir}/dev/${cleanName}.png`,
        prod: `${config.screenshotDir}/prod/${cleanName}.png`,
        diff: `${config.screenshotDir}/diff/${cleanName}_diff.png`
      };

      try {
        await captureScreenshot(page, `${config.devBase}${urlPath}`, paths.dev);
        await captureScreenshot(page, `${config.prodBase}${urlPath}`, paths.prod);
        const diffPixels = compareScreenshots(paths.dev, paths.prod, paths.diff);

        results.push({
          url: urlPath,
          match: diffPixels === 0,
          diffPixels,
          devPath: paths.dev,
          prodPath: paths.prod,
          diffPath: paths.diff
        });
      } catch (error) {
        console.error(`❌ Failed to process ${urlPath}`);
      }
    }

    await browser.close();
    await generatePDFReport(results);
  } catch (error) {
    console.error('❌ Process failed:', error.message);
    process.exit(1);
  }
}

main();
