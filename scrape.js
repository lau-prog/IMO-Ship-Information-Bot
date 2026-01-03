const puppeteer = require('puppeteer-core');

const shipName = process.argv[2]; 
const GISIS_USERNAME = process.env.GISIS_USERNAME;
const GISIS_PASSWORD = process.env.GISIS_PASSWORD;

if (!shipName) {
  console.log(JSON.stringify({ success: false, message: "No ship name provided" }));
  process.exit(1);
}

async function scrape() {
  let browser;
  try {
    const launchArgs = JSON.stringify({
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-setuid-sandbox']
    });
    
    browser = await puppeteer.connect({
        browserWSEndpoint: `ws://chrome:3000?launch=${launchArgs}&timeout=120000&keepAlive=true`
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(60000); 

    await page.setRequestInterception(true);
    page.on('request', (req) => {
        if (['image', 'media', 'font'].includes(req.resourceType())) req.abort();
        else req.continue();
    });

    // --- LOGIN ---
    console.error("Debug: Navigating to Login...");
    await page.goto('https://webaccounts.imo.org/Common/WebLogin.aspx', { waitUntil: 'domcontentloaded' });
    
    const authType = await page.$('[id$="ddlAuthorityType"]');
    if (authType) await authType.select('PUBLIC');
    await page.waitForTimeout(500);

    await page.type('input[id$="txtUsername"]', GISIS_USERNAME);
    
    const step1Btn = await page.$('input[id$="btnStep1"]');
    if (step1Btn) {
        await Promise.all([
            step1Btn.click(),
            page.waitForResponse(res => res.status() === 200, {timeout: 5000}).catch(() => {})
        ]);
    } else {
        await page.keyboard.press('Enter');
    }

    await page.waitForSelector('input[id$="txtPassword"]', { visible: true, timeout: 15000 });
    await page.type('input[id$="txtPassword"]', GISIS_PASSWORD);
    await page.waitForTimeout(500);

    const loginBtn = await page.$('input[id$="btnLogin"]') || await page.$('input[value="Login"]');
    const navigationPromise = page.waitForFunction(() => !location.href.includes('WebLogin.aspx'), { timeout: 30000 });
    
    if (loginBtn) {
        await loginBtn.click();
    } else {
        await page.keyboard.press('Enter');
    }

    try {
        await navigationPromise;
        console.error("Debug: Login successful.");
    } catch (e) {
        throw new Error("Login Stuck.");
    }

    console.error("Debug: Navigate to Ship Search...");
    await page.goto('https://gisis.imo.org/Public/SHIPS/Default.aspx', { waitUntil: 'domcontentloaded', timeout: 60000 });

    // --- SEARCH ---
    console.error(`Debug: Searching for ${shipName}...`);
    const searchInputSelector = 'input[id$="tbxShipName"]';
    await page.waitForSelector(searchInputSelector, { visible: true, timeout: 30000 });
    await page.type(searchInputSelector, shipName);
    await page.click('input[id$="btnSearchShips"]');
    
    // --- RESULT GRID ---
    console.error("Debug: Waiting for Results...");
    const gridSelector = 'table[id$="gridShips"]';
    try {
        await page.waitForSelector(gridSelector, { visible: true, timeout: 20000 });
    } catch(e) {
        await browser.disconnect();
        return { success: false, message: `No ships found for ${shipName}` };
    }

    // --- NAVIGATE TO DETAILS ---
    console.error("Debug: Opening Details Page...");
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
        page.evaluate(() => {
            const row = document.querySelector('table[id$="gridShips"] tr.gridviewer_row');
            if (row) {
                const event = new MouseEvent('mouseup', { view: window, bubbles: true, cancelable: true });
                row.dispatchEvent(event);
            }
        })
    ]);

    // --- EXTRACT FULL DETAILS ---
    console.error("Debug: Extracting Complete Particulars...");
    // Wait for the specific ID we know exists
    await page.waitForSelector('[id$="sNameCur"]', { timeout: 30000 }).catch(() => null);

    const fullData = await page.evaluate(() => {
        // 🟢 FIX 1: Use 's...Cur' IDs by default (matches your HTML)
        const getText = (id) => document.querySelector(`[id$="${id}"]`)?.textContent.trim() || 'N/A';
        
        // 🟢 FIX 2: Enhanced Cell finder for "Call sign" etc.
        const getCell = (keyText) => {
            // Find any element containing the text (e.g. "Call sign:")
            const allElements = Array.from(document.querySelectorAll('td, span'));
            const label = allElements.find(el => el.textContent.includes(keyText));
            if (!label) return 'N/A';
            
            // Scenario A: Value is in the next <td> (Standard Table)
            if (label.nextElementSibling) {
                return label.nextElementSibling.textContent.trim();
            }
            // Scenario B: Label is inside a <td>, value is in the parent's next <td>
            if (label.parentElement && label.parentElement.nextElementSibling) {
                return label.parentElement.nextElementSibling.textContent.trim();
            }
            return 'N/A';
        };

        const getTableValue = (tableId, keyText) => {
            const table = document.querySelector(`[id$="${tableId}"]`);
            if (!table) return 'N/A';
            const cells = Array.from(table.querySelectorAll('td'));
            const labelCell = cells.find(td => td.textContent.includes(keyText));
            if (labelCell && labelCell.nextElementSibling) {
                return labelCell.nextElementSibling.textContent.trim();
            }
            return 'N/A';
        };

        const getHistoryList = (tableId) => {
            const table = document.querySelector(`[id$="${tableId}"]`);
            if (!table) return [];
            return Array.from(table.querySelectorAll('tr')).map(tr => {
                return tr.textContent.replace(/\s\s+/g, ' ').trim();
            }).filter(text => text.length > 0);
        };

        return {
            // 🟢 FIX 3: Mapped explicitly to 's...Cur' IDs
            name: getText('sNameCur'),
            imo: document.body.innerText.match(/IMO\s+(\d{7})/)?.[1] || 'N/A',
            callSign: getCell('Call sign'),
            mmsi: getCell('MMSI'),
            flag: getText('sFlagCur'),
            type: getText('sTypeCur'),
            grossTonnage: getCell('Gross tonnage'),
            buildDate: getText('sBuildDateCur'),
            
            ownerName: getText('sRegOwnerCur'),
            
            ownerDetails: {
                imoNumber: getTableValue('sRegOwnerHistory', 'IMO Company Number'),
                nationality: getTableValue('sRegOwnerHistory', 'Nationality'),
                address: getTableValue('sRegOwnerHistory', 'Address'),
                status: getTableValue('sRegOwnerHistory', 'Company status')
            },

            history: {
                names: getHistoryList('sNameHistory'),
                flags: getHistoryList('sFlagHistory'),
                types: getHistoryList('sTypeHistory')
            }
        };
    });

    await browser.disconnect();
    return { success: true, data: fullData };

  } catch (error) {
    console.error("Scraping Error:", error.message);
    if (browser) await browser.disconnect();
    return { success: false, message: error.message };
  }
}

scrape().then(result => {
    console.log(JSON.stringify(result, null, 2));
});