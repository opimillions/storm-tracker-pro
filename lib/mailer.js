/**
 * Shared email sender. Without SMTP settings, emails are logged instead.
 */
let transporter = null;

function getTransport() {
  if (!process.env.SMTP_HOST) return null;
  if (!transporter) {
    const nodemailer = require('nodemailer');
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return transporter;
}

async function sendMail({ to, subject, html, text }) {
  const t = getTransport();
  if (!t) { console.log(`[email not configured] to=${to} subject=${subject}`); return false; }
  try {
    await t.sendMail({
      from: process.env.SMTP_FROM || `StormCheck Pro <${process.env.SMTP_USER}>`,
      to, subject, html, text: text || subject,
    });
    return true;
  } catch (e) {
    console.error('Email error:', e.message);
    return false;
  }
}

const baseUrl = () => process.env.BASE_URL || 'https://stormcheckpro.thepublicadjustertx.com';

// Consistent email wrapper.
function layout(title, bodyHtml, { footer = '' } = {}) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;color:#172235">
  <div style="background:#172235;color:#fff;padding:18px 22px;border-radius:8px 8px 0 0">
    <div style="font-weight:800;font-size:18px">StormCheck Pro</div>
    <div style="font-size:15px;opacity:.85;margin-top:4px">${title}</div>
  </div>
  <div style="padding:22px;background:#fff;border:1px solid #e1e6ed;border-top:none">${bodyHtml}</div>
  <div style="padding:12px 22px;font-size:12px;color:#5b6a80">${footer || 'Storm data: NOAA National Weather Service.'}</div>
</div>`;
}

const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

module.exports = { sendMail, layout, baseUrl, escapeHtml };
