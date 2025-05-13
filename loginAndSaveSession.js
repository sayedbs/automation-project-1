// loginAndSaveSession.js
import { chromium } from 'playwright';

const contextDir = './auth-session'; // Directory where session is saved

(async () => {
    const browser = await chromium.launchPersistentContext(contextDir, {
        headless: false // so you can log in manually
    });

    const page = await browser.newPage();
    await page.goto('https://dev.recordati-plus.de/de_DE/overview-page');

    console.log("Please log in manually...");
})();
