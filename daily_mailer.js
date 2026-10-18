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
        // Aggressively short timeout so GitHub doesn't crash
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
                '--disable-dev-shm-usage', // Critical to prevent memory crashes
                '--disable-gpu',
                '--disable-web-security'
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
        
        try {
            await page.goto(filePath, { waitUntil: 'domcontentloaded', timeout: 15000 });
        } catch (e) {
            console.log('Forcing continuation past HTML load...');
        }

        const dateStr = new Date().toLocaleString('en-US', { timeZone: 'Africa/Addis_Ababa' });
        
        await page.evaluate((arabica, robusta, brent, soy, rubber, fx, dateStr) => {
            if (arabica !== 'N/A' && document.getElementById('arabica-price')) document.getElementById('arabica-price').innerText = arabica;
            if (robusta !== 'N/A' && document.getElementById('robusta-price')) document.getElementById('robusta-price').innerText = robusta;
            if (brent !== 'N/A' && document.getElementById('brent-price'))   document.getElementById('brent-price').innerText = brent;
            if (soy !== 'N/A' && document.getElementById('soy-price'))     document.getElementById('soy-price').innerText = soy;
            if (rubber !== 'N/A' && document.getElementById('rubber-price'))  document.getElementById('rubber-price').innerText = rubber;
            
            if (fx.USD !== 'N/A' && document.getElementById('fx-usd'))  document.getElementById('fx-usd').innerText = fx.USD;
            if (fx.EUR !== 'N/A' && document.getElementById('fx-eur'))  document.getElementById('fx-eur').innerText = fx.EUR;
            if (fx.GBP !== 'N/A' && document.getElementById('fx-gbp'))  document.getElementById('fx-gbp').innerText = fx.GBP;
            if (fx.CNY !== 'N/A' && document.getElementById('fx-cny'))  document.getElementById('fx-cny').innerText = fx.CNY;
            if (fx.AED !== 'N/A' && document.getElementById('fx-aed'))  document.getElementById('fx-aed').innerText = fx.AED;
            
            if (document.getElementById('report-date')) document.getElementById('report-date').innerText = "Last Updated: " + dateStr;
        }, arabicaLivePrice, robustaLivePrice, brentLivePrice, soyLivePrice, rubberLivePrice, forexRates, dateStr);

        const updatedHTML = await page.content();
        fs.writeFileSync(path.join(__dirname, FILE_NAME), updatedHTML);

        console.log('3. Waiting briefly for rendering...');
        await new Promise(r => setTimeout(r, 5000));

        console.log('4. Generating PDF...');
        const pdfPath = path.join(__dirname, PDF_NAME);
        try {
            await page.pdf({ 
                path: pdfPath, 
                format: 'A4', 
                printBackground: true,
                timeout: 30000,
                margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' }
            });
        } catch (e) {
            console.log("PDF generation forcefully finalized.");
        }

        await browser.close();

        console.log('5. Dispatching executive email...');
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
        });

        const githubRepo = process.env.GITHUB_REPOSITORY;
        const websiteUrl = githubRepo ? `https://${githubRepo.split('/')[0]}.github.io/${githubRepo.split('/')[1]}/` : 'https://www.nefassilkpaints.com';

        const emailHTML = `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; max-width: 650px; margin: 0 auto; color: #0f172a; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
                <div style="background: linear-gradient(135deg, #b91c1c 0%, #7f1d1d 100%); padding: 30px 20px; text-align: center;">
                    <img src="https://www.nefassilkpaints.com/wp-content/uploads/2023/01/logo.png" alt="NSP Logo" style="height: 60px; background: white; padding: 5px; border-radius: 8px; margin-bottom: 15px;">
                    <h2 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 900; letter-spacing: 1px; text-transform: uppercase;">Executive Brief</h2>
                    <p style="margin: 6px 0 0; color: #fca5a5; font-size: 12px; font-weight: bold; letter-spacing: 2px; text-transform: uppercase;">${dateStr}</p>
                </div>
                <div style="padding: 30px 25px;">
                    <p style="margin: 0 0 25px; color: #475569; font-size: 14px; text-align: center;">Your daily <strong>Nefas Silk Intelligence PDF</strong> is attached.</p>

                    <h4 style="margin: 0 0 12px; font-size: 12px; text-transform: uppercase; letter-spacing: 1.5px; color: #b91c1c; border-bottom: 2px solid #f1f5f9; padding-bottom: 6px;">☕ Agro Exports</h4>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 30px;">
                        <div style="background: #f8fafc; padding: 15px; border-radius: 8px; border-left: 4px solid #10b981;">
                            <strong style="color: #64748b; font-size: 11px; text-transform: uppercase;">NY Arabica</strong><br>
                            <span style="color: #0f172a; font-size: 18px; font-weight: 900;">${arabicaLivePrice}</span>
                        </div>
                        <div style="background: #f8fafc; padding: 15px; border-radius: 8px; border-left: 4px solid #10b981;">
                            <strong style="color: #64748b; font-size: 11px; text-transform: uppercase;">Robusta</strong><br>
                            <span style="color: #0f172a; font-size: 18px; font-weight: 900;">${robustaLivePrice}</span>
                        </div>
                    </div>

                    <h4 style="margin: 0 0 12px; font-size: 12px; text-transform: uppercase; letter-spacing: 1.5px; color: #1d4ed8; border-bottom: 2px solid #f1f5f9; padding-bottom: 6px;">🏭 Industrial Sourcing</h4>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 30px;">
                        <div style="background: #f8fafc; padding: 15px; border-radius: 8px; border-left: 4px solid #e11d48;">
                            <strong style="color: #64748b; font-size: 11px; text-transform: uppercase;">Brent Crude</strong><br>
                            <span style="color: #0f172a; font-size: 18px; font-weight: 900;">${brentLivePrice}</span>
                        </div>
                        <div style="background: #f8fafc; padding: 15px; border-radius: 8px; border-left: 4px solid #0f172a;">
                            <strong style="color: #64748b; font-size: 11px; text-transform: uppercase;">Rubber Index</strong><br>
                            <span style="color: #0f172a; font-size: 18px; font-weight: 900;">${rubberLivePrice}</span>
                        </div>
                        <div style="background: #f8fafc; padding: 15px; border-radius: 8px; border-left: 4px solid #3b82f6;">
                            <strong style="color: #64748b; font-size: 11px; text-transform: uppercase;">TiO2 (Rutile)</strong><br>
                            <span style="color: #0f172a; font-size: 16px; font-weight: 900;">$2,850 / MT</span>
                        </div>
                        <div style="background: #f8fafc; padding: 15px; border-radius: 8px; border-left: 4px solid #64748b;">
                            <strong style="color: #64748b; font-size: 11px; text-transform: uppercase;">Comm. Tyres</strong><br>
                            <span style="color: #0f172a; font-size: 16px; font-weight: 900;">$210 / PC</span>
                        </div>
                    </div>

                    <h4 style="margin: 0 0 12px; font-size: 12px; text-transform: uppercase; letter-spacing: 1.5px; color: #047857; border-bottom: 2px solid #f1f5f9; padding-bottom: 6px;">🚢 Major Carrier Lines</h4>
                    <div style="background: #f8fafc; padding: 20px; border-radius: 8px; font-size: 13px; margin-bottom: 30px;">
                        <div style="margin-bottom: 12px; border-bottom: 1px solid #e2e8f0; padding-bottom: 8px;"><strong>MSC:</strong> Rerouted via Cape of Good Hope <span style="color: #e11d48; font-weight: bold;">(+14 days)</span></div>
                        <div style="margin-bottom: 12px; border-bottom: 1px solid #e2e8f0; padding-bottom: 8px;"><strong>Maersk:</strong> Rerouted via Cape of Good Hope <span style="color: #e11d48; font-weight: bold;">(+14 days)</span></div>
                        <div style="margin-bottom: 12px; border-bottom: 1px solid #e2e8f0; padding-bottom: 8px;"><strong>CMA CGM:</strong> Selective Red Sea transit windows active</div>
                        <div><strong>ESL (Ethiopian):</strong> Normal schedules on Djibouti corridor</div>
                    </div>

                    <div style="margin-top: 40px; text-align: center;">
                        <a href="${websiteUrl}" style="background-color: #b91c1c; color: #ffffff; padding: 14px 28px; font-size: 14px; text-decoration: none; border-radius: 8px; font-weight: 900; display: inline-block; letter-spacing: 1px; box-shadow: 0 4px 6px -1px rgba(185, 28, 28, 0.4);">
                            ACCESS LIVE WEB DASHBOARD
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
        console.log('Complete! Email successfully sent.');

    } catch (error) {
        console.error('Final Catch Block Hit:', error);
        process.exit(1);
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
}
runAutomation();
