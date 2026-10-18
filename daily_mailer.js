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
        console.log(`Bypassed timeout for ${name}`);
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

        console.log('2. Launching memory-optimized Puppeteer...');
        browser = await puppeteer.launch({ 
            headless: 'new', 
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-dev-shm-usage', // FIX: Prevents the 24-second GitHub Actions memory crash
                '--disable-gpu'
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

        console.log('3. Updating HTML dashboard...');
        const page = await browser.newPage();
        await page.setViewport({ width: 1440, height: 1800, deviceScaleFactor: 2 });

        const filePath = 'file://' + path.join(__dirname, FILE_NAME);
        await page.goto(filePath, { waitUntil: 'networkidle0', timeout: 30000 });

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

        console.log('4. Waiting for charts and logo to render...');
        await new Promise(r => setTimeout(r, 6000));

        console.log('5. Generating PDF...');
        const pdfPath = path.join(__dirname, PDF_NAME);
        await page.pdf({ 
            path: pdfPath, 
            format: 'A4', 
            printBackground: true,
            margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' }
        });

        await browser.close();

        console.log('6. Dispatching executive email...');
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
        });

        const githubRepo = process.env.GITHUB_REPOSITORY;
        const websiteUrl = githubRepo ? `https://${githubRepo.split('/')[0]}.github.io/${githubRepo.split('/')[1]}/` : 'https://www.nefassilkpaints.com';

        const emailHTML = `
            <div style="font-family: Arial, sans-serif; max-width: 650px; margin: 0 auto; color: #0f172a; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
                <div style="background: linear-gradient(135deg, #b91c1c 0%, #7f1d1d 100%); padding: 30px 20px; text-align: center;">
                    <img src="https://www.nefassilkpaints.com/wp-content/uploads/2023/01/logo.png" alt="NSP Logo" style="height: 60px; background: white; padding: 5px; border-radius: 8px; margin-bottom: 15px;">
                    <h2 style="margin: 0; color: #ffffff; font-size: 24px; text-transform: uppercase;">Executive Brief</h2>
                    <p style="margin: 6px 0 0; color: #fca5a5; font-size: 12px; text-transform: uppercase;">${dateStr}</p>
                </div>
                <div style="padding: 30px 25px;">
                    <p style="text-align: center; color: #475569; margin-bottom: 25px;">Your daily <strong>Nefas Silk Intelligence PDF</strong> is attached.</p>
                    
                    <h4 style="color: #b91c1c; border-bottom: 2px solid #f1f5f9; padding-bottom: 6px;">☕ Agro Exports</h4>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 25px;">
                        <div style="background: #f8fafc; padding: 15px; border-radius: 8px; border-left: 4px solid #10b981;">
                            <strong>NY Arabica</strong><br><span style="font-size: 18px;">${arabicaLivePrice}</span>
                        </div>
                        <div style="background: #f8fafc; padding: 15px; border-radius: 8px; border-left: 4px solid #10b981;">
                            <strong>Robusta</strong><br><span style="font-size: 18px;">${robustaLivePrice}</span>
                        </div>
                    </div>

                    <h4 style="color: #1d4ed8; border-bottom: 2px solid #f1f5f9; padding-bottom: 6px;">🏭 Industrial Sourcing</h4>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 25px;">
                        <div style="background: #f8fafc; padding: 15px; border-radius: 8px; border-left: 4px solid #e11d48;">
                            <strong>Brent Crude</strong><br><span style="font-size: 18px;">${brentLivePrice}</span>
                        </div>
                        <div style="background: #f8fafc; padding: 15px; border-radius: 8px; border-left: 4px solid #0f172a;">
                            <strong>Rubber Index</strong><br><span style="font-size: 18px;">${rubberLivePrice}</span>
                        </div>
                    </div>

                    <div style="text-align: center; margin-top: 30px;">
                        <a href="${websiteUrl}" style="background-color: #b91c1c; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">View Full Dashboard</a>
                    </div>
                </div>
            </div>
        `;

        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: process.env.BOSS_EMAIL,
            subject: `ET Nefas Silk Executive Brief - ${dateStr}`,
            html: emailHTML,
            attachments: [{ filename: PDF_NAME, path: pdfPath }]
        });
        console.log('Complete! No errors.');

    } catch (error) {
        console.error('Fatal Pipeline Error (Check details below):', error);
        process.exit(1);
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
}
runAutomation();
2. The Colorful Executive Web Dashboard (index.html)
This version utilizes the official Nefas Silk website logo and removes the broken TradingView image links, replacing them with a highly polished, colorful, gradient-rich layout.

HTML
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Executive Intelligence | Nefas Silk Paints</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        @media print {
            @page { margin: 10mm; size: A4 portrait; }
            body { background-color: #ffffff !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; font-size: 11px; }
            .tabs-nav, .no-print { display: none !important; }
            .print-header { padding-top: 0; padding-bottom: 12px; margin-bottom: 15px; border-bottom: 3px solid #b91c1c; }
            .avoid-break { break-inside: avoid !important; page-break-inside: avoid !important; margin-bottom: 15px !important; }
            .tab-content { display: block !important; margin-bottom: 20px; }
            .shadow-2xl { box-shadow: none !important; border: 1px solid #cbd5e1 !important; }
            .bg-gradient-to-r, .bg-gradient-to-br { background: #f8fafc !important; color: #0f172a !important; }
            .text-white { color: #0f172a !important; }
        }
        
        .tab-btn { transition: all 0.3s ease; }
        .active-tab { background: linear-gradient(135deg, #b91c1c 0%, #7f1d1d 100%); color: #ffffff; box-shadow: 0 4px 10px rgba(185, 28, 28, 0.4); }
        .inactive-tab { background-color: #f1f5f9; color: #475569; }
        .inactive-tab:hover { background-color: #e2e8f0; color: #0f172a; }
        .data-card { transition: transform 0.2s ease, box-shadow 0.2s ease; border-top-width: 6px; }
        .data-card:hover { transform: translateY(-4px); box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1); }
    </style>
</head>
<body class="bg-slate-50 text-slate-800 font-sans antialiased min-h-screen">

    <div class="bg-gradient-to-r from-slate-900 to-slate-800 text-white text-xs font-bold py-2.5 px-6 flex gap-8 overflow-hidden whitespace-nowrap no-print shadow-lg">
        <span class="text-emerald-400 uppercase tracking-widest flex items-center gap-2">
            <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span> Live Markets
        </span>
        <span>Arabica: <span id="ticker-arabica" class="text-white ml-1">--</span></span>
        <span>Robusta: <span id="ticker-robusta" class="text-white ml-1">--</span></span>
        <span>Brent Crude: <span id="ticker-brent" class="text-rose-300 ml-1">--</span></span>
        <span>USD/ETB: <span id="ticker-usd" class="text-blue-300 ml-1">--</span></span>
    </div>

    <div class="max-w-[1400px] mx-auto p-4 md:p-8">
        
        <div class="flex flex-col md:flex-row justify-between items-start md:items-center pb-6 print-header mb-8 border-b-2 border-slate-200">
            <div class="flex items-center gap-6">
                <div class="bg-white p-2 rounded-2xl shadow-lg border border-slate-100 h-20 w-20 flex items-center justify-center">
                    <!-- Correct official Nefas Silk website logo -->
                    <img src="https://www.nefassilkpaints.com/wp-content/uploads/2023/01/logo.png" alt="NSP Logo" class="object-contain w-full h-full" />
                </div>
                <div>
                    <h1 class="text-3xl md:text-5xl font-black tracking-tighter text-slate-900 uppercase">
                        Nefas Silk <span class="text-transparent bg-clip-text bg-gradient-to-r from-red-600 to-red-800">Intelligence</span>
                    </h1>
                    <p class="text-sm text-slate-500 font-bold uppercase tracking-widest mt-2" id="report-date">Syncing Market Data...</p>
                </div>
            </div>
            <div class="mt-4 md:mt-0 no-print">
                <a href="Nefas_Silk_Morning_Brief.pdf" download class="px-6 py-3 bg-gradient-to-r from-red-700 to-red-900 hover:from-red-800 hover:to-red-950 text-white text-sm font-black rounded-xl shadow-xl shadow-red-900/20 transition-all flex items-center gap-2 uppercase tracking-widest">
                    ⬇ Download PDF
                </a>
            </div>
        </div>

        <div class="flex flex-wrap gap-3 mb-10 w-fit tabs-nav p-1.5 bg-white rounded-2xl shadow-sm border border-slate-200">
            <button onclick="switchTab('tab-exports', this)" class="px-8 py-3 active-tab text-sm font-black rounded-xl tab-btn uppercase tracking-widest">☕ Agro Exports</button>
            <button onclick="switchTab('tab-imports', this)" class="px-8 py-3 inactive-tab text-sm font-black rounded-xl tab-btn uppercase tracking-widest">🏭 Industrial Sourcing</button>
            <button onclick="switchTab('tab-economy', this)" class="px-8 py-3 inactive-tab text-sm font-black rounded-xl tab-btn uppercase tracking-widest">🇪🇹 Economy & Forex</button>
            <button onclick="switchTab('tab-logistics', this)" class="px-8 py-3 inactive-tab text-sm font-black rounded-xl tab-btn uppercase tracking-widest">🚢 Global Logistics</button>
        </div>

        <!-- TAB 1: COFFEE & EXPORTS -->
        <div id="tab-exports" class="tab-content block print:block print:mb-8">
            <div class="grid grid-cols-2 md:grid-cols-4 gap-6 mb-8">
                <div class="bg-white p-6 rounded-3xl border-emerald-500 shadow-2xl data-card avoid-break">
                    <p class="text-xs text-slate-400 font-black uppercase tracking-widest mb-2">NY Arabica (Live)</p>
                    <p class="text-4xl font-black text-slate-900" id="arabica-price">--</p>
                    <div class="mt-4 inline-block px-3 py-1 bg-emerald-100 text-emerald-700 text-[10px] font-black rounded-full uppercase">Global Benchmark</div>
                </div>
                <div class="bg-white p-6 rounded-3xl border-emerald-600 shadow-2xl data-card avoid-break">
                    <p class="text-xs text-slate-400 font-black uppercase tracking-widest mb-2">London Robusta (Live)</p>
                    <p class="text-4xl font-black text-slate-900" id="robusta-price">--</p>
                    <div class="mt-4 inline-block px-3 py-1 bg-emerald-100 text-emerald-700 text-[10px] font-black rounded-full uppercase">Global Benchmark</div>
                </div>
                <div class="bg-white p-6 rounded-3xl border-amber-500 shadow-2xl data-card avoid-break">
                    <p class="text-xs text-slate-400 font-black uppercase tracking-widest mb-2">Soya Beans (Live)</p>
                    <p class="text-4xl font-black text-slate-900" id="soy-price">--</p>
                    <div class="mt-4 inline-block px-3 py-1 bg-amber-100 text-amber-700 text-[10px] font-black rounded-full uppercase">Commodities</div>
                </div>
                <div class="bg-white p-6 rounded-3xl border-orange-500 shadow-2xl data-card avoid-break">
                    <p class="text-xs text-slate-400 font-black uppercase tracking-widest mb-2">Whitish Humera Sesame</p>
                    <p class="text-3xl font-black text-slate-900 mt-1">RMB 10,700 <span class="text-lg text-slate-400">/ MT</span></p>
                    <div class="mt-4 inline-block px-3 py-1 bg-orange-100 text-orange-700 text-[10px] font-black rounded-full uppercase">Qingdao CIF</div>
                </div>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
                <div class="bg-gradient-to-br from-slate-900 to-slate-800 p-8 rounded-3xl shadow-2xl text-white avoid-break relative overflow-hidden">
                    <div class="absolute top-0 right-0 w-40 h-40 bg-emerald-500/20 rounded-full -mr-10 -mt-10 blur-3xl"></div>
                    <h3 class="text-xl font-black uppercase tracking-widest text-emerald-400 mb-6 flex items-center gap-3">
                        <span class="p-2 bg-emerald-400/20 rounded-lg">📋</span> ETCA Directives
                    </h3>
                    <div class="space-y-6">
                        <div>
                            <p class="text-sm font-black text-white mb-2 uppercase tracking-wider">Minimum Export Floor Thresholds</p>
                            <p class="text-sm text-slate-300 leading-relaxed font-medium">Active monitoring in effect. All forward contract registrations require validated certification from the Ethiopian Commodity Exchange (ECX) prior to port dispatch.</p>
                        </div>
                        <div class="pt-6 border-t border-slate-700/50">
                            <p class="text-sm font-black text-white mb-2 uppercase tracking-wider">EUDR Geolocation Compliance</p>
                            <p class="text-sm text-slate-300 leading-relaxed font-medium">Critical deadline approaching. Ensure national traceability synchronization is finalized to clear European customs cordons.</p>
                        </div>
                    </div>
                </div>
                
                <div class="bg-white p-8 rounded-3xl border border-slate-200 shadow-2xl avoid-break">
                    <h3 class="text-xl font-black uppercase tracking-widest text-red-700 mb-6 flex items-center gap-3">
                        <span class="p-2 bg-red-100 rounded-lg">📊</span> Market Intelligence
                    </h3>
                    <div class="space-y-6">
                        <div>
                            <p class="text-sm font-black text-slate-900 mb-2 border-l-4 border-red-500 pl-4 uppercase tracking-wider">Sesame Export Dynamics</p>
                            <p class="text-sm text-slate-600 leading-relaxed pl-5 font-medium">Destination port stocks remain stable in Qingdao. Forward deliveries are strictly prioritized for Grade-A shipments. Q4 pricing matrices require continuous monitoring.</p>
                        </div>
                        <div class="pt-6 border-t border-slate-100">
                            <p class="text-sm font-black text-slate-900 mb-2 border-l-4 border-blue-500 pl-4 uppercase tracking-wider">Soya Bean Supply Chain</p>
                            <p class="text-sm text-slate-600 leading-relaxed pl-5 font-medium">Global harvest yields are exerting downward pressure on futures. Procurement desk advised to evaluate bulk forward contracts for Q1 manufacturing reserves.</p>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- TAB 2: INDUSTRIAL IMPORTS -->
        <div id="tab-imports" class="tab-content hidden print:block print:mb-8 mt-8">
            <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
                <div class="lg:col-span-2 bg-white rounded-3xl border border-slate-200 shadow-2xl overflow-hidden avoid-break">
                    <div class="p-6 bg-slate-50 border-b border-slate-100">
                        <h3 class="text-base font-black text-slate-900 uppercase tracking-widest flex items-center gap-3">
                            <span class="w-3 h-8 bg-blue-600 rounded-full"></span> Raw Material CIF Sourcing
                        </h3>
                    </div>
                    <div class="overflow-x-auto p-2">
                        <table class="w-full text-left text-sm whitespace-nowrap">
                            <thead class="text-xs text-slate-400 uppercase tracking-widest border-b-2 border-slate-100">
                                <tr>
                                    <th class="px-6 py-5 font-black">Category & Material</th>
                                    <th class="px-6 py-5 font-black text-right">Target Price</th>
                                    <th class="px-6 py-5 font-black">Primary Origin</th>
                                </tr>
                            </thead>
                            <tbody class="divide-y divide-slate-50 text-slate-700">
                                <tr class="hover:bg-slate-50 transition-colors">
                                    <td class="px-6 py-5"><p class="font-black text-slate-900 text-base">TiO2 (Rutile Grade)</p><p class="text-xs text-slate-500 mt-1 font-bold">Lomon Billions / Chemours</p></td>
                                    <td class="px-6 py-5 font-black text-slate-900 text-right text-xl text-blue-700">$2,850 <span class="text-xs text-slate-400 font-bold">/ MT</span></td>
                                    <td class="px-6 py-5"><span class="px-4 py-1.5 bg-slate-100 text-slate-600 text-[10px] font-black tracking-widest uppercase rounded-lg">China / UAE</span></td>
                                </tr>
                                <tr class="hover:bg-slate-50 transition-colors">
                                    <td class="px-6 py-5"><p class="font-black text-slate-900 text-base">Acrylic Emulsion</p><p class="text-xs text-slate-500 mt-1 font-bold">SABIC / Dow Chemical</p></td>
                                    <td class="px-6 py-5 font-black text-slate-900 text-right text-xl text-blue-700">$1,250 <span class="text-xs text-slate-400 font-bold">/ MT</span></td>
                                    <td class="px-6 py-5"><span class="px-4 py-1.5 bg-slate-100 text-slate-600 text-[10px] font-black tracking-widest uppercase rounded-lg">Saudi Arabia</span></td>
                                </tr>
                                <tr class="hover:bg-slate-50 transition-colors">
                                    <td class="px-6 py-5"><p class="font-black text-slate-900 text-base">HDPE (Film Grade)</p><p class="text-xs text-slate-500 mt-1 font-bold">Borouge / Sinopec</p></td>
                                    <td class="px-6 py-5 font-black text-slate-900 text-right text-xl text-cyan-700">$1,140 <span class="text-xs text-slate-400 font-bold">/ MT</span></td>
                                    <td class="px-6 py-5"><span class="px-4 py-1.5 bg-slate-100 text-slate-600 text-[10px] font-black tracking-widest uppercase rounded-lg">Middle East</span></td>
                                </tr>
                                <tr class="hover:bg-slate-50 transition-colors">
                                    <td class="px-6 py-5"><p class="font-black text-slate-900 text-base">PVC Resin (SG5)</p><p class="text-xs text-slate-500 mt-1 font-bold">Formosa / LG Chem</p></td>
                                    <td class="px-6 py-5 font-black text-slate-900 text-right text-xl text-cyan-700">$890 <span class="text-xs text-slate-400 font-bold">/ MT</span></td>
                                    <td class="px-6 py-5"><span class="px-4 py-1.5 bg-slate-100 text-slate-600 text-[10px] font-black tracking-widest uppercase rounded-lg">Taiwan / S. Korea</span></td>
                                </tr>
                                <tr class="hover:bg-slate-50 transition-colors">
                                    <td class="px-6 py-5"><p class="font-black text-slate-900 text-base">Truck Tyres (315/80R22.5)</p><p class="text-xs text-slate-500 mt-1 font-bold">Apollo / MRF / Triangle</p></td>
                                    <td class="px-6 py-5 font-black text-slate-900 text-right text-xl text-slate-700">$210 <span class="text-xs text-slate-400 font-bold">/ PC</span></td>
                                    <td class="px-6 py-5"><span class="px-4 py-1.5 bg-slate-100 text-slate-600 text-[10px] font-black tracking-widest uppercase rounded-lg">India / China</span></td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </div>

                <div class="bg-white p-8 rounded-3xl border border-slate-200 shadow-2xl avoid-break flex flex-col">
                    <h3 class="text-base font-black text-slate-900 mb-6 uppercase tracking-widest">Procurement Alerts</h3>
                    
                    <div class="mb-8 p-6 bg-gradient-to-br from-indigo-900 to-indigo-950 rounded-2xl text-white shadow-xl relative overflow-hidden">
                        <div class="absolute top-0 right-0 w-32 h-32 bg-white/10 rounded-full -mr-10 -mt-10 blur-2xl"></div>
                        <p class="text-xs font-black text-indigo-300 uppercase tracking-widest mb-2">Raw Rubber (RSS3)</p>
                        <p class="text-5xl font-black text-white tracking-tighter" id="rubber-price">--</p>
                        <p class="text-xs text-indigo-200 mt-4 font-bold">Leading indicator for commercial fleet tyre costs.</p>
                    </div>

                    <div class="flex-grow space-y-4">
                        <div class="p-5 bg-red-50 rounded-2xl border border-red-100">
                            <p class="text-sm font-black text-red-900 mb-1 uppercase tracking-wide">Fleet Restocking</p>
                            <p class="text-xs text-red-700 font-medium leading-relaxed">Indian manufacturers indicating immediate cost pressures on natural rubber supplies.</p>
                        </div>
                        <div class="p-5 bg-blue-50 rounded-2xl border border-blue-100">
                            <p class="text-sm font-black text-blue-900 mb-1 uppercase tracking-wide">Chemical Inputs</p>
                            <p class="text-xs text-blue-700 font-medium leading-relaxed">Titanium Dioxide prioritized strictly under Franco-Valuta frameworks.</p>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- TAB 3: ETHIOPIAN ECONOMY -->
        <div id="tab-economy" class="tab-content hidden print:block print:mb-8 mt-8">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
                
                <div class="bg-white p-8 rounded-3xl border border-slate-200 shadow-2xl avoid-break">
                    <h3 class="text-base font-black text-slate-900 mb-6 uppercase tracking-widest flex items-center gap-3">
                        <span class="w-3 h-8 bg-purple-600 rounded-full"></span> Forex Matrix (ETB)
                    </h3>
                    <div class="space-y-4">
                        <div class="flex justify-between items-center p-5 border border-slate-100 rounded-2xl bg-slate-50 hover:shadow-lg transition-shadow">
                            <div class="flex items-center gap-5">
                                <div class="w-12 h-12 rounded-full bg-white shadow-sm flex items-center justify-center text-2xl border border-slate-100">🇺🇸</div>
                                <div><p class="font-black text-slate-900 text-lg">USD</p><p class="text-xs text-slate-400 uppercase font-bold tracking-widest">US Dollar</p></div>
                            </div>
                            <span class="text-3xl font-black text-slate-900" id="fx-usd">--</span>
                        </div>
                        <div class="flex justify-between items-center p-5 border border-slate-100 rounded-2xl bg-slate-50 hover:shadow-lg transition-shadow">
                            <div class="flex items-center gap-5">
                                <div class="w-12 h-12 rounded-full bg-white shadow-sm flex items-center justify-center text-2xl border border-slate-100">🇪🇺</div>
                                <div><p class="font-black text-slate-900 text-lg">EUR</p><p class="text-xs text-slate-400 uppercase font-bold tracking-widest">Euro</p></div>
                            </div>
                            <span class="text-3xl font-black text-slate-900" id="fx-eur">--</span>
                        </div>
                        <div class="flex justify-between items-center p-5 border border-slate-100 rounded-2xl bg-slate-50 hover:shadow-lg transition-shadow">
                            <div class="flex items-center gap-5">
                                <div class="w-12 h-12 rounded-full bg-white shadow-sm flex items-center justify-center text-2xl border border-slate-100">🇬🇧</div>
                                <div><p class="font-black text-slate-900 text-lg">GBP</p><p class="text-xs text-slate-400 uppercase font-bold tracking-widest">British Pound</p></div>
                            </div>
                            <span class="text-3xl font-black text-slate-900" id="fx-gbp">--</span>
                        </div>
                        <div class="flex justify-between items-center p-5 border border-slate-100 rounded-2xl bg-slate-50 hover:shadow-lg transition-shadow">
                            <div class="flex items-center gap-5">
                                <div class="w-12 h-12 rounded-full bg-white shadow-sm flex items-center justify-center text-2xl border border-slate-100">🇦🇪</div>
                                <div><p class="font-black text-slate-900 text-lg">AED</p><p class="text-xs text-slate-400 uppercase font-bold tracking-widest">UAE Dirham</p></div>
                            </div>
                            <span class="text-3xl font-black text-slate-900" id="fx-aed">--</span>
                        </div>
                    </div>
                </div>

                <div class="bg-white p-8 rounded-3xl border border-slate-200 shadow-2xl avoid-break">
                    <h3 class="text-base font-black text-slate-900 mb-6 uppercase tracking-widest flex items-center gap-3">
                        <span class="w-3 h-8 bg-slate-800 rounded-full"></span> State Directives
                    </h3>
                    <div class="space-y-6">
                        <div class="p-6 bg-slate-50 border border-slate-100 rounded-2xl">
                            <p class="font-black text-slate-900 text-sm uppercase tracking-widest mb-2">Franco-Valuta Guidelines</p>
                            <p class="text-sm text-slate-600 font-medium leading-relaxed">MoTRI confirms essential manufacturing inputs retain priority clearance channels without central allocation queues.</p>
                        </div>
                        <div class="p-6 bg-slate-50 border border-slate-100 rounded-2xl">
                            <p class="font-black text-slate-900 text-sm uppercase tracking-widest mb-2">Export Retention Directives</p>
                            <p class="text-sm text-slate-600 font-medium leading-relaxed">Agro exporters maintain authorized 30-day foreign exchange retention windows for dedicated raw-material imports.</p>
                        </div>
                        <div class="p-6 bg-slate-50 border border-slate-100 rounded-2xl">
                            <p class="font-black text-slate-900 text-sm uppercase tracking-widest mb-2">Industrial Park Exemptions</p>
                            <p class="text-sm text-slate-600 font-medium leading-relaxed">Raw plastic polymers and capital machinery imports continue under designated manufacturing incentives.</p>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- TAB 4: GLOBAL LOGISTICS & SHIPPING -->
        <div id="tab-logistics" class="tab-content hidden print:block print:mb-8 mt-8">
            <div class="grid grid-cols-1 lg:grid-cols-2 gap-8">
                <div class="bg-white p-8 rounded-3xl border border-slate-200 shadow-2xl avoid-break">
                    <h3 class="text-base font-black text-slate-900 mb-6 uppercase tracking-widest flex items-center gap-3">
                        <span class="w-3 h-8 bg-red-600 rounded-full"></span> Carrier Status & Logistics
                    </h3>
                    
                    <div class="space-y-5">
                        <div class="p-6 border border-slate-200 rounded-2xl bg-slate-50 shadow-inner">
                            <p class="text-xs font-black text-slate-400 uppercase tracking-widest mb-5">Major Carrier Routes</p>
                            <div class="space-y-4">
                                <div class="flex justify-between items-center border-b border-slate-200 pb-4">
                                    <strong class="text-slate-900 font-black text-base">MSC</strong>
                                    <span class="bg-rose-100 text-rose-700 px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest">Cape Reroute (+14D)</span>
                                </div>
                                <div class="flex justify-between items-center border-b border-slate-200 pb-4">
                                    <strong class="text-slate-900 font-black text-base">Maersk</strong>
                                    <span class="bg-rose-100 text-rose-700 px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest">Cape Reroute (+14D)</span>
                                </div>
                                <div class="flex justify-between items-center border-b border-slate-200 pb-4">
                                    <strong class="text-slate-900 font-black text-base">CMA CGM</strong>
                                    <span class="bg-amber-100 text-amber-700 px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest">Selective Transits</span>
                                </div>
                                <div class="flex justify-between items-center">
                                    <strong class="text-slate-900 font-black text-base">ESL (Ethiopian)</strong>
                                    <span class="bg-emerald-100 text-emerald-700 px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest">Normal Schedules</span>
                                </div>
                            </div>
                        </div>
                        
                        <div class="flex justify-between items-center p-6 border border-slate-100 rounded-2xl bg-white shadow-sm">
                            <div>
                                <p class="text-base font-black text-slate-900">Port of Djibouti (SGTD)</p>
                                <p class="text-xs text-slate-500 mt-1 font-bold">Berth congestion averaging 3-5 days</p>
                            </div>
                            <span class="px-5 py-2 bg-emerald-100 text-emerald-700 text-[10px] font-black rounded-lg uppercase tracking-widest">Operational</span>
                        </div>
                        
                        <div class="flex justify-between items-center p-6 border border-slate-100 rounded-2xl bg-white shadow-sm">
                            <div>
                                <p class="text-base font-black text-slate-900">Djibouti-Addis Rail Corridor</p>
                                <p class="text-xs text-slate-500 mt-1 font-bold">Recommended for bulk chemical cargo</p>
                            </div>
                            <span class="px-5 py-2 bg-emerald-100 text-emerald-700 text-[10px] font-black rounded-lg uppercase tracking-widest">Clear</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>

    </div>

    <!-- Script Logic -->
    <script>
        function switchTab(tabId, btnElement) {
            document.querySelectorAll('.tab-content').forEach(el => { 
                el.classList.remove('block'); 
                el.classList.add('hidden'); 
            });
            document.querySelectorAll('.tab-btn').forEach(btn => { 
                btn.classList.remove('active-tab'); 
                btn.classList.add('inactive-tab'); 
            });
            document.getElementById(tabId).classList.remove('hidden'); 
            document.getElementById(tabId).classList.add('block');
            btnElement.classList.remove('inactive-tab'); 
            btnElement.classList.add('active-tab');
        }

        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                const id = mutation.target.id;
                if(id === 'arabica-price') document.getElementById('ticker-arabica').innerText = mutation.target.innerText;
                if(id === 'robusta-price') document.getElementById('ticker-robusta').innerText = mutation.target.innerText;
                if(id === 'brent-price') document.getElementById('ticker-brent').innerText = mutation.target.innerText;
                if(id === 'fx-usd') document.getElementById('ticker-usd').innerText = mutation.target.innerText;
            });
        });

        const config = { childList: true, characterData: true, subtree: true };
        ['arabica-price', 'robusta-price', 'brent-price', 'fx-usd'].forEach(id => {
            const el = document.getElementById(id);
            if(el) observer.observe(el, config);
        });
    </script>
</body>
</html>
