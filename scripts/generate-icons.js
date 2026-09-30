const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const iconsDir = path.join(__dirname, '..', 'icons');
if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

const standardSvg = `
<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <rect width="512" height="512" rx="104" fill="#17221e"/>
  <rect x="76" y="66" width="360" height="380" rx="32" fill="#24332e" stroke="#374d44" stroke-width="6"/>
  <rect x="206" y="90" width="100" height="24" rx="12" fill="#17221e" stroke="#374d44" stroke-width="4"/>
  <rect x="156" y="150" width="200" height="140" rx="16" fill="#1a2723" stroke="#d9ee55" stroke-width="6"/>
  <circle cx="196" cy="195" r="16" fill="#f5eedc"/>
  <circle cx="256" cy="195" r="16" fill="#cde0e2"/>
  <circle cx="316" cy="195" r="16" fill="#dcca96"/>
  <circle cx="196" cy="245" r="16" fill="#b7d0be"/>
  <circle cx="256" cy="245" r="16" fill="#b8b8b5"/>
  <circle cx="316" cy="245" r="16" fill="#d9ee55"/>
  <text x="256" y="360" font-family="monospace, sans-serif" font-size="44" font-weight="900" fill="#d9ee55" text-anchor="middle" letter-spacing="4">H₂S</text>
  <text x="256" y="398" font-family="sans-serif" font-size="18" font-weight="700" fill="#a4b3a9" text-anchor="middle" letter-spacing="3">DOSIMETER</text>
  <path d="M 126 130 L 106 130 L 106 150" fill="none" stroke="#d9ee55" stroke-width="6" stroke-linecap="round"/>
  <path d="M 386 130 L 406 130 L 406 150" fill="none" stroke="#d9ee55" stroke-width="6" stroke-linecap="round"/>
  <path d="M 126 380 L 106 380 L 106 360" fill="none" stroke="#d9ee55" stroke-width="6" stroke-linecap="round"/>
  <path d="M 386 380 L 406 380 L 406 360" fill="none" stroke="#d9ee55" stroke-width="6" stroke-linecap="round"/>
</svg>`;

const maskableSvg = `
<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <rect width="512" height="512" fill="#17221e"/>
  <g transform="translate(51.2, 51.2) scale(0.8)">
    <rect x="76" y="66" width="360" height="380" rx="32" fill="#24332e" stroke="#374d44" stroke-width="6"/>
    <rect x="206" y="90" width="100" height="24" rx="12" fill="#17221e" stroke="#374d44" stroke-width="4"/>
    <rect x="156" y="150" width="200" height="140" rx="16" fill="#1a2723" stroke="#d9ee55" stroke-width="6"/>
    <circle cx="196" cy="195" r="16" fill="#f5eedc"/>
    <circle cx="256" cy="195" r="16" fill="#cde0e2"/>
    <circle cx="316" cy="195" r="16" fill="#dcca96"/>
    <circle cx="196" cy="245" r="16" fill="#b7d0be"/>
    <circle cx="256" cy="245" r="16" fill="#b8b8b5"/>
    <circle cx="316" cy="245" r="16" fill="#d9ee55"/>
    <text x="256" y="360" font-family="monospace, sans-serif" font-size="44" font-weight="900" fill="#d9ee55" text-anchor="middle" letter-spacing="4">H₂S</text>
    <text x="256" y="398" font-family="sans-serif" font-size="18" font-weight="700" fill="#a4b3a9" text-anchor="middle" letter-spacing="3">DOSIMETER</text>
    <path d="M 126 130 L 106 130 L 106 150" fill="none" stroke="#d9ee55" stroke-width="6" stroke-linecap="round"/>
    <path d="M 386 130 L 406 130 L 406 150" fill="none" stroke="#d9ee55" stroke-width="6" stroke-linecap="round"/>
    <path d="M 126 380 L 106 380 L 106 360" fill="none" stroke="#d9ee55" stroke-width="6" stroke-linecap="round"/>
    <path d="M 386 380 L 406 380 L 406 360" fill="none" stroke="#d9ee55" stroke-width="6" stroke-linecap="round"/>
  </g>
</svg>`;

async function generate() {
  const stdBuffer = Buffer.from(standardSvg);
  const maskableBuffer = Buffer.from(maskableSvg);

  // 192x192
  await sharp(stdBuffer)
    .resize(192, 192)
    .png()
    .toFile(path.join(iconsDir, 'icon-192.png'));
  console.log('Generated icons/icon-192.png');

  // 512x512
  await sharp(stdBuffer)
    .resize(512, 512)
    .png()
    .toFile(path.join(iconsDir, 'icon-512.png'));
  console.log('Generated icons/icon-512.png');

  // 512x512 maskable
  await sharp(maskableBuffer)
    .resize(512, 512)
    .png()
    .toFile(path.join(iconsDir, 'icon-512-maskable.png'));
  console.log('Generated icons/icon-512-maskable.png');

  // apple-touch-icon 180x180 (in /icons and root)
  await sharp(stdBuffer)
    .resize(180, 180)
    .png()
    .toFile(path.join(iconsDir, 'apple-touch-icon.png'));
  await sharp(stdBuffer)
    .resize(180, 180)
    .png()
    .toFile(path.join(__dirname, '..', 'apple-touch-icon.png'));
  console.log('Generated apple-touch-icon.png');
}

generate().catch((err) => {
  console.error(err);
  process.exit(1);
});
