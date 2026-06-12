const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://colnect.com';

// 1. Regex específico para cada categoría. Garantiza capturar las URLs reales de la grilla y descartar menús basura.
const TARGETS = [
    { url: '/es/coins/currencies', file: 'denominaciones.csv', key: 'DENOMINACIONES', regex: /\/es\/coins\/(list\/)?currency\//i },
    { url: '/es/coins/compositions', file: 'material.csv', key: 'MATERIAL', regex: /\/es\/coins\/(list\/)?composition\//i },
    { url: '/es/coins/face_values', file: 'valor_facial.csv', key: 'VALOR_FACIAL', regex: /\/es\/coins\/(list\/)?face_value\//i },
    { url: '/es/coins/countries', file: 'paises.csv', key: 'PAISES', regex: /\/es\/coins\/(list\/)?country\//i }
];

const cleanName = (text) => text.split('(')[0].trim();

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
            console.log(`\n=========================================`);
            console.log(`Iniciando extracción de: ${target.key}`);
            
            let records = [];
            let currentPageUrl = BASE_URL + target.url;
            let hasNextPage = true;
            let expectedCount = 0;
            let pageNum = 1;

            // 2. BUCLE DE PAGINACIÓN: Sigue buscando mientras exista el botón de siguiente
            while (hasNextPage) {
                console.log(` -> Escaneando página ${pageNum} (${currentPageUrl})...`);
                await page.goto(currentPageUrl, { waitUntil: 'networkidle2', timeout: 60000 });
                
                await new Promise(r => setTimeout(r, 2000));
                
                await page.evaluate(async () => {
                    await new Promise((resolve) => {
                        let lastHeight = 0;
                        let retries = 0;
                        let timer = setInterval(() => {
                            window.scrollBy(0, 800);
                            let currentHeight = document.body.scrollHeight;
                            if (currentHeight === lastHeight) {
                                retries++;
                                if (retries >= 4) {
                                    clearInterval(timer);
                                    resolve();
                                }
                            } else {
                                lastHeight = currentHeight;
                                retries = 0;
                            }
                        }, 500);
                    });
                });

                const html = await page.content();
                const $ = cheerio.load(html);
                
                if (pageNum === 1) {
                    expectedCount = extractExpectedCount(html);
                    console.log(` -> Colnect indica que hay ${expectedCount} registros en total.`);
                }
                
                $('a').each((index, element) => {
                    const relativeUrl = $(element).attr('href');
                    const rawName = $(element).text().trim();
                    
                    if (relativeUrl && relativeUrl.match(target.regex)) {
                        const clean = cleanName(rawName);
                        if (clean.length > 1 && !clean.toLowerCase().includes('mostrando') && !records.find(r => r.name === clean)) {
                            // Validar que no se metan botones sueltos de navegación
                            if (!clean.includes('Siguiente') && !clean.includes('Anterior') && clean !== '»' && clean !== '«') {
                                records.push({ name: clean, url: BASE_URL + relativeUrl });
                            }
                        }
                    }
                });

                // 3. DETECTAR EL BOTÓN DE "SIGUIENTE"
                const nextHref = await page.evaluate(() => {
                    let links = Array.from(document.querySelectorAll('a'));
                    let nextLink = links.find(el => {
                        let text = el.textContent.trim();
                        return el.classList.contains('next') || el.classList.contains('pages_next') || text === '»' || text.includes('Siguiente ›');
                    });

                    // Verifica que Colnect no lo haya marcado como inactivo (fin de lista)
                    if (nextLink && !nextLink.parentElement.classList.contains('inactive')) {
                        return nextLink.getAttribute('href');
                    }
                    return null;
                });

                if (nextHref) {
                    currentPageUrl = nextHref.startsWith('http') ? nextHref : BASE_URL + nextHref;
                    pageNum++;
                    await new Promise(r => setTimeout(r, 2000));
                } else {
                    hasNextPage = false;
                }
            }

            console.log(`✅ Finalizado ${target.key}: ${records.length} obtenidos de ${expectedCount} esperados.`);

            if (records.length === 0) {
                console.error(`⚠️ No se obtuvieron registros.`);
                allSuccess = false;
                continue;
            }

            let csvContent = 'Nombre,URL\n';
            records.forEach(record => {
                csvContent += `"${record.name}","${record.url}"\n`;
            });

            fs.writeFileSync(path.join(__dirname, target.file), csvContent, 'utf8');
            newCounts[target.key] = records.length;

        } catch (error) {
            console.error(`❌ Error en ${target.url}:`, error.message);
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
        console.log(`\n🔄 Actualización exitosa. Nueva versión: ${version}`);
    } else {
        console.log(`\n✅ Archivos idénticos a la versión anterior (${version}).`);
    }

    let newVersionContent = `VERSION = ${version}\n`;
    for (const key in newCounts) {
        newVersionContent += `${key} = ${newCounts[key]}\n`;
    }

    fs.writeFileSync(versionPath, newVersionContent, 'utf8');
}

scrapeData();