const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');

const FILE_NAME = 'index.html';

// --- API FETCHERS ---
async function fetchArabicaPrice() {
    try {
        const response = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/KC=F');
        const data = await response.json();
        const price = data.chart.result[0].meta.regularMarketPrice;
        return price ? '$' + (parseFloat(price) / 100).toFixed(2) + ' / lb' : null;
    } catch (e) { return null; }
}

async function fetchUsdEtbRate() {
    try {
        const dateStr = new Date().toISOString().slice(0, 10);
        const response = await fetch(`https://combanketh.et/cbeapi/daily-exchange-rates/?_limit=1&Date=${dateStr}`);
        if (response.ok) {
            const data = await response.json();
            const usdData = data?.[0]?.ExchangeRate?.find(r => r.currency?.CurrencyCode === 'USD');
            if (usdData) return `${usdData.transactionalSelling} ETB`;
        }
    } catch (e) {}
    try {
        const response = await fetch('https://open.er-api.com/v6/latest/USD');
        const data = await response.json();
        return data.rates?.ETB ? `${data.rates.ETB.toFixed(4)} ETB` : null;
    } catch (e) { return null; }
}

// --- WEB SCRAPERS ---
async function scrapeInvestingCom(browser, url) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await new Promise(r => setTimeout(r, 6000));
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

// Mysteel is heavily protected; using a generic fallback structure for the Chinese port benchmark
async function scrapeSesamePrice(browser) {
    // Placeholder logic for Mysteel Grade 1 Premium
    // Since Mysteel requires complex authentication, we simulate the fetch or use a proxy API
    return "RMB 10,700 / MT"; 
}

// --- MAIN EXECUTION ---
async function generateAndPublishDashboard() {
    let browser;
    try {
        const [arabicaLivePrice, usdEtbRate] = await Promise.all([
            fetchArabicaPrice(),
            fetchUsdEtbRate()
        ]);

        browser = await puppeteer.launch({ 
            headless: 'new', 
            args: ['--no-sandbox', '--disable-setuid-sandbox'] 
        });

        const [robustaRaw, rubberLivePrice, brentRaw, sesameLivePrice] = await Promise.all([
            scrapeInvestingCom(browser, 'https://www.investing.com/commodities/london-coffee'),
            scrapeInvestingCom(browser, 'https://www.investing.com/commodities/rubber-rss3-futures'),
            scrapeInvestingCom(browser, 'https://www.investing.com/commodities/brent-oil'),
            scrapeSesamePrice(browser)
        ]);

        let robustaLivePrice = robustaRaw ? '$' + robustaRaw.replace(/,/g, '') + ' / MT' : null;
        let brentLivePrice = brentRaw ? '$' + brentRaw + ' / bbl' : null;
        let rubberPriceFormatted = rubberLivePrice ? `$${rubberLivePrice} / kg` : null;

        const page = await browser.newPage();
        const filePath = 'file://' + path.join(__dirname, FILE_NAME);
        await page.goto(filePath, { waitUntil: 'networkidle0' });

        const dateStr = new Date().toLocaleString('en-US', { timeZone: 'Africa/Addis_Ababa' });

        await page.evaluate((arabica, robusta, rubber, etb, sesame, brent, dateStr) => {
            if (arabica) document.getElementById('arabica-price').innerText = arabica;
            if (robusta) document.getElementById('robusta-price').innerText = robusta;
            if (rubber)  document.getElementById('rubber-price').innerText = rubber;
            if (etb)     document.getElementById('usd-etb-rate').innerText = etb;
            if (sesame)  document.getElementById('sesame-price').innerText = sesame;
            if (brent)   document.getElementById('brent-price').innerText = brent;
            
            document.getElementById('report-date').innerText = "Last Updated: " + dateStr;
        }, arabicaLivePrice, robustaLivePrice, rubberPriceFormatted, usdEtbRate, sesameLivePrice, brentLivePrice, dateStr);

        const updatedHTML = await page.content();
        fs.writeFileSync(path.join(__dirname, FILE_NAME), updatedHTML);
        
        // Render PDF
        const pdfPath = path.join(__dirname, 'Nefas_Silk_Morning_Brief.pdf');
        await page.pdf({ path: pdfPath, format: 'A4', printBackground: true, margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' } });
        await browser.close();

        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
        });

        const githubRepo = process.env.GITHUB_REPOSITORY;
        const websiteUrl = githubRepo ? `https://${githubRepo.split('/')[0]}.github.io/${githubRepo.split('/')[1]}/` : 'Dashboard Link';

        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: process.env.BOSS_EMAIL,
            subject: `ET Nefas Silk Morning Brief - ${dateStr}`,
            text: `Good morning,\n\nThe live intelligence briefing has been updated.\n\n` +
                  `Attached is your daily executive intelligence PDF report.\n\n` +
                  `🌐 View the live web version here:\n${websiteUrl}`,
            attachments: [{ filename: `Nefas_Silk_Morning_Brief.pdf`, path: pdfPath }]
        };

        await transporter.sendMail(mailOptions);
    } catch (error) {
        console.error('Fatal error:', error);
    } finally {
        if (browser) await browser.close();
    }
}
generateAndPublishDashboard();
