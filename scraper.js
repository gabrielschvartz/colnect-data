const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://colnect.com';

const TARGETS = [
    { url: '/es/coins/currencies', file: 'denominaciones.csv', key: 'DENOMINACIONES', splitKey: '/currency/' },
    { url: '/es/coins/compositions', file: 'material.csv', key: 'MATERIAL', splitKey: '/composition/' },
    { url: '/es/coins/face_values', file: 'valor_facial.csv', key: 'VALOR_FACIAL', splitKey: '/face_value/' },
    { url: '/es/coins/countries', file: 'paises.csv', key: 'PAISES', splitKey: '/country/' }
];

// Función para leer el estado actual del version.txt
function readLocalVersion() {
    const versionPath = path.join(__dirname, 'version.txt');
    let data = { version: '1.0.0', counts: {} };

    if (fs.existsSync(versionPath)) {
        const content = fs.readFileSync(versionPath, 'utf8').split('\n');
        content.forEach(line => {
            if (line.startsWith('VERSION =')) {
                data.version = line.split('=')[1].trim();
            } else if (line.includes('=')) {
                const [key, val] = line.split('=');
                data.counts[key.trim()] = parseInt(val.trim(), 10);
            }
        });
    }
    return data;
}

async function scrapeData() {
    const localData = readLocalVersion();
    let oldCounts = localData.counts;
    let currentVersion = localData.version;
    
    // Clonamos los contadores antiguos
    let newCounts = { ...oldCounts }; 
    let hasGlobalChanges = false;
    let allSuccess = true;

    console.log(`Iniciando vigía de Colnect. Versión actual: ${currentVersion}`);
    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 768 });

    for (const target of TARGETS) {
        try {
            console.log(`\n=========================================`);
            console.log(`Revisando estado de: ${target.key}`);
            
            let currentPageUrl = BASE_URL + target.url;
            await page.goto(currentPageUrl, { waitUntil: 'networkidle2', timeout: 60000 });
            await new Promise(r => setTimeout(r, 2000));
            
            // PASO 1: Extraer SOLO el contador oficial "Mostrando X"
            const expectedCount = await page.evaluate(() => {
                let text = document.body.innerText;
                let match = text.match(/Mostrando[^\d]*\d+[^\d]*de\s+([\d.,]+)/i) || text.match(/Mostrando[^\d]*([\d.,]+)/i);
                return match && match[1] ? parseInt(match[1].replace(/[.,]/g, ''), 10) : 0;
            });

            const localCount = oldCounts[target.key] || 0;
            console.log(` -> Colnect reporta: ${expectedCount} | Archivo local tiene: ${localCount}`);

            // PASO 2: Comparación delta
            if (expectedCount > 0 && expectedCount === localCount) {
                console.log(`✅ Cantidades idénticas. Se omite la descarga de ${target.key} para ahorrar recursos.`);
                continue; 
            }

            // PASO 3: Scraping profundo
            console.log(`🔄 Diferencia detectada. Iniciando scraping profundo para actualizar ${target.file}...`);
            hasGlobalChanges = true;
            
            let allRecordsMap = new Map();
            let pageNum = 1;
            let keepPaginating = true;

            while (keepPaginating) {
                let loopUrl = BASE_URL + target.url + (pageNum > 1 ? `/page/${pageNum}` : '');
                console.log(`   -> Extrayendo datos de página ${pageNum}...`);
                
                if (pageNum > 1) { 
                    await page.goto(loopUrl, { waitUntil: 'networkidle2', timeout: 60000 });
                    await new Promise(r => setTimeout(r, 2000));
                }
                
                // Pasamos tanto el splitKey como el targetKey al navegador
                const pageData = await page.evaluate((splitKey, targetKey) => {
                    let resultados = [];
                    
                    // NUEVA LÓGICA DE NORMALIZACIÓN (Diccionario Unicode a Texto Plano)
                    const fractionMap = {
                        '½': '1/2', '⅓': '1/3', '⅔': '2/3', '¼': '1/4', '¾': '3/4',
                        '⅕': '1/5', '⅖': '2/5', '⅗': '3/5', '⅘': '4/5', '⅙': '1/6',
                        '⅚': '5/6', '⅛': '1/8', '⅜': '3/8', '⅝': '5/8', '⅞': '7/8',
                        '⁄': '/' // Intercepta la barra especial de Colnect
                    };

                    document.querySelectorAll('a').forEach(enlace => {
                        let url = enlace.href;
                        if (url.includes(splitKey) && !url.includes('/page/')) {
                            let textoOriginal = enlace.innerText.trim().replace(/\n/g, ' ');
                            let textoLimpio = textoOriginal.replace(/\s*\([^)]*\)$/, '').trim();
                            
                            // APLICACIÓN DEL FILTRO SOLO A VALOR FACIAL
                            if (targetKey === 'VALOR_FACIAL') {
                                textoLimpio = textoLimpio.replace(/[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞⁄]/g, match => fractionMap[match]);
                            }

                            let fragmentoUrl = url.split(splitKey)[1];
                            
                            if (fragmentoUrl && textoLimpio !== "") {
                                fragmentoUrl = fragmentoUrl.split(/[?#]/)[0];
                                if (!fragmentoUrl.includes('/')) {
                                    resultados.push({ name: textoLimpio, url: url.split(/[?#]/)[0] });
                                }
                            }
                        }
                    });
                    return resultados;
                }, target.splitKey, target.key);

                let newItemsFound = 0;
                for (const item of pageData) {
                    if (!allRecordsMap.has(item.url)) {
                        allRecordsMap.set(item.url, item);
                        newItemsFound++;
                    }
                }

                if (newItemsFound === 0) {
                    keepPaginating = false;
                } else {
                    pageNum++;
                }
            }

            const finalRecords = Array.from(allRecordsMap.values());
            console.log(`✅ Extracción de ${target.key} completada. ${finalRecords.length} ítems guardados.`);

            // Guardar el nuevo CSV sin la primera línea de cabecera
            let csvContent = '';
            finalRecords.forEach(record => {
                csvContent += `"${record.name}","${record.url}"\n`;
            });
            fs.writeFileSync(path.join(__dirname, target.file), csvContent, 'utf8');
            
            newCounts[target.key] = expectedCount;

        } catch (error) {
            console.error(`❌ Error al procesar ${target.url}:`, error.message);
            allSuccess = false;
        }
    }

    await browser.close();

    // PASO 4: Actualizar version.txt
    if (hasGlobalChanges && allSuccess) {
        let parts = currentVersion.split('.');
        parts[2] = parseInt(parts[2], 10) + 1;
        let newVersion = parts.join('.');
        
        console.log(`\n=========================================`);
        console.log(`🔄 Se actualizaron bases de datos. Incrementando versión a ${newVersion}`);
        
        let newVersionContent = `VERSION = ${newVersion}\n`;
        for (const key in newCounts) {
            newVersionContent += `${key} = ${newCounts[key]}\n`;
        }
        fs.writeFileSync(path.join(__dirname, 'version.txt'), newVersionContent, 'utf8');
    } else if (!hasGlobalChanges) {
        console.log(`\n=========================================`);
        console.log(`✅ Proceso finalizado sin novedades en Colnect. Mantenemos versión ${currentVersion}`);
    }
}

scrapeData();