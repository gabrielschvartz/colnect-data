const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://colnect.com';
const TARGETS = [
    { url: '/es/coins/currencies', file: 'denominaciones.csv', key: 'DENOMINACIONES' },
    { url: '/es/coins/compositions', file: 'material.csv', key: 'MATERIAL' },
    { url: '/es/coins/face_values', file: 'valor_facial.csv', key: 'VALOR_FACIAL' },
    { url: '/es/coins/countries', file: 'paises.csv', key: 'PAISES' }
];

// NUEVA LÓGICA: Solo eliminamos desde el paréntesis de apertura en adelante.
// Conserva guiones, símbolos de moneda y nombres compuestos completos.
const cleanName = (text) => {
    return text.split('(')[0].trim();
};

const extractExpectedCount = (html) => {
    const $ = cheerio.load(html);
    const bodyText = $('body').text();
    const match = bodyText.match(/Mostrando.*?([\d.,]+)(?:\s*[a-zA-ZáéíóúÁÉÍÓÚñÑ]+)?$/m) || bodyText.match(/Mostrando.*?([\d.,]+)/i);
    return match && match[1] ? parseInt(match[1].replace(/[.,]/g, ''), 10) : 0;
};

async function scrapeData() {
    let newCounts = {};
    let allSuccess = true;

    console.log("Iniciando navegador Chrome fantasma...");
    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 768 });

    for (const target of TARGETS) {
        try {
            console.log(`\nNavegando a: ${target.url}...`);
            await page.goto(BASE_URL + target.url, { waitUntil: 'networkidle2', timeout: 60000 });
            
            await new Promise(r => setTimeout(r, 3000));
            
            await page.evaluate(async () => {
                await new Promise((resolve) => {
                    let totalHeight = 0;
                    let distance = 200;
                    let timer = setInterval(() => {
                        let scrollHeight = document.body.scrollHeight;
                        window.scrollBy(0, distance);
                        totalHeight += distance;
                        if(totalHeight >= scrollHeight - window.innerHeight){
                            clearInterval(timer);
                            resolve();
                        }
                    }, 50);
                });
            });

            await new Promise(r => setTimeout(r, 2000));
            
            const html = await page.content();
            const $ = cheerio.load(html);
            
            let records = [];
            
            $('a').each((index, element) => {
                const relativeUrl = $(element).attr('href');
                const rawName = $(element).text().trim();
                
                if (relativeUrl && relativeUrl.includes('/es/coins/list/')) {
                    const clean = cleanName(rawName);
                    
                    if (clean.length > 1 && !clean.toLowerCase().includes('mostrando') && !records.find(r => r.name === clean)) {
                        records.push({ name: clean, url: BASE_URL + relativeUrl });
                    }
                }
            });

            const expectedCount = extractExpectedCount(html);
            console.log(`-> Registros obtenidos: ${records.length} | Esperados: ${expectedCount}`);

            if (records.length === 0) {
                console.error(`⚠️ No se encontraron registros.`);
                allSuccess = false;
                continue;
            }

            let csvContent = 'Nombre,URL\n';
            records.forEach(record => {
                csvContent += `"${record.name}","${record.url}"\n`;
            });

            fs.writeFileSync(path.join(__dirname, target.file), csvContent, 'utf8');
            console.log(`-> Archivo ${target.file} guardado con éxito.`);
            
            newCounts[target.key] = records.length;

        } catch (error) {
            console.error(`❌ Error al obtener ${target.url}:`, error.message);
            allSuccess = false;
        }
    }

    await browser.close();

    if (allSuccess) {
        updateVersionFile(newCounts);
    } else {
        console.log("\n⚠️ Hubo errores. No se actualizará version.txt completamente.");
    }
}

function updateVersionFile(newCounts) {
    const versionPath = path.join(__dirname, 'version.txt');
    let version = '1.0.0'; 
    let oldCounts = {};

    if (fs.existsSync(versionPath)) {
        const content = fs.readFileSync(versionPath, 'utf8').split('\n');
        content.forEach(line => {
            if (line.startsWith('VERSION =')) {
                version = line.split('=')[1].trim();
            } else if (line.includes('=')) {
                const [key, val] = line.split('=');
                oldCounts[key.trim()] = parseInt(val.trim(), 10);
            }
        });
    }

    let hasChanged = false;
    for (const key of Object.keys(newCounts)) {
        if (oldCounts[key] !== newCounts[key]) {
            hasChanged = true;
            break;
        }
    }

    if (hasChanged) {
        let parts = version.split('.');
        parts[2] = parseInt(parts[2], 10) + 1;
        version = parts.join('.');
        console.log(`\n🔄 Se detectaron cambios reales en las cantidades. Nueva versión: ${version}`);
    } else {
        console.log(`\n✅ No hay cambios en las cantidades. Se mantiene la versión: ${version}`);
    }

    let newVersionContent = `VERSION = ${version}\n`;
    for (const key in newCounts) {
        newVersionContent += `${key} = ${newCounts[key]}\n`;
    }

    fs.writeFileSync(versionPath, newVersionContent, 'utf8');
}

scrapeData();