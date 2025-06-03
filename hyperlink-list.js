import { chromium } from 'playwright';
import xlsx from 'xlsx';
import fs from 'fs-extra';
import path from 'path';
import readline from 'readline';

// Create readline interface for user input
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// Promise wrapper for readline question
function question(query) {
    return new Promise((resolve) => {
        rl.question(query, resolve);
    });
}

// Function to chunk array into smaller arrays
function chunkArray(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
    }
    return chunks;
}

class TabPool {
    constructor(browser, size) {
        this.browser = browser;
        this.size = size;
        this.tabs = [];
        this.isInitialized = false;
    }

    async initialize() {
        if (this.isInitialized) return;
        
        // Create a single context for all tabs
        this.context = await this.browser.newContext();
        
        // Create initial tabs in the same context
        for (let i = 0; i < this.size; i++) {
            const page = await this.context.newPage();
            this.tabs.push({ page, busy: false });
        }
        this.isInitialized = true;
    }

    async getTab() {
        await this.initialize();
        
        // Wait for a free tab
        while (true) {
            const tab = this.tabs.find(t => !t.busy);
            if (tab) {
                tab.busy = true;
                return tab;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }

    releaseTab(tab) {
        const tabIndex = this.tabs.findIndex(t => t.page === tab.page);
        if (tabIndex !== -1) {
            this.tabs[tabIndex].busy = false;
        }
    }

    async close() {
        if (this.context) {
            await this.context.close();
        }
    }
}

async function handleLogin(page) {
    console.log('\n⚠️ Login required! Please follow these steps:');
    console.log('1. A browser window will open');
    console.log('2. Please login to your account');
    console.log('3. After login, you will be redirected to the target page');
    console.log('4. Once you have logged in successfully, press Enter in this console');
    
    // Wait for user to press Enter after login
    await question('Press Enter after you have logged in successfully...');
    
    // Wait a bit more to ensure the page is fully loaded after login
    await page.waitForTimeout(2000);
    
    console.log('Login successful! Continuing with link extraction...');
}

async function ensureLogin(tabPool) {
    const tab = await tabPool.getTab();
    try {
        await tab.page.goto('https://recordati-plus.de/de_DE/account/signin', { waitUntil: 'networkidle' });
        
        // Check if we need to login
        if (tab.page.url().includes('/account/signin')) {
            await handleLogin(tab.page);
        }
    } finally {
        tabPool.releaseTab(tab);
    }
}

async function extractLinks(tabPool, url, index) {
    const tab = await tabPool.getTab();
    try {
        await tab.page.goto(url, { waitUntil: 'networkidle' });

        // Remove header and footer elements
        await tab.page.evaluate(() => {
            const header = document.querySelector('.layout > .header');
            const footer = document.querySelector('footer');
            if (header) header.remove();
            if (footer) footer.remove();
        });

        // Extract all links from the remaining content
        const links = await tab.page.evaluate(() => {
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
            index,
            url,
            internalLinks: [...new Set(internalLinks)],
            externalLinks: [...new Set(externalLinks)]
        };
    } catch (error) {
        console.error(`Error processing ${url}:`, error.message);
        return { index, url, internalLinks: [], externalLinks: [] };
    } finally {
        tabPool.releaseTab(tab);
    }
}

async function processUrls(urls) {
    const results = [];
    const browser = await chromium.launch({ 
        headless: false,
        args: ['--start-maximized']
    });
    const tabPool = new TabPool(browser, 5);
    
    try {
        // Handle login once at the beginning
        await ensureLogin(tabPool);
        
        // Process URLs with a fixed pool of tabs
        const promises = urls.map((url, index) => {
            console.log(`\n${index + 1} - Processing URL: ${url}`);
            return extractLinks(tabPool, url, index);
        });

        // Process all URLs and collect results
        const batchResults = await Promise.all(promises);
        
        for (const result of batchResults) {
            const summary = `Internal Links: ${result.internalLinks.length}, External Links: ${result.externalLinks.length}`;
            console.log(`URL ${result.index + 1} - ${summary}`);
            
            results.push({
                sourceUrl: result.url,
                summary: summary,
                internalLinks: result.internalLinks.join('\n'),
                externalLinks: result.externalLinks.join('\n')
            });
        }
    } finally {
        await tabPool.close();
        await browser.close();
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
        const urls = [];
        if (data.length > 0) {
            // Get the first column name (which contains the URL)
            const firstColumn = Object.keys(data[0])[0];
            // Extract URLs from each row
            urls.push(...data.map(row => row[firstColumn]).filter(url => url));
        }
        
        if (urls.length === 0) {
            console.error('No URLs found in the input Excel file');
            return;
        }

        console.log(`Found ${urls.length} URLs to process`);

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
    } finally {
        rl.close();
    }
}

main().catch(console.error);
