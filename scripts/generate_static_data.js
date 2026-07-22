const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const dbPath = path.join(rootDir, 'backend', 'db.json');
const dataDir = path.join(rootDir, 'data');
const provincesDir = path.join(dataDir, 'provinces');

function buildProvinceIndex(provinces) {
  const index = {};

  for (const [name, province] of Object.entries(provinces || {})) {
    index[name] = {
      id: province.id,
      name: province.name,
      province: province.province,
      description: province.description,
      tags: province.tags,
      weather: province.weather,
      bestTime: province.bestTime,
      image: province.image,
      attractionCount: Array.isArray(province.attractions) ? province.attractions.length : 0,
    };
  }

  return index;
}

function main() {
  const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  const provinces = db.provinces || {};

  fs.mkdirSync(provincesDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'provinces-index.json'),
    JSON.stringify(buildProvinceIndex(provinces)),
    'utf8',
  );

  for (const [name, province] of Object.entries(provinces)) {
    fs.writeFileSync(
      path.join(provincesDir, `${name}.json`),
      JSON.stringify(province),
      'utf8',
    );
  }

  console.log(`Generated ${Object.keys(provinces).length} static province files in ${path.relative(rootDir, dataDir)}`);
}

main();
