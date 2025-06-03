import { chromium } from 'playwright';
import xlsx from 'xlsx';
import fs from 'fs-extra';
import path from 'path';

async function extractLinks(url) {
    const browser = await chromium.launch();
    
    try {
        const page = await browser.newPage();
        await page.goto(url, { waitUntil: 'networkidle' });

        // Remove header and footer elements
        await page.evaluate(() => {
            const header = document.querySelector('.layout > .header');
            const footer = document.querySelector('footer');
            if (header) header.remove();
            if (footer) footer.remove();
        });

        // Extract all links from the remaining content
        const links = await page.evaluate(() => {
            const anchors = Array.from(document.querySelectorAll('a[href]'));
            return anchors.map(a => a.href);
        });

        // Filter and categorize links
        const baseUrl = new URL(url);
        const internalLinks = [];
        const externalLinks = [];

        links.forEach(link => {
            try {
                const linkUrl = new URL(link);
                if (linkUrl.hostname === baseUrl.hostname) {
                    internalLinks.push(linkUrl.pathname + linkUrl.search + linkUrl.hash);
                } else {
                    externalLinks.push(link);
                }
            } catch {
                // Skip invalid URLs
            }
        });

        return {
            internalLinks: [...new Set(internalLinks)],
            externalLinks: [...new Set(externalLinks)]
        };
    } catch (error) {
        console.error(`Error processing ${url}:`, error.message);
        return { internalLinks: [], externalLinks: [] };
    } finally {
        await browser.close();
    }
}

async function processUrls(urls) {
    const results = [];

    let count = 0;
    
    for (const url of urls) {
        count++;

        console.log(`\n${count} - Processing URL: ${url}`);
        const { internalLinks, externalLinks } = await extractLinks(url);
        
        // Create summary text
        const summary = `Internal Links: ${internalLinks.length}, External Links: ${externalLinks.length}`;
        
        results.push({
            sourceUrl: url,
            summary: summary,
            internalLinks: internalLinks.join('\n'),
            externalLinks: externalLinks.join('\n')
        });
        
        console.log(summary);
    }
    
    return results;
}

async function main() {
    try {
        // Read input Excel file
        const inputFile = 'input_urls.xlsx';
        const workbook = xlsx.readFile(inputFile);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const data = xlsx.utils.sheet_to_json(worksheet);
        
        // Extract URLs from the Excel file
        const urls = data.map(row => row.url).filter(url => url);
        
        if (urls.length === 0) {
            console.error('No URLs found in the input Excel file');
            return;
        }

        // Process URLs
        const results = await processUrls(urls);
        
        // Create output directory if it doesn't exist
        const outputDir = 'list_url';
        await fs.ensureDir(outputDir);
        
        // Create output Excel file
        const outputWorkbook = xlsx.utils.book_new();
        const outputWorksheet = xlsx.utils.json_to_sheet(results);
        
        // Set column widths
        const wscols = [
            {wch: 50},  // sourceUrl
            {wch: 30},  // summary
            {wch: 50},  // internalLinks
            {wch: 50}   // externalLinks
        ];
        outputWorksheet['!cols'] = wscols;
        
        xlsx.utils.book_append_sheet(outputWorkbook, outputWorksheet, 'Results');
        
        // Save output file
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const outputFile = path.join(outputDir, `link_results_${timestamp}.xlsx`);
        xlsx.writeFile(outputWorkbook, outputFile);
        
        console.log(`\nResults saved to: ${outputFile}`);
    } catch (error) {
        console.error('Error:', error.message);
    }
}

main().catch(console.error);
