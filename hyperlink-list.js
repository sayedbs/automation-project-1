import { chromium } from 'playwright';

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

        // Filter out external links and normalize internal links
        const baseUrl = new URL(url);
        const internalLinks = links
            .filter(link => {
                try {
                    const linkUrl = new URL(link);
                    return linkUrl.hostname === baseUrl.hostname;
                } catch {
                    return false;
                }
            })
            .map(link => {
                try {
                    const linkUrl = new URL(link);
                    return linkUrl.pathname + linkUrl.search + linkUrl.hash;
                } catch {
                    return link;
                }
            });

        return [...new Set(internalLinks)]; // Remove duplicates
    } catch (error) {
        console.error(`Error processing ${url}:`, error.message);
        return [];
    } finally {
        await browser.close();
    }
}

async function processUrls(urls) {
    for (const url of urls) {
        console.log(`\nURL: ${url}`);
        const links = await extractLinks(url);
        console.log('Internal links:');
        links.forEach(link => console.log(link));
    }
}

// Example usage
const urls = [
    'https://recordati-plus.de/de_DE/recordati-article/37',
    'https://recordati-plus.de/de_DE/recordati-article/schizophrenie-in-schule-und-beruf'
];

processUrls(urls).catch(console.error);
