const puppeteer = require('puppeteer');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');

// The file we are updating
const FILE_NAME = 'index.html';

// Helper function to scrape Trading Economics (Stealth Mode)
async function scrapePrice(browser, url) {
    console.log(`Scraping live data from: ${url}`);
    const page = await browser.newPage();
    
    // Disguise the robot as a real human on a normal Windows computer
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Upgrade-Insecure-Requests': '1'
    });
    await page.setViewport({ width: 1920, height: 1080 });

    try {
        // Give the page more time to load (30 seconds)
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        
        // Pause for 5 seconds to let the website's anti-bot security finish loading
        await new Promise(r => setTimeout(r, 5000)); 

        const price = await page.evaluate(() => {
            // Check for the price using a few different hidden codes the website uses
            const el = document.querySelector('#market_last') || document.querySelector('.market-last') || document.querySelector('#market-last');
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
        browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });

        // 1. Scrape Live Coffee Prices
        let arabicaLivePrice = await scrapePrice(browser, 'https://tradingeconomics.com/commodity/coffee');
        let robustaLivePrice = await scrapePrice(browser, 'https://tradingeconomics.com/commodity/robusta-coffee');

        // Format to Dollars
        if (arabicaLivePrice) arabicaLivePrice = '$' + (parseFloat(arabicaLivePrice) / 100).toFixed(2) + ' / lb';
        if (robustaLivePrice) robustaLivePrice = '$' + robustaLivePrice + ' / MT';

        // 2. Load the base HTML Dashboard (index.html)
        const page = await browser.newPage();
        const filePath = 'file://' + path.join(__dirname, FILE_NAME);
        await page.goto(filePath, { waitUntil: 'networkidle0' });

        const dateStr = new Date().toLocaleString('en-US', { timeZone: 'Africa/Addis_Ababa' });

        // 3. Inject new data into the HTML
        await page.evaluate((arabica, robusta, dateStr) => {
            if (arabica) document.getElementById('arabica-price').innerText = arabica;
            if (robusta) document.getElementById('robusta-price').innerText = robusta;
            document.getElementById('report-date').innerText = "Last Updated: " + dateStr;
        }, arabicaLivePrice, robustaLivePrice, dateStr);

        // 4. Overwrite index.html with the new updated code
        const updatedHTML = await page.content();
        fs.writeFileSync(path.join(__dirname, FILE_NAME), updatedHTML);
        console.log('Website HTML successfully updated on the server!');
        await browser.close();

        // 5. Send Email Alert with the Website Link
        console.log('Sending Email Alert...');
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            }
        });

        // Determine the GitHub Pages URL automatically from environment variables
        const githubRepo = process.env.GITHUB_REPOSITORY; // looks like "username/repository"
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
