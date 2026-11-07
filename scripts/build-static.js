const { copyFileSync, existsSync, mkdirSync, rmSync } = require('node:fs');
const { join } = require('node:path');

const projectRoot = join(__dirname, '..');
const outputDirectory = join(projectRoot, 'dist');

rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(outputDirectory, { recursive: true });
copyFileSync(join(projectRoot, 'index.html'), join(outputDirectory, 'index.html'));
copyFileSync(join(projectRoot, 'dashboard.js'), join(outputDirectory, 'dashboard.js'));

const apkPath = join(projectRoot, 'khe2-radar.apk');
if (existsSync(apkPath)) {
  copyFileSync(apkPath, join(outputDirectory, 'khe2-radar.apk'));
}

console.log('Static frontend built in dist/.');
