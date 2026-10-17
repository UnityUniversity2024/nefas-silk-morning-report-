const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');

const FILE_NAME = 'index.html';

// --- 1. MULTI-CURRENCY & API FETCHERS ---
async function fetchArabicaPrice() {
    try {
        const response = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/KC=F');
        const data = await response.json();
        const price = data.chart.result[0].meta.regularMarketPrice;
        return price ? '$' + (parseFloat(price) / 100).toFixed(2) + ' / lb' : null;
    } catch (e) { 
        console.log('Warning: Could not fetch Arabica API:', e.message);
        return null; 
    }
}

async function fetchForexRates() {
    try {
        const response = await fetch('https://open.er-api.com/v6/latest/USD');
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
        console.log('Warning: Could not fetch Forex rates:', e.message);
        return { USD: null, EUR: null, GBP: null, CNY: null, AED: null };
    }
}

// --- 2. COMMODITY SCRAPERS ---
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
        console.log(`Warning: Failed scraping ${url}:`, e.message);
        await page.close();
        return null;
    }
}

// --- 3. MAIN WORKFLOW ---
async function generateAndPublishDashboard() {
    let browser;
    try {
        console.log('Initiating real-time data collection...');
        const [arabicaLivePrice, forexRates] = await Promise.all([
            fetchArabicaPrice(),
            fetchForexRates()
        ]);

        browser = await puppeteer.launch({ 
            headless: 'new', 
            args: ['--no-sandbox', '--disable-setuid-sandbox'] 
        });

        const [robustaRaw, brentRaw, soyRaw, rubberRaw] = await Promise.all([
            scrapeInvestingCom(browser, 'https://www.investing.com/commodities/london-coffee'),
            scrapeInvestingCom(browser, 'https://www.investing.com/commodities/brent-oil'),
            scrapeInvestingCom(browser, 'https://www.investing.com/commodities/us-soybeans'),
            scrapeInvestingCom(browser, 'https://www.investing.com/commodities/rubber-rss3-futures')
        ]);

        let robustaLivePrice = robustaRaw ? '$' + robustaRaw.replace(/,/g, '') + ' / MT' : null;
        let brentLivePrice = brentRaw ? '$' + brentRaw + ' / bbl' : null;
        let soyLivePrice = soyRaw ? '$' + soyRaw + ' / bu' : null;
        let rubberLivePrice = rubberRaw ? '$' + rubberRaw + ' / kg' : null;

        console.log('Updating HTML template with live values...');
        const page = await browser.newPage();
        await page.setViewport({ width: 1440, height: 900 });

        const filePath = 'file://' + path.join(__dirname, FILE_NAME);

        // FIX: Use networkidle2 + 60s timeout so background TradingView requests do not trigger exit code 1
        await page.goto(filePath, { waitUntil: 'networkidle2', timeout: 60000 });

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

        // Save updated HTML to disk
        const updatedHTML = await page.content();
        fs.writeFileSync(path.join(__dirname, FILE_NAME), updatedHTML);
        console.log('HTML file successfully updated.');

        // Pause 6 seconds to give TradingView iframes sufficient time to draw before taking the PDF snapshot
        await new Promise(resolve => setTimeout(resolve, 6000));

        console.log('Rendering executive PDF brief...');
        const pdfPath = path.join(__dirname, 'Nefas_Silk_Morning_Brief.pdf');
        await page.pdf({ 
            path: pdfPath, 
            format: 'A4', 
            printBackground: true, 
            margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' } 
        });
        console.log('PDF brief successfully created.');

        await browser.close();

        // --- 4. DISPATCH EMAIL ---
        console.log('Dispatching executive email...');
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
            subject: `ET Nefas Silk Executive Brief - ${dateStr}`,
            text: `Good morning,\n\nThe live intelligence briefing has been updated with multi-currency tracking, live market graphs, and commercial tire benchmarks.\n\n` +
                  `Attached is your daily PDF report.\n\n` +
                  `🌐 View the live web version here:\n${websiteUrl}\n\n` +
                  `Automated by Nefas Silk Intelligence Desk.`,
            attachments: [{ filename: `Nefas_Silk_Morning_Brief.pdf`, path: pdfPath }]
        };

        await transporter.sendMail(mailOptions);
        console.log('Executive brief email dispatched successfully.');

    } catch (error) {
        console.error('Fatal error during automation run:', error);
        process.exit(1);
    } finally {
        if (browser) await browser.close();
    }
}

generateAndPublishDashboard();
