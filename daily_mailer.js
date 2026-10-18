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
    } catch (e) { return null; }
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
        return { USD: null, EUR: null, GBP: null, CNY: null, AED: null };
    }
}

async function scrapeInvestingCom(browser, url, name) {
    console.log(`Scraping ${name}...`);
    const page = await browser.newPage();
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await new Promise(r => setTimeout(r, 3000));
        const price = await page.evaluate(() => {
            const el = document.querySelector('[data-test="instrument-price-last"]');
            return el ? el.innerText.trim() : null;
        });
        await page.close();
        return price;
    } catch (e) {
        await page.close().catch(() => {});
        return null;
    }
}

async function generateAndPublishDashboard() {
    let browser;
    try {
        const [arabicaLivePrice, forexRates] = await Promise.all([
            fetchArabicaPrice(),
            fetchForexRates()
        ]);

        browser = await puppeteer.launch({ 
            headless: 'new', 
            args: ['--no-sandbox', '--disable-setuid-sandbox'] 
        });

        const robustaRaw = await scrapeInvestingCom(browser, 'https://www.investing.com/commodities/london-coffee', 'Robusta');
        const brentRaw = await scrapeInvestingCom(browser, 'https://www.investing.com/commodities/brent-oil', 'Brent');
        const soyRaw = await scrapeInvestingCom(browser, 'https://www.investing.com/commodities/us-soybeans', 'Soy');
        const rubberRaw = await scrapeInvestingCom(browser, 'https://www.investing.com/commodities/rubber-rss3-futures', 'Rubber');

        const robustaLivePrice = robustaRaw ? '$' + robustaRaw.replace(/,/g, '') + ' / MT' : null;
        const brentLivePrice = brentRaw ? '$' + brentRaw + ' / bbl' : null;
        const soyLivePrice = soyRaw ? '$' + soyRaw + ' / bu' : null;
        const rubberLivePrice = rubberRaw ? '$' + rubberRaw + ' / kg' : null;

        const page = await browser.newPage();
        const filePath = 'file://' + path.join(__dirname, FILE_NAME);

        try {
            await page.goto(filePath, { waitUntil: 'domcontentloaded', timeout: 10000 });
        } catch (e) {}

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
        
        await browser.close();

        // Send Email with HTML file attached instead of PDF
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
        });

        const githubRepo = process.env.GITHUB_REPOSITORY;
        const websiteUrl = githubRepo ? `https://${githubRepo.split('/')[0]}.github.io/${githubRepo.split('/')[1]}/` : 'Dashboard Link';

        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: process.env.BOSS_EMAIL,
            subject: `ET Nefas Silk Executive Brief - ${dateStr}`,
            text: `Good morning,\n\nThe live intelligence briefing has been updated.\n\nAttached is your daily Interactive HTML report. Double-click to open it securely in any web browser.\n\n🌐 View the live web version here:\n${websiteUrl}`,
            attachments: [{ 
                filename: `Nefas_Silk_Morning_Brief.html`, 
                path: path.join(__dirname, FILE_NAME) 
            }]
        };

        await transporter.sendMail(mailOptions);
        console.log('HTML Report Sent Successfully!');
    } catch (error) {
        console.error('Fatal error:', error);
        process.exit(1);
    } finally {
        if (browser) await browser.close().catch(()=>{});
    }
}
generateAndPublishDashboard();
