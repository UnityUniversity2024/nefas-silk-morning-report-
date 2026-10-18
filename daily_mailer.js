const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

const FILE_NAME = 'index.html';

async function fetchArabicaPrice() {
    try {
        const response = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/KC=F', { timeout: 10000 });
        const data = await response.json();
        const price = data.chart.result[0].meta.regularMarketPrice;
        return price ? '$' + (parseFloat(price) / 100).toFixed(2) + ' / lb' : 'N/A';
    } catch (e) { return 'N/A'; }
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
        return { USD: 'N/A', EUR: 'N/A', GBP: 'N/A', CNY: 'N/A', AED: 'N/A' };
    }
}

async function scrapeInvestingCom(browser, url, name) {
    const page = await browser.newPage();
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await new Promise(r => setTimeout(r, 3000));
        const price = await page.evaluate(() => {
            const el = document.querySelector('[data-test="instrument-price-last"]');
            return el ? el.innerText.trim() : 'N/A';
        });
        await page.close();
        return price;
    } catch (e) {
        await page.close().catch(() => {});
        return 'N/A';
    }
}

async function runEmailAutomation() {
    let browser;
    try {
        console.log('Fetching live market data...');
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

        const robustaLivePrice = robustaRaw && robustaRaw !== 'N/A' ? '$' + robustaRaw.replace(/,/g, '') + ' / MT' : 'N/A';
        const brentLivePrice = brentRaw && brentRaw !== 'N/A' ? '$' + brentRaw + ' / bbl' : 'N/A';
        const soyLivePrice = soyRaw && soyRaw !== 'N/A' ? '$' + soyRaw + ' / bu' : 'N/A';
        const rubberLivePrice = rubberRaw && rubberRaw !== 'N/A' ? '$' + rubberRaw + ' / kg' : 'N/A';

        // Update the local HTML file for the website dashboard
        const page = await browser.newPage();
        const filePath = 'file://' + path.join(__dirname, FILE_NAME);
        try { await page.goto(filePath, { waitUntil: 'domcontentloaded', timeout: 10000 }); } catch (e) {}
        
        const dateStr = new Date().toLocaleString('en-US', { timeZone: 'Africa/Addis_Ababa' });
        
        await page.evaluate((arabica, robusta, brent, soy, rubber, fx, dateStr) => {
            if (arabica !== 'N/A') document.getElementById('arabica-price').innerText = arabica;
            if (robusta !== 'N/A') document.getElementById('robusta-price').innerText = robusta;
            if (brent !== 'N/A')   document.getElementById('brent-price').innerText = brent;
            if (soy !== 'N/A')     document.getElementById('soy-price').innerText = soy;
            if (rubber !== 'N/A')  document.getElementById('rubber-price').innerText = rubber;
            if (fx.USD !== 'N/A')  document.getElementById('fx-usd').innerText = fx.USD;
            if (fx.EUR !== 'N/A')  document.getElementById('fx-eur').innerText = fx.EUR;
            if (fx.GBP !== 'N/A')  document.getElementById('fx-gbp').innerText = fx.GBP;
            if (fx.CNY !== 'N/A')  document.getElementById('fx-cny').innerText = fx.CNY;
            if (fx.AED !== 'N/A')  document.getElementById('fx-aed').innerText = fx.AED;
            document.getElementById('report-date').innerText = "Last Updated: " + dateStr;
        }, arabicaLivePrice, robustaLivePrice, brentLivePrice, soyLivePrice, rubberLivePrice, forexRates, dateStr);

        const updatedHTML = await page.content();
        fs.writeFileSync(path.join(__dirname, FILE_NAME), updatedHTML);
        await browser.close();

        // Generate the Email HTML Body
        const githubRepo = process.env.GITHUB_REPOSITORY;
        const websiteUrl = githubRepo ? `https://${githubRepo.split('/')[0]}.github.io/${githubRepo.split('/')[1]}/` : 'https://nefassilkpaints.com';

        const emailHTML = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1e293b; line-height: 1.6;">
                <div style="border-bottom: 2px solid #0f172a; padding-bottom: 15px; margin-bottom: 20px;">
                    <h2 style="color: #0f172a; margin: 0;">Nefas Silk Intelligence Desk</h2>
                    <p style="color: #64748b; font-size: 12px; margin: 5px 0 0 0;">${dateStr}</p>
                </div>
                
                <h3 style="color: #b91c1c; border-left: 3px solid #b91c1c; padding-left: 10px;">☕ Agro Exports</h3>
                <ul style="list-style: none; padding: 0; background: #f8fafc; padding: 15px; border-radius: 8px;">
                    <li><strong>NY Arabica:</strong> ${arabicaLivePrice}</li>
                    <li><strong>London Robusta:</strong> ${robustaLivePrice}</li>
                    <li><strong>Soya Beans:</strong> ${soyLivePrice}</li>
                </ul>

                <h3 style="color: #2563eb; border-left: 3px solid #2563eb; padding-left: 10px; margin-top: 25px;">🏭 Industrial Inputs & Tyres</h3>
                <ul style="list-style: none; padding: 0; background: #f8fafc; padding: 15px; border-radius: 8px;">
                    <li><strong>Brent Crude:</strong> ${brentLivePrice}</li>
                    <li><strong>Raw Rubber Index:</strong> ${rubberLivePrice}</li>
                    <li><strong>TiO2 (Rutile):</strong> $2,850 / MT</li>
                    <li><strong>Commercial Tyres (315/80R22.5):</strong> $210 / PC</li>
                </ul>

                <h3 style="color: #7e22ce; border-left: 3px solid #7e22ce; padding-left: 10px; margin-top: 25px;">💱 Foreign Exchange Matrix (ETB)</h3>
                <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px; background: #f8fafc;">
                    <tr>
                        <td style="padding: 10px; border: 1px solid #e2e8f0;"><strong>USD:</strong> ${forexRates.USD}</td>
                        <td style="padding: 10px; border: 1px solid #e2e8f0;"><strong>EUR:</strong> ${forexRates.EUR}</td>
                        <td style="padding: 10px; border: 1px solid #e2e8f0;"><strong>GBP:</strong> ${forexRates.GBP}</td>
                    </tr>
                    <tr>
                        <td style="padding: 10px; border: 1px solid #e2e8f0;"><strong>CNY:</strong> ${forexRates.CNY}</td>
                        <td style="padding: 10px; border: 1px solid #e2e8f0;" colspan="2"><strong>AED:</strong> ${forexRates.AED}</td>
                    </tr>
                </table>

                <div style="text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #e2e8f0;">
                    <a href="${websiteUrl}" style="background-color: #0f172a; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">View Full Interactive Dashboard & Charts</a>
                </div>
            </div>
        `;

        console.log('Dispatching HTML email...');
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
        });

        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: process.env.BOSS_EMAIL,
            subject: `ET Nefas Silk Executive Brief - ${dateStr}`,
            // We use 'html' instead of 'text' and remove the attachments array
            html: emailHTML 
        };

        await transporter.sendMail(mailOptions);
        console.log('Email sent successfully!');
    } catch (error) {
        console.error('Pipeline Error:', error);
        process.exit(1);
    } finally {
        if (browser) await browser.close().catch(()=>{});
    }
}
runEmailAutomation();
