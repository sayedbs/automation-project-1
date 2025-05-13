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

// Get the content height for a given URL
async function getPageHeight(page, url) {
    await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
    await page.waitForLoadState("domcontentloaded");
    // Accept cookie if needed
    if (!global.cookieAccepted) {
        try {
            const cookieButton = page.locator('button.cky-btn-accept[aria-label="Alle akzeptieren"]').first();
            if (await cookieButton.isVisible({ timeout: 3000 })) {
                await cookieButton.click();
                global.cookieAccepted = true;
                await page.waitForTimeout(500);
            }
        } catch {}
    }
    const height = await page.evaluate(() => {
        const el = document.querySelector('.app_container > .layout > .content');
        return el ? el.offsetHeight + 80 : document.body.scrollHeight;
    });
    return height;
}

async function captureScreenshot(page, url, outputPath, height) {
    await page.setViewportSize({ width: 1600, height });
    await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(500);
    await page.screenshot({ path: outputPath, fullPage: false });
    console.log(`✅ Screenshot captured: ${outputPath}`);
}

async function generatePDFReport(results) {
    try {
        const doc = new PDFDocument({ autoFirstPage: false });
        const writeStream = fs.createWriteStream(config.reportPath);
        doc.pipe(writeStream);

        // Cover page
        doc.addPage();
        doc.fontSize(24).text('Visual Comparison Report', { align: 'center' });
        doc.moveDown();
        doc.fontSize(12).text(`Generated: ${new Date().toLocaleString()}`, { align: 'center' });

        for (const result of results) {
            doc.addPage();
            doc.fontSize(16).text(`URL: ${result.url}`, { underline: true });
            doc.moveDown();

            const imgWidth = 180;
            const imgGap = 30;
            const pageWidth = doc.page.width;
            const totalWidth = imgWidth * 3 + imgGap * 2;
            const startX = (pageWidth - totalWidth) / 2;
            const y = doc.y;

            // Helper to draw image and label at specific x
            function drawImageWithLabel(imgPath, label, x) {
                if (fs.existsSync(imgPath)) {
                    const { height, width } = PNG.sync.read(fs.readFileSync(imgPath));
                    const scale = imgWidth / width;
                    const imgHeight = height * scale;

                    doc.image(imgPath, x, y, { width: imgWidth });
                    doc.fontSize(10).text(label, x, y + imgHeight + 5, { width: imgWidth, align: 'center' });
                    return imgHeight;
                }
                return 0;
            }

            // Draw images side by side
            const devHeight = drawImageWithLabel(result.devPath, 'DEV', startX);
            const prodHeight = drawImageWithLabel(result.prodPath, 'PROD', startX + imgWidth + imgGap);
            const diffHeight = drawImageWithLabel(result.diffPath, 'DIFF', startX + (imgWidth + imgGap) * 2);

            // Find the max image height to position the description below all images/labels
            const maxImgHeight = Math.max(devHeight, prodHeight, diffHeight);
            let descY = y + maxImgHeight + 30;

            doc.x = doc.page.margins.left;
            doc.y = descY;

            doc.moveDown();
            doc.fontSize(14).text(
                `Match: ${result.match ? '✅ No visual difference' : `❌ ${result.diffPixels} pixels differ`}`,
                { align: 'left', width: pageWidth - doc.page.margins.left - doc.page.margins.right }
            );

            if (!result.match) {
                doc.moveDown();
                doc.fontSize(12).fillColor('red').text(
                    'Differences highlighted in the DIFF image above. Red/pink areas show where the screenshots differ.',
                    { align: 'left', width: pageWidth - doc.page.margins.left - doc.page.margins.right }
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

function compareScreenshots(img1Path, img2Path, diffPath) {
  const img1 = PNG.sync.read(fs.readFileSync(img1Path));
  const img2 = PNG.sync.read(fs.readFileSync(img2Path));
  const { width, height } = img1;

  const diff = new PNG({ width, height });
  const numDiffPixels = pixelmatch(img1.data, img2.data, diff.data, width, height, {
    threshold: 0.1,
  });

  fs.writeFileSync(diffPath, PNG.sync.write(diff));
  return numDiffPixels;
}

async function main() {
    try {
        // Clean output directories before generating new results
        ['dev', 'prod', 'diff'].forEach(dir => {
            fs.emptyDirSync(`${config.screenshotDir}/${dir}`);
        });
        fs.emptyDirSync('reports');

        ['dev', 'prod', 'diff'].forEach(dir =>
            fs.ensureDirSync(`${config.screenshotDir}/${dir}`)
        );
        fs.ensureDirSync('reports');

        const urls = await readUrlsFromExcel(config.excelFile);
        if (!urls.length) {
            console.log('No URLs to process. Exiting.');
            return;
        }

        const browser = await chromium.launchPersistentContext(contextDir, {
            headless: false, // Visible browser to support login
            args: ['--disable-blink-features=AutomationControlled'],
            viewport: null
        });

        const page = await browser.newPage();
        await ensureLoggedIn(page); // 🔐 Login if required

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
                // Get heights for both pages
                const devHeight = await getPageHeight(page, `${config.devBase}${urlPath}`);
                const prodHeight = await getPageHeight(page, `${config.prodBase}${urlPath}`);
                const maxHeight = Math.max(devHeight, prodHeight);

                // Take screenshots with the same height
                await captureScreenshot(page, `${config.devBase}${urlPath}`, paths.dev, maxHeight);
                await captureScreenshot(page, `${config.prodBase}${urlPath}`, paths.prod, maxHeight);

                if (!fs.existsSync(paths.dev) || !fs.existsSync(paths.prod)) {
                    throw new Error("One or both screenshot files are missing");
                }

                let diffPixels;
                try {
                    diffPixels = compareScreenshots(paths.dev, paths.prod, paths.diff);
                } catch (compareError) {
                    console.error(`🛑 Screenshot comparison failed for ${urlPath}:`, compareError.message);
                    continue;
                }

                results.push({
                    url: urlPath,
                    match: diffPixels === 0,
                    diffPixels,
                    devPath: paths.dev,
                    prodPath: paths.prod,
                    diffPath: paths.diff
                });
            } catch (error) {
                console.error(`❌ Failed to process ${urlPath}:`, error.message);
                console.error(error);
            }
        }

        await browser.close();
        await generatePDFReport(results);
    } catch (error) {
        console.error('❌ Process failed:', error.message);
        console.error(error); // Full stack trace for critical error
        process.exit(1);
    }
}

main();
