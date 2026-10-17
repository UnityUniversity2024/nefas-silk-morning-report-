const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');

const FILE_NAME = 'index.html';

// --- 1. API FETCHERS (Fast & Reliable) ---

async function fetchArabicaPrice() {
    console.log('Fetching Arabica (KC=F) via API...');
    try {
        const response = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/KC=F');
        const data = await response.json();
        const price = data.chart.result[0].meta.regularMarketPrice;
        return price ? '$' + (parseFloat(price) / 100).toFixed(2) + ' / lb' : null;
    } catch (e) {
        console.log('Warning: Could not fetch Arabica API', e.message);
        return null;
    }
}

async function fetchUsdEtbRate() {
    console.log('Fetching USD/ETB rate (CBE with Open Exchange fallback)...');
    try {
        const dateStr = new Date().toISOString().slice(0, 10);
        const response = await fetch(`https://combanketh.et/cbeapi/daily-exchange-rates/?_limit=1&Date=${dateStr}`);
        if (response.ok) {
            const data = await response.json();
            const rates = data?.[0]?.ExchangeRate || [];
            const usdData = rates.find(r => r.currency?.CurrencyCode === 'USD');
            if (usdData && usdData.transactionalSelling) {
                return `${usdData.transactionalSelling} ETB`;
            }
        }
    } catch (e) {
        console.log('Primary CBE API unavailable, switching to global fallback...');
    }

    try {
        const response = await fetch('https://open.er-api.com/v6/latest/USD');
        const data = await response.json();
        const rate = data.rates && data.rates.ETB;
        return rate ? `${rate.toFixed(4)} ETB` : null;
    } catch (e) {
        console.log('Warning: Could not fetch fallback USD/ETB rate', e.message);
        return null;
    }
}

// --- 2. WEB SCRAPERS (Stealth Engine) ---

async function scrapeRobustaPrice(browser) {
    console.log('Scraping Robusta from Investing.com...');
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    try {
        await page.goto('https://www.investing.com/commodities/london-coffee', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await new Promise(r => setTimeout(r, 4000));
        const price = await page.evaluate(() => {
            const el = document.querySelector('[data-test="instrument-price-last"]');
            return el ? el.innerText.trim() : null;
        });
        await page.close();
        return price ? '$' + price.replace(/,/g, '') + ' / MT' : null;
    } catch (e) {
        console.log('Warning: Could not scrape Robusta', e.message);
        await page.close();
        return null;
    }
}

async function scrapeRubberPrice(browser) {
    console.log('Scraping Rubber from Investing.com...');
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    try {
        // Extended wait to ensure Investing.com elements load properly
        await page.goto('https://www.investing.com/commodities/rubber', { waitUntil: 'domcontentloaded', timeout: 45000 });
        await new Promise(r => setTimeout(r, 8000));
        const price = await page.evaluate(() => {
            const el = document.querySelector('[data-test="instrument-price-last"]');
            return el ? el.innerText.trim() : null;
        });
        await page.close();
        return price ? `$${price} / kg` : null;
    } catch (e) {
        console.log('Warning: Could not scrape Rubber', e.message);
        await page.close();
        return null;
    }
}

async function scrapeSesamePrice(browser) {
    console.log('Scraping Sesame from Tridge...');
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    try {
        // Switched to networkidle2 and 10s timeout to bypass heavy JS rendering
        await page.goto('https://dir.tridge.com/prices/sesame-seed/CN', { waitUntil: 'networkidle2', timeout: 60000 });
        await new Promise(r => setTimeout(r, 10000));
        const price = await page.evaluate(() => {
            const el = document.querySelector('.price-value') || 
                       document.querySelector('span[class*="current-price"]') ||
                       document.querySelector('div[class*="Price__value"]');
            return el ? el.innerText.trim() : null;
        });
        await page.close();
        return price ? `${price} / kg` : null;
    } catch (e) {
        console.log('Warning: Could not scrape Sesame', e.message);
        await page.close();
        return null;
    }
}

// --- 3. MAIN WORKFLOW EXECUTION ---

async function generateAndPublishDashboard() {
    let browser;
    try {
        const [arabicaLivePrice, usdEtbRate] = await Promise.all([
            fetchArabicaPrice(),
            fetchUsdEtbRate()
        ]);

        browser = await puppeteer.launch({ 
            headless: 'new', 
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'] 
        });

        const [robustaLivePrice, rubberLivePrice, sesameLivePrice] = await Promise.all([
            scrapeRobustaPrice(browser),
            scrapeRubberPrice(browser),
            scrapeSesamePrice(browser)
        ]);

        const page = await browser.newPage();
        const filePath = 'file://' + path.join(__dirname, FILE_NAME);
        await page.goto(filePath, { waitUntil: 'networkidle0' });

        const dateStr = new Date().toLocaleString('en-US', { timeZone: 'Africa/Addis_Ababa' });

        await page.evaluate((arabica, robusta, rubber, etb, sesame, dateStr) => {
            if (arabica) document.getElementById('arabica-price').innerText = arabica;
            if (robusta) document.getElementById('robusta-price').innerText = robusta;
            if (rubber)  document.getElementById('rubber-price').innerText = rubber;
            if (etb)     document.getElementById('usd-etb-rate').innerText = etb;
            if (sesame)  document.getElementById('sesame-price').innerText = sesame;
            
            document.getElementById('report-date').innerText = "Last Updated: " + dateStr;
        }, arabicaLivePrice, robustaLivePrice, rubberLivePrice, usdEtbRate, sesameLivePrice, dateStr);

        const updatedHTML = await page.content();
        fs.writeFileSync(path.join(__dirname, FILE_NAME), updatedHTML);
        console.log('Updated index.html written to disk.');
        await browser.close();

        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { 
                user: process.env.EMAIL_USER, 
                pass: process.env.EMAIL_PASS 
            }
        });

        const githubRepo = process.env.GITHUB_REPOSITORY;
        const websiteUrl = githubRepo 
            ? `https://${githubRepo.split('/')[0]}.github.io/${githubRepo.split('/')[1]}/` 
            : 'Dashboard Link';

        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: process.env.BOSS_EMAIL,
            subject: `ET Nefas Silk Morning Brief - ${dateStr}`,
            text: `Good morning,\n\nThe intelligence dashboard has been successfully updated with live global prices.\n\n` +
                  `📊 Markets Summary:\n` +
                  `• NY Arabica: ${arabicaLivePrice || 'N/A'}\n` +
                  `• London Robusta: ${robustaLivePrice || 'N/A'}\n` +
                  `• Sesame (Global): ${sesameLivePrice || 'N/A'}\n` +
                  `• Natural Rubber: ${rubberLivePrice || 'N/A'}\n` +
                  `• USD / ETB Rate: ${usdEtbRate || 'N/A'}\n\n` +
                  `🌐 View the Live Dashboard:\n${websiteUrl}\n\n` +
                  `Automated by Nefas Silk Intelligence Desk.`
        };

        await transporter.sendMail(mailOptions);
        console.log('Morning brief email dispatched successfully.');

    } catch (error) {
        console.error('Fatal error during automation run:', error);
    } finally {
        if (browser) await browser.close();
    }
}

generateAndPublishDashboard();
