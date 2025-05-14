import fs from "fs-extra";
import XLSX from "xlsx";
import { chromium } from "playwright";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import PDFDocument from "pdfkit";
import {process} from "pngjs/lib/filter-parse-sync.js";

const contextDir = './auth-session';

let cookieAccepted = false;

const config = {
  devBase: "https://dev.recordati-plus.de",
  prodBase: "https://stage.recordati-plus.de",
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

async function ensureLoggedInAndNavigate(page) {
    console.log("🔐  Checking DEV login status...");
    await page.goto(`${config.devBase}/de_DE/account/signin`, {waitUntil: "domcontentloaded"});

    if (page.url().includes("/account/signin")) {
        console.log("🔑 DEV Login required. Please complete login in the opened browser...");
        await page.waitForURL(url => url.toString().startsWith(config.devBase) && !url.toString().includes("/account/signin"), {timeout: 120000});
        console.log("✅ DEV Login successful.");
    } else {
        console.log("✅ DEV Already logged in.");
    }

    console.log("🔐  Checking PROD login status...");
    await page.goto(`${config.prodBase}/de_DE/account/signin`, {waitUntil: "domcontentloaded"});

    if (page.url().includes("/account/signin")) {
        console.log("🔑 PROD Login required. Please complete login in the opened browser...");
        await page.waitForURL(url => url.toString().startsWith(config.prodBase) && !url.toString().includes("/account/signin"), {timeout: 120000});
        console.log("✅ PROD Login successful.");
    } else {
        console.log("✅ PROD Already logged in.");
    }
}
async function captureScreenshot(page, url, outputPath) {
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
    await page.waitForLoadState("domcontentloaded");


    // Handle German Cookie Banner (CookieYes)
    if (!cookieAccepted) {
      try {
        const cookieButton = page.locator('button.cky-btn-accept[aria-label="Alle akzeptieren"]').first();
        if (await cookieButton.isVisible()) {
          await cookieButton.click();
          console.log('🍪 Cookie consent accepted');
          await page.waitForTimeout(500);
        } else {
          console.log('🍪 Cookie consent not visible — skipping');
        }
      } catch (err) {
        console.warn('⚠️ Skipped cookie consent click:', err.message);
      }
    }

    // Inject custom styles
    await page.addStyleTag({
      content: `
        .app_container.theme {
          position: static !important;
          height: auto !important;
        }
        .layout {
          position: relative !important;
          height: auto !important;
        }
        .theme .content {
          position: static !important;
          display: block !important;
        }
      `
    });

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(3000);
    await page.screenshot({ path: outputPath, fullPage: true });
    console.log(`✅ Screenshot captured: ${outputPath}`);
  } catch (error) {
    console.error(`❌ Error capturing screenshot for ${url}:`, error.message);
    throw error;
  }
}

async function generatePDFReport(results, summary) {
    try {
        const doc = new PDFDocument({
            autoFirstPage: false,
            margins: {
                top: 20,
                bottom: 20,
                left: 50,
                right: 50
            }
        });
        const writeStream = fs.createWriteStream(config.reportPath);
        doc.pipe(writeStream);

        // Cover page with Performance Summary
        doc.addPage();
        doc.fontSize(24).text('Visual Comparison Report', {align: 'center', baseline: 'top'});
        doc.moveDown(1.5);

        doc.fontSize(16).text(' 🚀 Performance Summary', {align: 'left'});
        doc.moveDown(0.5);

        doc.fontSize(12).text(`Total URLs processed: ${summary.totalUrls}`);
        doc.text(`Average task duration: ${summary.avgDuration.toFixed(2)}s`);
        doc.text(`Total execution time: ${summary.totalDuration.toFixed(2)}s`);
        doc.text(`Total time: ${(summary.totalDuration / 60).toFixed(2)} min / ${(summary.totalDuration / 3600).toFixed(2)} hr`);
        doc.moveDown(1);

        doc.fontSize(12).text(`Generated: ${new Date().toLocaleString()}`, {align: 'center'});

        // print images and compare results
        for (const result of results) {
            doc.addPage();
            doc.fontSize(16).text(`URL: ${result.url}`, {underline: true, baseline: 'top'});
            doc.moveDown();

            const imgWidth = 180;
            const imgGap = 30;
            const pageWidth = doc.page.width;
            const totalWidth = imgWidth * 3 + imgGap * 2;
            const startX = (pageWidth - totalWidth) / 2;
            const y = doc.y;
            const imageMaxheight= 580;

            // Helper to draw image and label at specific x
            function drawImageWithLabel(imgPath, label, x) {
                if (fs.existsSync(imgPath)) {
                    const {height, width} = PNG.sync.read(fs.readFileSync(imgPath));
                    let finalWidth = imgWidth;
                    let finalHeight = (height * imgWidth) / width;

                    if (finalHeight > imageMaxheight) {
                        finalHeight = imageMaxheight;
                        finalWidth = (width * finalHeight) / height;
                    }

                    doc.fontSize(10).text(label, x, y, {width: finalWidth, align: 'center'});
                    doc.image(imgPath, x, y + 15, {width: finalWidth});
                    return finalHeight;
                }
                return 0;
            }

            // Helper to calculate dimensions with height limit
            function calculateDimensions(imgPath) {
                if (fs.existsSync(imgPath)) {
                    const {height, width} = PNG.sync.read(fs.readFileSync(imgPath));
                    let finalWidth = imgWidth;
                    let finalHeight = (height * imgWidth) / width;

                    if (finalHeight > imageMaxheight) {
                        finalHeight = imageMaxheight;
                        finalWidth = (width * finalHeight) / height;
                    }
                    return {width: finalWidth, height: finalHeight};
                }
                return { width: 0, height: 0};
            }

            // Draw images side by side
            const devDims = calculateDimensions(result.devPath);
            const prodDims = calculateDimensions(result.prodPath);
            const diffDims = calculateDimensions(result.diffPath);

            const devHeight = devDims.height ? drawImageWithLabel(result.devPath, 'DEV', startX) : 0;
            const prodHeight = prodDims.height ? drawImageWithLabel(result.prodPath, 'PROD', startX + imgWidth + imgGap) : 0;
            const diffHeight = diffDims.height ? drawImageWithLabel(result.diffPath, 'DIFF', startX + (imgWidth + imgGap) * 2) : 0;

            // Find the max image height to position the description below all images/labels 
            const maxImgHeight = Math.max(devHeight, prodHeight, diffHeight);
            let descY = y + maxImgHeight + 45; // Increased to account for label above

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
    } catch (error) {
        console.error('Error generating PDF:', error.message);
    }
}

// Pad a PNG image to the target width/height with white background
function padImage(img, targetWidth, targetHeight) {
    if (img.width === targetWidth && img.height === targetHeight) return img;
    const padded = new PNG({ width: targetWidth, height: targetHeight, fill: true });
    // Fill with white
    padded.data.fill(255);
    // Copy original image data
    PNG.bitblt(img, padded, 0, 0, img.width, img.height, 0, 0);
    return padded;
}

function compareScreenshots(img1Path, img2Path, diffPath) {
    let img1 = PNG.sync.read(fs.readFileSync(img1Path));
    let img2 = PNG.sync.read(fs.readFileSync(img2Path));
    const width = Math.max(img1.width, img2.width);
    const height = Math.max(img1.height, img2.height);

    img1 = padImage(img1, width, height);
    img2 = padImage(img2, width, height);

    const diff = new PNG({ width, height });
    const numDiffPixels = pixelmatch(img1.data, img2.data, diff.data, width, height, { threshold: 0.1 });

    fs.writeFileSync(diffPath, PNG.sync.write(diff));
    return numDiffPixels;
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

        // Clean and prepare output directories
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
        await ensureLoggedInAndNavigate(page);
        await page.close(); // Close initial page after login check

        const concurrency = 5;

        const tasks = urls.map(urlPath => async () => {
            const taskStartTime = Date.now();
            const cleanName = urlPath.replace(/\W+/g, '_');
            const paths = {
                dev: `${config.screenshotDir}/dev/${cleanName}.png`,
                prod: `${config.screenshotDir}/prod/${cleanName}.png`,
                diff: `${config.screenshotDir}/diff/${cleanName}_diff.png`
            };

            for (let attempt = 1; attempt <= 3; attempt++) {
                const tab = await browser.newPage();
                try {
                    console.log(`\n🔍 Attempt ${attempt} - Processing: ${urlPath}`);

                    await captureScreenshot(tab, `${config.devBase}${urlPath}`, paths.dev);
                    await captureScreenshot(tab, `${config.prodBase}${urlPath}`, paths.prod);

                    const diffPixels = compareScreenshots(paths.dev, paths.prod, paths.diff);

                    await tab.close();
                    const taskDuration = (Date.now() - taskStartTime) / 1000;
                    console.log(`⏱️ Task completed in ${taskDuration.toFixed(2)}s`);

                    return {
                        url: urlPath,
                        match: diffPixels === 0,
                        diffPixels,
                        devPath: paths.dev,
                        prodPath: paths.prod,
                        diffPath: paths.diff,
                        duration: taskDuration
                    };
                } catch (error) {
                    await tab.close();
                    console.error(`❌ Attempt ${attempt} failed for ${urlPath}: ${error.message}`);
                    if (attempt === 3) {
                        console.error(`💥 All 3 attempts failed for ${urlPath}`);
                        return null;
                    } else {
                        console.log(`🔁 Retrying ${urlPath} (attempt ${attempt + 1}/3)...`);
                    }
                }
            }
        });

        const results = (await runWithConcurrencyLimit(tasks, concurrency)).filter(Boolean);

        await browser.close();


        const totalDuration = (Date.now() - startTime) / 1000;
        const avgDuration = results.reduce((sum, r) => sum + r.duration, 0) / results.length;

        console.log(`\n 📊 Performance Summary:`);
        console.log(`Total execution time: ${totalDuration.toFixed(2)}s`);
        console.log(`Average task duration: ${avgDuration.toFixed(2)}s`);
        console.log(`Tasks completed: ${results.length}`);

        await generatePDFReport(results, {
            totalUrls: results.length,
            avgDuration,
            totalDuration
        });

    } catch (error) {
        console.error('❌ Process failed:', error.message);
        process.exit(1);
    }
}

main();
