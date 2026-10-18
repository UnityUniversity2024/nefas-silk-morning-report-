const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');

const FILE_NAME = 'index.html';

async function fetchArabicaPrice() {
    try {
        const response = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/KC=F', { timeout: 10000 });
        const data = await response.json();
        const price = data.chart.result[0].meta.regularMarketPrice;
        return price ? '$' + (parseFloat(price) / 100).toFixed(2) + ' / lb' : null;
    } catch (e) { 
        console.log('API Fetch Error (Arabica):', e.message);
        return null; 
    }
}

async function fetchForexRates() {
    try {
        const response = await fetch('https://open.er-api.com/v6/latest/USD', { timeout: 10000 });
        const data = await response.json();
        const etb = data.rates.ETB;
        return {
            USD: etb.toFixed(2),
            EUR: (etb / data.rates.EUR).toFixed(2),
            GBP: (etb / data.rates.GBP).toFixed(2),
            CNY: (etb / data.rates.CNY).toFixed(2),
            AED: (etb / data.rates.AED).toFixed(2)
        };
    } catch (e) {
        console.log('API Fetch Error (Forex):', e.message);
        return { USD: null, EUR: null, GBP: null, CNY: null, AED: null };
    }
}

async function scrapeInvestingCom(browser, url, name) {
    console.log(`Starting scraper for: ${name}...`);
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    try {
        // Lower timeout to 25s to prevent the global 30s crash
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await new Promise(r => setTimeout(r, 4000));
        const price = await page.evaluate(() => {
            const el = document.querySelector('[data-test="instrument-price-last"]');
            return el ? el.innerText.trim() : null;
        });
        console.log(`Successfully scraped ${name}: ${price}`);
        await page.close();
        return price;
    } catch (e) {
        console.log(`Timeout bypassed for ${name}. Moving on...`);
        await page.close().catch(() => {});
        return null;
    }
}

async function generateAndPublishDashboard() {
    let browser;
    try {
        console.log('1. Fetching APIs...');
        const [arabicaLivePrice, forexRates] = await Promise.all([
            fetchArabicaPrice(),
            fetchForexRates()
        ]);

        console.log('2. Launching Puppeteer Browser...');
        browser = await puppeteer.launch({ 
            headless: 'new', 
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] 
        });

        console.log('3. Scraping Commodities...');
        // Running these sequentially to reduce CPU load on GitHub's free runners
        const robustaRaw = await scrapeInvestingCom(browser, 'https://www.investing.com/commodities/london-coffee', 'Robusta');
        const brentRaw = await scrapeInvestingCom(browser, 'https://www.investing.com/commodities/brent-oil', 'Brent Crude');
        const soyRaw = await scrapeInvestingCom(browser, 'https://www.investing.com/commodities/us-soybeans', 'Soya Beans');
        const rubberRaw = await scrapeInvestingCom(browser, 'https://www.investing.com/commodities/rubber-rss3-futures', 'Rubber');

        const robustaLivePrice = robustaRaw ? '$' + robustaRaw.replace(/,/g, '') + ' / MT' : null;
        const brentLivePrice = brentRaw ? '$' + brentRaw + ' / bbl' : null;
        const soyLivePrice = soyRaw ? '$' + soyRaw + ' / bu' : null;
        const rubberLivePrice = rubberRaw ? '$' + rubberRaw + ' / kg' : null;

        console.log('4. Loading Local HTML Template...');
        const page = await browser.newPage();
        await page.setViewport({ width: 1440, height: 900 });

        const filePath = 'file://' + path.join(__dirname, FILE_NAME);

        try {
            await page.goto(filePath, { waitUntil: 'domcontentloaded', timeout: 15000 });
        } catch (e) {
            console.log('Local HTML load forced to continue...');
        }

        const dateStr = new Date().toLocaleString('en-US', { timeZone: 'Africa/Addis_Ababa' });

        await page.evaluate((arabica, robusta, brent, soy, rubber, fx, dateStr) => {
            if (arabica) document.getElementById('arabica-price').innerText = arabica;
            if (robusta) document.getElementById('robusta-price').innerText = robusta;
            if (brent)   document.getElementById('brent-price').innerText = brent;
            if (soy)     document.getElementById('soy-price').innerText = soy;
            if (rubber)  document.getElementById('rubber-price').innerText = rubber;
            
            if (fx.USD) document.getElementById('fx-usd').innerText = fx.USD;
            if (fx.EUR) document.getElementById('fx-eur').innerText = fx.EUR;
            if (fx.GBP) document.getElementById('fx-gbp').innerText = fx.GBP;
            if (fx.CNY) document.getElementById('fx-cny').innerText = fx.CNY;
            if (fx.AED) document.getElementById('fx-aed').innerText = fx.AED;
            
            document.getElementById('report-date').innerText = "Last Updated: " + dateStr;
        }, arabicaLivePrice, robustaLivePrice, brentLivePrice, soyLivePrice, rubberLivePrice, forexRates, dateStr);

        const updatedHTML = await page.content();
        fs.writeFileSync(path.join(__dirname, FILE_NAME), updatedHTML);
        
        console.log('5. Waiting for TradingView Charts to Render...');
        await new Promise(resolve => setTimeout(resolve, 6000));

        console.log('6. Printing PDF...');
        const pdfPath = path.join(__dirname, 'Nefas_Silk_Morning_Brief.pdf');
        await page.pdf({ 
            path: pdfPath, 
            format: 'A4', 
            printBackground: true, 
            margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' } 
        });

        await browser.close();

        console.log('7. Sending Email...');
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
        });

        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: process.env.BOSS_EMAIL,
            subject: `ET Nefas Silk Executive Brief - ${dateStr}`,
            text: `Good morning,\n\nThe live intelligence briefing has been updated.\n\nAttached is your daily PDF report.`,
            attachments: [{ filename: `Nefas_Silk_Morning_Brief.pdf`, path: pdfPath }]
        };

        await transporter.sendMail(mailOptions);
        console.log('8. Automation Complete!');
    } catch (error) {
        console.error('Fatal Pipeline Error:', error);
        process.exit(1);
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
}
generateAndPublishDashboard();
