onst puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');

const FILE_NAME = 'index.html';

// 1. API Fetcher for NY Arabica (Bulletproof)
async function fetchArabicaPrice() {
    console.log(`Fetching raw market data for Arabica (KC=F)`);
    try {
        const response = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/KC=F`);
        const data = await response.json();
        const price = data.chart.result[0].meta.regularMarketPrice;
        return price.toString();
    } catch (e) {
        console.log(`Warning: Could not fetch Arabica data via API`);
        return null;
    }
}

// 2. HTML Scraper for London Robusta
async function scrapeRobustaPrice(browser) {
    const url = 'https://www.investing.com/commodities/london-coffee';
    console.log(`Scraping live data from: ${url}`);
    const page = await browser.newPage();
    
    await page.setViewport({ width: 1920, height: 1080 });

    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await new Promise(r => setTimeout(r, 4000)); // Brief pause for data to load

        const price = await page.evaluate(() => {
            // Investing.com uses a specific data-test attribute for the live price
            const el = document.querySelector('[data-test="instrument-price-last"]');
            return el ? el.innerText.trim() : null;
        });
        
        await page.close();
        return price;
    } catch (e) {
        console.log(`Warning: Could not scrape Robusta from Investing.com`);
        await page.close();
        return null;
    }
}

async function generateAndPublishDashboard() {
    let browser;
    try {
        // Get Arabica via API
        let arabicaLivePrice = await fetchArabicaPrice();
        if (arabicaLivePrice) {
            let numericPrice = parseFloat(arabicaLivePrice);
            arabicaLivePrice = '$' + (numericPrice / 100).toFixed(2) + ' / lb';
        }

        console.log('Launching browser to scrape Robusta and update HTML...');
        browser = await puppeteer.launch({ 
            headless: 'new', 
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'] 
        });

        // Get Robusta via Puppeteer scraper
        let robustaLivePrice = await scrapeRobustaPrice(browser);
        if (robustaLivePrice) {
            // Remove commas from the raw number (e.g., "3,422.00")
            let numericRobusta = robustaLivePrice.replace(/,/g, '');
            robustaLivePrice = '$' + numericRobusta + ' / MT';
        }

        const page = await browser.newPage();
        const filePath = 'file://' + path.join(__dirname, FILE_NAME);
        await page.goto(filePath, { waitUntil: 'networkidle0' });

        const dateStr = new Date().toLocaleString('en-US', { timeZone: 'Africa/Addis_Ababa' });

        await page.evaluate((arabica, robusta, dateStr) => {
            if (arabica) document.getElementById('arabica-price').innerText = arabica;
            if (robusta) document.getElementById('robusta-price').innerText = robusta;
            document.getElementById('report-date').innerText = "Last Updated: " + dateStr;
        }, arabicaLivePrice, robustaLivePrice, dateStr);

        const updatedHTML = await page.content();
        fs.writeFileSync(path.join(__dirname, FILE_NAME), updatedHTML);
        console.log('Website HTML successfully updated on the server!');
        await browser.close();

        console.log('Sending Email Alert...');
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            }
        });

        const githubRepo = process.env.GITHUB_REPOSITORY;
        let websiteUrl = "Your GitHub Pages URL";
        if (githubRepo) {
            const parts = githubRepo.split('/');
            websiteUrl = `https://${parts[0]}.github.io/${parts[1]}/`;
        }

        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: process.env.BOSS_EMAIL,
            subject: `ET Nefas Silk Morning Brief - ${dateStr}`,
            text: `Good morning,\n\nThe intelligence dashboard has been successfully updated with live global prices.\n\n` +
                  `📊 Coffee Markets:\n` +
                  `NY Arabica: ${arabicaLivePrice || 'N/A'}\n` +
                  `London Robusta: ${robustaLivePrice || 'N/A'}\n\n` +
                  `🌐 View the Full Live Dashboard Here:\n${websiteUrl}\n\n` +
                  `Automated by Nefas Silk Intelligence Desk.`
        };

        await transporter.sendMail(mailOptions);
        console.log('Email alert sent successfully!');

    } catch (error) {
        console.error('Error during automation:', error);
    } finally {
        if (browser) await browser.close();
    }
}

generateAndPublishDashboard();
