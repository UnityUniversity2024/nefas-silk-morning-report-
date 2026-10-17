const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');

const FILE_NAME = 'index.html';

// --- API FETCHERS (Fast) ---

async function fetchArabicaPrice() {
    console.log('Fetching Arabica (KC=F) via API...');
    try {
        const response = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/KC=F');
        const data = await response.json();
        return data.chart.result[0].meta.regularMarketPrice.toString();
    } catch (e) {
        console.log('Warning: Could not fetch Arabica API');
        return null;
    }
}

async function fetchUsdEtbRate() {
    console.log('Fetching CBE USD/ETB official rate...');
    try {
        const dateStr = new Date().toISOString().slice(0, 10);
        const response = await fetch(`https://combanketh.et/cbeapi/daily-exchange-rates/?_limit=1&Date=${dateStr}`);
        const data = await response.json();
        const rates = data?.[0]?.ExchangeRate || [];
        const usdData = rates.find(r => r.currency?.CurrencyCode === 'USD');
        return usdData ? `${usdData.transactionalSelling} ETB` : null;
    } catch (e) {
        console.log('Warning: Could not fetch CBE API');
        return null;
    }
}

// --- WEB SCRAPERS (Stealth) ---

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
        return price;
    } catch (e) {
        await page.close();
        return null;
    }
}

async function scrapeRubberPrice(browser) {
    console.log('Scraping Rubber from Investing.com...');
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    try {
        await page.goto('https://www.investing.com/commodities/rubber', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await new Promise(r => setTimeout(r, 4000));
        const price = await page.evaluate(() => {
            const el = document.querySelector('[data-test="instrument-price-last"]');
            return el ? el.innerText.trim() : null;
        });
        await page.close();
        return price ? `$${price} / kg` : null;
    } catch (e) {
        await page.close();
        return null;
    }
}

async function scrapeSesamePrice(browser) {
    console.log('Scraping Sesame from Tridge...');
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    try {
        await page.goto('https://dir.tridge.com/prices/sesame-seed/CN', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await new Promise(r => setTimeout(r, 5000));
        const price = await page.evaluate(() => {
            const el = document.querySelector('div[class*="Price__value"]') || document.querySelector('.price-value');
            return el ? el.innerText.trim() : null;
        });
        await page.close();
        return price ? `${price} / kg` : null;
    } catch (e) {
        await page.close();
        return null;
    }
}

// --- MAIN EXECUTION ---

async function generateAndPublishDashboard() {
    let browser;
    try {
        // 1. Run Fast APIs
        const [arabicaRaw, etbRate] = await Promise.all([
            fetchArabicaPrice(),
            fetchUsdEtbRate()
        ]);

        let arabicaLivePrice = arabicaRaw ? '$' + (parseFloat(arabicaRaw) / 100).toFixed(2) + ' / lb' : null;

        // 2. Run Stealth Scrapers
        browser = await puppeteer.launch({ 
            headless: 'new', 
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'] 
        });

        const [robustaRaw, rubberLivePrice, sesameLivePrice] = await Promise.all([
            scrapeRobustaPrice(browser),
            scrapeRubberPrice(browser),
            scrapeSesamePrice(browser)
        ]);

        let robustaLivePrice = robustaRaw ? '$' + robustaRaw.replace(/,/g, '') + ' / MT' : null;

        // 3. Update HTML
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
        }, arabicaLivePrice, robustaLivePrice, rubberLivePrice, etbRate, sesameLivePrice, dateStr);

        const updatedHTML = await page.content();
        fs.writeFileSync(path.join(__dirname, FILE_NAME), updatedHTML);
        await browser.close();

        // 4. Send Email Alert
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
        });

        const githubRepo = process.env.GITHUB_REPOSITORY;
        const websiteUrl = githubRepo ? `https://${githubRepo.split('/')[0]}.github.io/${githubRepo.split('/')[1]}/` : "Your GitHub Pages URL";

        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: process.env.BOSS_EMAIL,
            subject: `ET Nefas Silk Morning Brief - ${dateStr}`,
            text: `Good morning,\n\nThe intelligence dashboard has been successfully updated with live global prices.\n\n` +
                  `📊 Markets:\n` +
                  `NY Arabica: ${arabicaLivePrice || 'N/A'}\n` +
                  `London Robusta: ${robustaLivePrice || 'N/A'}\n` +
                  `Global Sesame (CN): ${sesameLivePrice || 'N/A'}\n` +
                  `Natural Rubber: ${rubberLivePrice || 'N/A'}\n` +
                  `Official USD/ETB: ${etbRate || 'N/A'}\n\n` +
                  `🌐 View the Full Live Dashboard Here:\n${websiteUrl}`
        };

        await transporter.sendMail(mailOptions);
        console.log('Automation complete. Check website and email.');

    } catch (error) {
        console.error('Error during automation:', error);
    } finally {
        if (browser) await browser.close();
    }
}

generateAndPublishDashboard();
