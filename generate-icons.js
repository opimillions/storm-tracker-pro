// Generate SVG-based PNG icons for Storm Tracker Pro
const fs = require('fs');
const path = require('path');

// Create SVG icon
const svgIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="100" fill="#0f172a"/>
  <rect width="512" height="512" rx="100" fill="url(#grad)"/>
  <defs>
    <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#1e3a8a"/>
      <stop offset="100%" style="stop-color:#0f172a"/>
    </linearGradient>
  </defs>
  <!-- Cloud -->
  <ellipse cx="256" cy="240" rx="140" ry="70" fill="#334155"/>
  <ellipse cx="200" cy="220" rx="80" ry="60" fill="#334155"/>
  <ellipse cx="310" cy="210" rx="90" ry="65" fill="#334155"/>
  <!-- Lightning bolt -->
  <polygon points="270,160 230,270 260,270 240,360 290,240 260,240 285,160" fill="#f59e0b"/>
  <!-- Glow -->
  <polygon points="270,160 230,270 260,270 240,360 290,240 260,240 285,160" fill="#fcd34d" opacity="0.4"/>
</svg>`;

fs.writeFileSync(path.join(__dirname, 'icons', 'icon.svg'), svgIcon);

// Write a simple HTML file that generates the PNGs via canvas
const html = `<!DOCTYPE html>
<html>
<head><title>Icon Generator</title></head>
<body>
<canvas id="c192" width="192" height="192"></canvas>
<canvas id="c512" width="512" height="512"></canvas>
<script>
function drawIcon(canvas) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const s = w / 512;
  
  // Background
  const grad = ctx.createLinearGradient(0, 0, w, w);
  grad.addColorStop(0, '#1e3a8a');
  grad.addColorStop(1, '#0f172a');
  ctx.fillStyle = grad;
  const r = 100 * s;
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.lineTo(w - r, 0);
  ctx.quadraticCurveTo(w, 0, w, r);
  ctx.lineTo(w, w - r);
  ctx.quadraticCurveTo(w, w, w - r, w);
  ctx.lineTo(r, w);
  ctx.quadraticCurveTo(0, w, 0, w - r);
  ctx.lineTo(0, r);
  ctx.quadraticCurveTo(0, 0, r, 0);
  ctx.fill();
  
  // Cloud
  ctx.fillStyle = '#334155';
  ctx.beginPath();
  ctx.ellipse(256*s, 240*s, 140*s, 70*s, 0, 0, Math.PI*2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(200*s, 220*s, 80*s, 60*s, 0, 0, Math.PI*2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(310*s, 210*s, 90*s, 65*s, 0, 0, Math.PI*2);
  ctx.fill();
  
  // Lightning bolt
  ctx.fillStyle = '#f59e0b';
  ctx.beginPath();
  ctx.moveTo(270*s, 155*s);
  ctx.lineTo(225*s, 270*s);
  ctx.lineTo(258*s, 270*s);
  ctx.lineTo(238*s, 365*s);
  ctx.lineTo(292*s, 238*s);
  ctx.lineTo(260*s, 238*s);
  ctx.lineTo(288*s, 155*s);
  ctx.closePath();
  ctx.fill();
  
  // Inner glow
  ctx.fillStyle = 'rgba(253, 211, 77, 0.35)';
  ctx.beginPath();
  ctx.moveTo(270*s, 155*s);
  ctx.lineTo(225*s, 270*s);
  ctx.lineTo(258*s, 270*s);
  ctx.lineTo(238*s, 365*s);
  ctx.lineTo(292*s, 238*s);
  ctx.lineTo(260*s, 238*s);
  ctx.lineTo(288*s, 155*s);
  ctx.closePath();
  ctx.fill();
  
  return canvas.toDataURL('image/png');
}

const data192 = drawIcon(document.getElementById('c192'));
const data512 = drawIcon(document.getElementById('c512'));

document.body.innerHTML += '<br><br>';
document.body.innerHTML += '<a id="dl192" download="icon-192.png">Download 192x192</a> &nbsp; ';
document.body.innerHTML += '<a id="dl512" download="icon-512.png">Download 512x512</a>';
document.getElementById('dl192').href = data192;
document.getElementById('dl512').href = data512;
document.body.innerHTML += '<br><br><img src="' + data192 + '"> <img src="' + data512 + '" width="128">';
<\/script>
</body>
</html>`;

fs.writeFileSync(path.join(__dirname, 'icons', 'generate.html'), html);
console.log('Icon generator created at icons/generate.html');
console.log('Open that file in a browser to download the PNG icons.');
