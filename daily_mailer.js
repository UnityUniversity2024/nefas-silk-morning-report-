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

        console.log('3. Waiting for rendering...');
        await new Promise(r => setTimeout(r, 6000));

        console.log('4. Generating PDF...');
        const pdfPath = path.join(__dirname, PDF_NAME);
        await page.pdf({ 
            path: pdfPath, 
            format: 'A4', 
            printBackground: true,
            margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' }
        });

        await browser.close();

        console.log('5. Dispatching email...');
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
        });

        const githubRepo = process.env.GITHUB_REPOSITORY;
        const websiteUrl = githubRepo ? `https://${githubRepo.split('/')[0]}.github.io/${githubRepo.split('/')[1]}/` : 'https://www.nefassilkpaints.com';

        const emailHTML = `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 650px; margin: 0 auto; color: #0f172a; line-height: 1.5; background-color: #ffffff;">
                <div style="background-color: #0f172a; padding: 20px; border-radius: 8px 8px 0 0; text-align: center;">
                    <h2 style="margin: 0; color: #ffffff; font-size: 22px; font-weight: 900; letter-spacing: 1px;"><span style="color: #ef4444;">NEFAS SILK</span> PAINTS</h2>
                    <h3 style="margin: 6px 0 0; color: #94a3b8; font-size: 14px; text-transform: uppercase; letter-spacing: 2px;">Intelligence Desk</h3>
                </div>

                <div style="padding: 20px; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 8px 8px;">
                    <p style="margin: 0 0 20px; color: #475569; font-size: 13px; text-align: center;"><strong>${dateStr}</strong><br>Attached is your daily PDF executive summary.</p>

                    <h4 style="margin: 0 0 10px; font-size: 14px; text-transform: uppercase; letter-spacing: 1px; color: #0f172a; border-bottom: 2px solid #e2e8f0; padding-bottom: 5px;">☕ Agro Exports</h4>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 25px; font-size: 13px;">
                        <div style="background: #f8fafc; padding: 10px; border-radius: 6px; border: 1px solid #f1f5f9;"><strong>NY Arabica:</strong><br><span style="color: #059669; font-size: 16px; font-weight: bold;">${arabicaLivePrice}</span></div>
                        <div style="background: #f8fafc; padding: 10px; border-radius: 6px; border: 1px solid #f1f5f9;"><strong>Robusta:</strong><br><span style="color: #059669; font-size: 16px; font-weight: bold;">${robustaLivePrice}</span></div>
                        <div style="background: #f8fafc; padding: 10px; border-radius: 6px; border: 1px solid #f1f5f9;"><strong>Soya Beans:</strong><br><span style="color: #d97706; font-size: 16px; font-weight: bold;">${soyLivePrice}</span></div>
                        <div style="background: #f8fafc; padding: 10px; border-radius: 6px; border: 1px solid #f1f5f9;"><strong>Sesame (Humera):</strong><br><span style="color: #0f172a; font-size: 15px; font-weight: bold;">RMB 10,700/MT</span></div>
                    </div>

                    <h4 style="margin: 0 0 10px; font-size: 14px; text-transform: uppercase; letter-spacing: 1px; color: #0f172a; border-bottom: 2px solid #e2e8f0; padding-bottom: 5px;">🏭 Industrial Sourcing</h4>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 25px; font-size: 13px;">
                        <div style="background: #f8fafc; padding: 10px; border-radius: 6px; border: 1px solid #f1f5f9;"><strong>Brent Crude:</strong><br><span style="color: #e11d48; font-size: 16px; font-weight: bold;">${brentLivePrice}</span></div>
                        <div style="background: #f8fafc; padding: 10px; border-radius: 6px; border: 1px solid #f1f5f9;"><strong>Rubber Index:</strong><br><span style="color: #0f172a; font-size: 16px; font-weight: bold;">${rubberLivePrice}</span></div>
                        <div style="background: #f8fafc; padding: 10px; border-radius: 6px; border: 1px solid #f1f5f9;"><strong>TiO2 (Rutile):</strong><br><span style="color: #2563eb; font-size: 15px; font-weight: bold;">$2,850 / MT</span></div>
                        <div style="background: #f8fafc; padding: 10px; border-radius: 6px; border: 1px solid #f1f5f9;"><strong>Commercial Tyres:</strong><br><span style="color: #475569; font-size: 15px; font-weight: bold;">$210 / PC</span></div>
                    </div>

                    <h4 style="margin: 0 0 10px; font-size: 14px; text-transform: uppercase; letter-spacing: 1px; color: #0f172a; border-bottom: 2px solid #e2e8f0; padding-bottom: 5px;">🚢 Shipping Logistics</h4>
                    <table style="width: 100%; border-collapse: collapse; margin-bottom: 25px; font-size: 12px; background: #f8fafc; border: 1px solid #f1f5f9;">
                        <tr><td style="padding: 10px; border-bottom: 1px solid #e2e8f0;"><strong>MSC:</strong> Rerouted via Cape of Good Hope (+14 days)</td></tr>
                        <tr><td style="padding: 10px; border-bottom: 1px solid #e2e8f0;"><strong>Maersk:</strong> Rerouted via Cape of Good Hope (+14 days)</td></tr>
                        <tr><td style="padding: 10px; border-bottom: 1px solid #e2e8f0;"><strong>CMA CGM:</strong> Selective Red Sea transit windows active</td></tr>
                        <tr><td style="padding: 10px;"><strong>ESL (Ethiopian):</strong> Normal schedules on Djibouti corridor</td></tr>
                    </table>

                    <h4 style="margin: 0 0 10px; font-size: 14px; text-transform: uppercase; letter-spacing: 1px; color: #0f172a; border-bottom: 2px solid #e2e8f0; padding-bottom: 5px;">💱 Forex Cross-Rates (ETB)</h4>
                    <table style="width: 100%; border-collapse: collapse; font-size: 12px; background: #f8fafc; border: 1px solid #f1f5f9;">
                        <tr>
                            <td style="padding: 10px; border: 1px solid #e2e8f0; text-align: center;"><strong>USD:</strong><br>${forexRates.USD}</td>
                            <td style="padding: 10px; border: 1px solid #e2e8f0; text-align: center;"><strong>EUR:</strong><br>${forexRates.EUR}</td>
                            <td style="padding: 10px; border: 1px solid #e2e8f0; text-align: center;"><strong>GBP:</strong><br>${forexRates.GBP}</td>
                            <td style="padding: 10px; border: 1px solid #e2e8f0; text-align: center;"><strong>CNY:</strong><br>${forexRates.CNY}</td>
                            <td style="padding: 10px; border: 1px solid #e2e8f0; text-align: center;"><strong>AED:</strong><br>${forexRates.AED}</td>
                        </tr>
                    </table>

                    <div style="margin-top: 30px; text-align: center;">
                        <a href="${websiteUrl}" style="background-color: #ef4444; color: #ffffff; padding: 12px 24px; font-size: 13px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block; letter-spacing: 1px;">
                            ACCESS LIVE DASHBOARD
                        </a>
                    </div>
                </div>
            </div>
        `;

        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: process.env.BOSS_EMAIL,
            subject: `ET Nefas Silk Executive Brief - ${dateStr}`,
            html: emailHTML,
            attachments: [{ filename: PDF_NAME, path: pdfPath }]
        };

        await transporter.sendMail(mailOptions);
        console.log('6. Pipeline complete!');

    } catch (error) {
        console.error('Pipeline Error:', error);
        process.exit(1);
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
}

runAutomation();
