const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

// Configuración base
const BASE_URL = 'https://colnect.com';
const TARGETS = [
    { url: '/es/coins/currencies', file: 'denominaciones.csv', key: 'DENOMINACIONES' },
    { url: '/es/coins/compositions', file: 'material.csv', key: 'MATERIAL' },
    { url: '/es/coins/face_values', file: 'valor_facial.csv', key: 'VALOR_FACIAL' },
    { url: '/es/coins/countries', file: 'paises.csv', key: 'PAISES' }
];

// Cabeceras para simular un navegador real y evitar bloqueos básicos
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
    'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
};

// Función para limpiar el nombre (elimina desde el primer guion o paréntesis en adelante)
const cleanName = (text) => {
    return text.split(/[-–(]/)[0].trim();
};

// Extraer el número total esperado del texto "Mostrando..."
const extractExpectedCount = (html) => {
    const $ = cheerio.load(html);
    const bodyText = $('body').text();
    // Busca "Mostrando [numero]" o "Mostrando X a Y de [numero]"
    const match = bodyText.match(/Mostrando.*?([\d.,]+)(?:\s*[a-zA-ZáéíóúÁÉÍÓÚñÑ]+)?$/m) || bodyText.match(/Mostrando.*?([\d.,]+)/i);
    if (match && match[1]) {
        return parseInt(match[1].replace(/[.,]/g, ''), 10);
    }
    return 0;
};

// Función principal de Scraping
async function scrapeData() {
    let newCounts = {};
    let allSuccess = true;

    for (const target of TARGETS) {
        try {
            console.log(`\nObteniendo datos de: ${target.url}...`);
            const response = await axios.get(BASE_URL + target.url, { headers: HEADERS });
            const $ = cheerio.load(response.data);
            
            let records = [];
            
            // Colnect usa enlaces que contienen "/es/coins/list/" para las categorías
            $('a[href^="/es/coins/list/"]').each((index, element) => {
                const rawName = $(element).text().trim();
                const relativeUrl = $(element).attr('href');
                
                if (rawName && relativeUrl) {
                    const clean = cleanName(rawName);
                    // Evitamos duplicados y textos vacíos
                    if (clean.length > 0 && !records.find(r => r.url === relativeUrl)) {
                        records.push({ name: clean, url: BASE_URL + relativeUrl });
                    }
                }
            });

            const expectedCount = extractExpectedCount(response.data);
            console.log(`-> Registros obtenidos: ${records.length} | Esperados (según página): ${expectedCount || 'No detectado'}`);

            // Crear el archivo CSV
            let csvContent = 'Nombre,URL\n';
            records.forEach(record => {
                // Se envuelve el nombre en comillas por si contiene comas
                csvContent += `"${record.name}","${record.url}"\n`;
            });

            fs.writeFileSync(path.join(__dirname, target.file), csvContent, 'utf8');
            console.log(`-> Archivo ${target.file} guardado con éxito.`);
            
            newCounts[target.key] = records.length;

            // Pausa de 3 segundos entre peticiones para no saturar el servidor y evitar baneos
            await new Promise(r => setTimeout(r, 3000));

        } catch (error) {
            console.error(`❌ Error al obtener ${target.url}:`, error.message);
            allSuccess = false;
        }
    }

    if (allSuccess) {
        updateVersionFile(newCounts);
    } else {
        console.log("\n⚠️ Hubo errores en algunas peticiones. No se actualizará version.txt para mantener la coherencia.");
    }
}

// Función para gestionar el version.txt
function updateVersionFile(newCounts) {
    const versionPath = path.join(__dirname, 'version.txt');
    let version = '1.0.0';
    let oldCounts = {};

    // Leer archivo existente si lo hay
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

    // Comprobar si hubo cambios en las cantidades
    let hasChanged = false;
    for (const key of Object.keys(newCounts)) {
        if (oldCounts[key] !== newCounts[key]) {
            hasChanged = true;
            break;
        }
    }

    // Incrementar versión si hubo cambios
    if (hasChanged) {
        let parts = version.split('.');
        parts[2] = parseInt(parts[2], 10) + 1; // Incrementa el parche (ej. 1.0.0 -> 1.0.1)
        version = parts.join('.');
        console.log(`\n🔄 Se detectaron cambios en las cantidades. Nueva versión: ${version}`);
    } else {
        console.log(`\n✅ No hay cambios en las cantidades. Se mantiene la versión: ${version}`);
    }

    // Escribir el nuevo archivo version.txt
    let newVersionContent = `VERSION = ${version}\n`;
    for (const key in newCounts) {
        newVersionContent += `${key} = ${newCounts[key]}\n`;
    }

    fs.writeFileSync(versionPath, newVersionContent, 'utf8');
    console.log('-> Archivo version.txt actualizado correctamente.');
}

// Iniciar el script
scrapeData();