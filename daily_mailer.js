const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

const FILE_NAME = 'index.html';
const PDF_NAME = 'Nefas_Silk_Morning_Brief.pdf';

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
    console.log(`Scraping ${name}...`);
    const page = await browser.newPage();
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await new Promise(r => setTimeout(r, 4000));
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

async function runAutomation() {
    let browser;
    try {
        console.log('1. Pulling market feeds...');
        const [arabicaLivePrice, forexRates] = await Promise.all([
            fetchArabicaPrice(),
            fetchForexRates()
        ]);

        browser = await puppeteer.launch({ 
            headless: 'new', 
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-web-security',
                '--allow-running-insecure-content'
            ] 
        });

        const robustaRaw = await scrapeInvestingCom(browser, 'https://www.investing.com/commodities/london-coffee', 'Robusta');
        const brentRaw = await scrapeInvestingCom(browser, 'https://www.investing.com/commodities/brent-oil', 'Brent');
        const soyRaw = await scrapeInvestingCom(browser, 'https://www.investing.com/commodities/us-soybeans', 'Soy');
        const rubberRaw = await scrapeInvestingCom(browser, 'https://www.investing.com/commodities/rubber-rss3-futures', 'Rubber');

        const robustaLivePrice = robustaRaw && robustaRaw !== 'N/A' ? '$' + robustaRaw.replace(/,/g, '') + ' / MT' : 'N/A';
        const brentLivePrice = brentRaw && brentRaw !== 'N/A' ? '$' + brentRaw + ' / bbl' : 'N/A';
        const soyLivePrice = soyRaw && soyRaw !== 'N/A' ? '$' + soyRaw + ' / bu' : 'N/A';
        const rubberLivePrice = rubberRaw && rubberRaw !== 'N/A' ? '$' + rubberRaw + ' / kg' : 'N/A';

        console.log('2. Updating HTML dashboard...');
        const page = await browser.newPage();
        await page.setViewport({ width: 1440, height: 1800, deviceScaleFactor: 2 });

        const filePath = 'file://' + path.join(__dirname, FILE_NAME);
        await page.goto(filePath, { waitUntil: 'load', timeout: 30000 });

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

        console.log('3. Waiting for TradingView graphs & assets to complete rendering...');
        // Wait 10 seconds for the widget iframes to load and draw vectors
        await new Promise(r => setTimeout(r, 10000));

        console.log('4. Generating executive PDF with rendered charts...');
        const pdfPath = path.join(__dirname, PDF_NAME);
        await page.pdf({ 
            path: pdfPath, 
            format: 'A4', 
            printBackground: true,
            preferCSSPageSize: true,
            margin: { top: '8mm', right: '8mm', bottom: '8mm', left: '8mm' }
        });

        await browser.close();

        // 5. Send Email with inline brief + attached PDF
        console.log('5. Dispatching email to executive team...');
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
        });

        const githubRepo = process.env.GITHUB_REPOSITORY;
        const websiteUrl = githubRepo ? `https://${githubRepo.split('/')[0]}.github.io/${githubRepo.split('/')[1]}/` : 'https://nefassilkpaints.com';

        const emailHTML = `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 650px; margin: 0 auto; color: #0f172a; line-height: 1.5;">
                <div style="border-bottom: 2px solid #0f172a; padding-bottom: 12px; margin-bottom: 18px;">
                    <h2 style="margin: 0; color: #0f172a; font-size: 20px;">Nefas Silk Executive Intelligence Brief</h2>
                    <p style="margin: 4px 0 0; color: #64748b; font-size: 12px;">Addis Ababa, ET | ${dateStr}</p>
                </div>

                <p style="font-size: 13px; color: #334155;">Attached is your official <strong>Nefas Silk Morning Brief (PDF)</strong> containing all market charts, freight corridor matrices, and commodity indices.</p>

                <h4 style="margin: 16px 0 6px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em; color: #b91c1c;">☕ Agro Export Snapshot</h4>
                <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 12px; font-size: 13px;">
                    <div>• <strong>NY Arabica:</strong> ${arabicaLivePrice}</div>
                    <div>• <strong>London Robusta:</strong> ${robustaLivePrice}</div>
                    <div>• <strong>Soya Beans:</strong> ${soyLivePrice}</div>
                    <div>• <strong>Whitish Humera Sesame:</strong> RMB 10,700 / MT</div>
                </div>

                <h4 style="margin: 16px 0 6px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em; color: #2563eb;">🏭 Industrial Inputs & Tyres</h4>
                <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 12px; font-size: 13px;">
                    <div>• <strong>Brent Crude Oil:</strong> ${brentLivePrice}</div>
                    <div>• <strong>Raw Rubber Index:</strong> ${rubberLivePrice}</div>
                    <div>• <strong>Titanium Dioxide (TiO2 Rutile):</strong> $2,850 / MT</div>
                    <div>• <strong>Commercial Truck Tyres (315/80R22.5):</strong> $210 / PC</div>
                </div>

                <h4 style="margin: 16px 0 6px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em; color: #059669;">🚢 Global Shipping Lines</h4>
                <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 12px; font-size: 12px;">
                    <div>• <strong>MSC & Maersk:</strong> Cape routing maintained (+14 days).</div>
                    <div>• <strong>CMA CGM:</strong> Selective Red Sea transit windows.</div>
                    <div>• <strong>ESL:</strong> Djibouti corridor schedules running normally.</div>
                </div>

                <h4 style="margin: 16px 0 6px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em; color: #7e22ce;">💱 Foreign Exchange (ETB)</h4>
                <table style="width: 100%; border-collapse: collapse; font-size: 12px; background: #f8fafc; border: 1px solid #e2e8f0;">
                    <tr>
                        <td style="padding: 8px; border: 1px solid #e2e8f0;"><strong>USD:</strong> ${forexRates.USD}</td>
                        <td style="padding: 8px; border: 1px solid #e2e8f0;"><strong>EUR:</strong> ${forexRates.EUR}</td>
                        <td style="padding: 8px; border: 1px solid #e2e8f0;"><strong>GBP:</strong> ${forexRates.GBP}</td>
                        <td style="padding: 8px; border: 1px solid #e2e8f0;"><strong>CNY:</strong> ${forexRates.CNY}</td>
                        <td style="padding: 8px; border: 1px solid #e2e8f0;"><strong>AED:</strong> ${forexRates.AED}</td>
                    </tr>
                </table>

                <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #e2e8f0; text-align: center;">
                    <a href="${websiteUrl}" style="background-color: #0f172a; color: #ffffff; padding: 10px 20px; font-size: 12px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
                        Open Interactive Web Dashboard
                    </a>
                </div>
            </div>
        `;

        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: process.env.BOSS_EMAIL,
            subject: `ET Nefas Silk Executive Brief - ${dateStr}`,
            html: emailHTML,
            attachments: [{ 
                filename: `Nefas_Silk_Morning_Brief.pdf`, 
                path: pdfPath 
            }]
        };

        await transporter.sendMail(mailOptions);
        console.log('6. Pipeline complete! Email and PDF dispatched successfully.');

    } catch (error) {
        console.error('Fatal Pipeline Error:', error);
        process.exit(1);
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
}

runAutomation();
