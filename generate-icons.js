// Generate StormCheck Pro icons using Canvas
// Run: node generate-icons.js
// Then open icons/generate.html in Chrome to download PNGs

const fs = require('fs');
const path = require('path');

if (!fs.existsSync(path.join(__dirname, 'public', 'icons'))) {
  fs.mkdirSync(path.join(__dirname, 'public', 'icons'), { recursive: true });
}

const html = `<!DOCTYPE html>
<html>
<head><title>StormCheck Pro Icon Generator</title></head>
<body style="background:#0f172a;color:white;font-family:sans-serif;padding:20px">
<h2>StormCheck Pro Icons</h2>
<canvas id="c192" width="192" height="192" style="margin:10px"></canvas>
<canvas id="c512" width="512" height="512" style="margin:10px;width:128px;height:128px"></canvas>
<br>
<a id="dl192" style="color:#3b82f6;margin:10px;display:inline-block" download="icon-192.png">Download 192x192</a>
<a id="dl512" style="color:#3b82f6;margin:10px;display:inline-block" download="icon-512.png">Download 512x512</a>
<p style="color:#94a3b8;margin-top:20px">Save both files to: public/icons/</p>
<script>
function drawIcon(canvas) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const s = w / 512;

  // Dark gradient background
  const grad = ctx.createLinearGradient(0, 0, w, w);
  grad.addColorStop(0, '#1e3a8a');
  grad.addColorStop(1, '#0f172a');
  const r = 80 * s;
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(r,0); ctx.lineTo(w-r,0); ctx.quadraticCurveTo(w,0,w,r);
  ctx.lineTo(w,w-r); ctx.quadraticCurveTo(w,w,w-r,w);
  ctx.lineTo(r,w); ctx.quadraticCurveTo(0,w,0,w-r);
  ctx.lineTo(0,r); ctx.quadraticCurveTo(0,0,r,0);
  ctx.fill();

  // Cloud body
  ctx.fillStyle = '#1e40af';
  ctx.beginPath(); ctx.ellipse(256*s, 250*s, 145*s, 72*s, 0, 0, Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(195*s, 228*s, 82*s, 62*s, 0, 0, Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(318*s, 218*s, 92*s, 68*s, 0, 0, Math.PI*2); ctx.fill();

  // Cloud highlight
  ctx.fillStyle = '#3b82f6';
  ctx.beginPath(); ctx.ellipse(256*s, 245*s, 130*s, 60*s, 0, 0, Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(200*s, 222*s, 72*s, 52*s, 0, 0, Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(312*s, 212*s, 82*s, 58*s, 0, 0, Math.PI*2); ctx.fill();

  // Lightning bolt
  ctx.fillStyle = '#f59e0b';
  ctx.shadowColor = '#fcd34d';
  ctx.shadowBlur = 20 * s;
  ctx.beginPath();
  ctx.moveTo(272*s, 152*s);
  ctx.lineTo(222*s, 278*s);
  ctx.lineTo(256*s, 278*s);
  ctx.lineTo(236*s, 368*s);
  ctx.lineTo(294*s, 242*s);
  ctx.lineTo(260*s, 242*s);
  ctx.lineTo(290*s, 152*s);
  ctx.closePath();
  ctx.fill();
  ctx.shadowBlur = 0;

  return canvas.toDataURL('image/png');
}
const d192 = drawIcon(document.getElementById('c192'));
const d512 = drawIcon(document.getElementById('c512'));
document.getElementById('dl192').href = d192;
document.getElementById('dl512').href = d512;
<\/script>
</body></html>`;

fs.writeFileSync(path.join(__dirname, 'public', 'icons', 'generate.html'), html);
console.log('Done! Open public/icons/generate.html in Chrome to download the icons.');
console.log('Save them to: public/icons/icon-192.png and public/icons/icon-512.png');
