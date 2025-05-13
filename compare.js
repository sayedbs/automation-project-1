import fs from "fs-extra";
import XLSX from "xlsx";
import { chromium } from "playwright";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import PDFDocument from "pdfkit";

const devBase = "https://dev.recordati-plus.de";
const prodBase = "https://recordati-plus.de";

const excelFile = "urls.xlsx";
const screenshotDir = "screenshots";
const reportPath = "reports/result.pdf";

// Read URLs from the Excel file
async function readUrlsFromExcel(filePath) {
  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(sheet);

  return data
    .map(row => row.URL && typeof row.URL === "string" ? row.URL.trim() : null)
    .filter(url => url); // Remove null/empty rows
}

// Capture screenshot of the page
async function captureScreenshot(page, fullUrl, outputPath) {
  console.log(`Capturing screenshot for: ${fullUrl}`);
  try {
    await page.goto(fullUrl, { waitUntil: "load", timeout: 60000 });
    console.log(`Page loaded: ${fullUrl}`);

    await page.waitForLoadState("load");
    await page.screenshot({ path: outputPath, fullPage: true });
    console.log(`Screenshot saved to: ${outputPath}`);
  } catch (error) {
    console.error(`Error capturing screenshot for: ${fullUrl}`, error);
  }
}

// Compare screenshots and return the number of different pixels
function compareScreenshots(img1Path, img2Path, diffPath) {
  try {
    const img1 = PNG.sync.read(fs.readFileSync(img1Path));
    const img2 = PNG.sync.read(fs.readFileSync(img2Path));

    const width = Math.min(img1.width, img2.width);
    const height = Math.min(img1.height, img2.height);

    const diff = new PNG({ width, height });
    const numDiffPixels = pixelmatch(
      img1.data,
      img2.data,
      diff.data,
      width,
      height,
      { threshold: 0.1 }
    );

    fs.writeFileSync(diffPath, PNG.sync.write(diff));
    console.log(`Diff image saved to: ${diffPath}`);
    return numDiffPixels;
  } catch (error) {
    console.error("Error comparing screenshots:", error);
    return -1; // Return -1 on failure
  }
}

// Generate PDF report with results
async function generatePDFReport(results) {
  const doc = new PDFDocument({ autoFirstPage: false });
  const writeStream = fs.createWriteStream(reportPath);
  doc.pipe(writeStream);

  doc.addPage();
  doc.fontSize(20).text("Visual Comparison Report", { align: "center" });
  doc.moveDown();

  for (const result of results) {
    doc.addPage();
    doc.fontSize(14).text(`URL: ${result.url}`, { underline: true });
    doc.text(`Match: ${result.match ? "✅ Yes" : "❌ No"} (${result.diffPixels} pixels different)`);
    doc.moveDown();

    // Ensure the screenshot files exist before adding them to the PDF
    if (fs.existsSync(result.devPath)) {
      doc.text("DEV:");
      doc.image(result.devPath, { width: 300 });
      doc.moveDown();
    } else {
      console.warn(`⚠️ DEV screenshot missing for: ${result.url}`);
    }

    if (fs.existsSync(result.prodPath)) {
      doc.text("PROD:");
      doc.image(result.prodPath, { width: 300 });
      doc.moveDown();
    } else {
      console.warn(`⚠️ PROD screenshot missing for: ${result.url}`);
    }

    if (!result.match && fs.existsSync(result.diffPath)) {
      doc.text("DIFF:");
      doc.image(result.diffPath, { width: 300 });
      doc.moveDown();
    }

    doc.moveDown(2);
  }

  doc.end();
  await new Promise(resolve => writeStream.on("finish", resolve));
  console.log("📄 PDF report generated:", reportPath);
}

(async () => {
  // Ensure necessary directories exist
  fs.ensureDirSync("screenshots/dev");
  fs.ensureDirSync("screenshots/prod");
  fs.ensureDirSync("screenshots/diff");
  fs.ensureDirSync("reports");

  // Read URLs from Excel
  const urls = await readUrlsFromExcel(excelFile);
  console.log("URLs read from Excel:", urls);

  // Launch browser
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const results = [];

  // Loop through each URL
  for (const urlPath of urls) {
    const cleanName = urlPath.replace(/\W+/g, "_");
    const devPath = `screenshots/dev/${cleanName}.png`;
    const prodPath = `screenshots/prod/${cleanName}.png`;
    const diffPath = `screenshots/diff/${cleanName}_diff.png`;

    console.log(`🔍 Comparing: ${urlPath}`);

    // Capture screenshots
    await captureScreenshot(page, `${devBase}${urlPath}`, devPath);
    await captureScreenshot(page, `${prodBase}${urlPath}`, prodPath);

    // If either screenshot is missing, skip this URL
    if (!fs.existsSync(devPath) || !fs.existsSync(prodPath)) {
      console.warn(`⚠️ Missing screenshot(s) for ${urlPath}`);
      continue;
    }

    // Compare the screenshots
    const diffPixels = compareScreenshots(devPath, prodPath, diffPath);
    const match = diffPixels === 0;

    // Store the result
    results.push({ url: urlPath, match, diffPixels, devPath, prodPath, diffPath });
  }

  // Close the browser
  await browser.close();

  // Generate the PDF report
  await generatePDFReport(results);
})();
