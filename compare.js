import fs from "fs-extra";
import XLSX from "xlsx";
import { chromium } from "playwright";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import PDFDocument from "pdfkit";

const config = {
  devBase: "https://dev.recordati-plus.de",
  prodBase: "https://recordati-plus.de",
  excelFile: "urls.xlsx",
  screenshotDir: "screenshots",
  reportPath: "reports/result.pdf"
};

async function readUrlsFromExcel(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Excel file not found: ${filePath}`);
    }

    const workbook = XLSX.readFile(filePath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(sheet);

    if (data.length === 0) {
      throw new Error('Excel file is empty');
    }

    // Get the first column name regardless of what it's called
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

    console.log('Extracted paths:', urls);

    if (urls.length === 0) {
      throw new Error('No valid URLs found');
    }

    return urls;
  } catch (error) {
    console.error('Error reading Excel file:', error.message);
    return [];
  }
}

async function captureScreenshot(page, url, outputPath) {
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
    await page.waitForLoadState("domcontentloaded");
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
      doc.fontSize(14).text(`Match: ${result.match ? '✅' : '❌'} (${result.diffPixels} pixels different)`);
      doc.moveDown();

      const imageOptions = { width: 300 };
      if (fs.existsSync(result.devPath)) doc.image(result.devPath, imageOptions);
      if (fs.existsSync(result.prodPath)) doc.image(result.prodPath, imageOptions);
      if (!result.match && fs.existsSync(result.diffPath)) doc.image(result.diffPath, imageOptions);
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
    console.log(`📋 Found ${urls.length} URLs to process`);

    if (!urls.length) {
      console.log('No URLs to process. Exiting.');
      return;
    }

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
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