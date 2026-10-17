const puppeteer = require('puppeteer');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');

const FILE_NAME = 'index.html';

// Helper function to scrape Yahoo Finance
async function scrapeYahooFinance(browser, url) {
    console.log(`Scraping live data from: ${url}`);
    const page = await browser.newPage();
    
    // Set a standard user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1920, height: 1080 });

    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        
        // Wait a brief moment for dynamic elements to load
        await new Promise(r => setTimeout(r, 2000));

        const price = await page.evaluate(() => {
            // Yahoo Finance uses specific data-testid attributes for live prices
            const el = document.querySelector('fin-streamer[data-field="regularMarketPrice"]');
            return el ? el.innerText.trim() : null;
        });
        
        await page.close();
        return price;
    } catch (e) {
        console.log(`Warning: Could not scrape ${url}`);
        await page.close();
        return null;
    }
}

async function generateAndPublishDashboard() {
    let browser;
    try {
        console.log('Launching headless browser...');
        browser = await puppeteer.launch({ 
            headless: 'new', 
            args: ['--no-sandbox', '--disable-setuid-sandbox'] 
        });

        // Scrape KC=F (Coffee Futures) for Arabica
        let arabicaLivePrice = await scrapeYahooFinance(browser, 'https://finance.yahoo.com/quote/KC=F');
        
        // Yahoo Finance provides this in US cents per pound (e.g., 278.10). 
        // We will convert it to Dollars per pound.
        if (arabicaLivePrice) {
            let numericPrice = parseFloat(arabicaLivePrice.replace(/,/g, ''));
            arabicaLivePrice = '$' + (numericPrice / 100).toFixed(2) + ' / lb';
        }

        // Note: Yahoo Finance does not track London Robusta futures directly. 
        // For now, we will leave it as N/A or keep the old Trading Economics link if you prefer to mix sources.
        let robustaLivePrice = "Data Source Pending"; 

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
