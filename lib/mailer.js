/**
 * Shared email sender for every email the app sends.
 *
 * Uses Resend's HTTPS API when RESEND_API_KEY is set (works on Railway, which
 * blocks outbound SMTP on most plans), otherwise SMTP, otherwise logs the email.
 *
 *   RESEND_API_KEY   re_...
 *   EMAIL_FROM       StormCheck Pro <alerts@thepublicadjustertx.com>  (domain must be verified in Resend)
 */
const axios = require('axios');

let smtp = null;
function smtpTransport() {
  if (!process.env.SMTP_HOST) return null;
  if (!smtp) {
    const nodemailer = require('nodemailer');
    smtp = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
    });
  }
  return smtp;
}

function fromAddress() {
  return process.env.EMAIL_FROM || process.env.SMTP_FROM
    || (process.env.SMTP_USER ? `StormCheck Pro <${process.env.SMTP_USER}>` : 'StormCheck Pro <onboarding@resend.dev>');
}

function provider() {
  if (process.env.RESEND_API_KEY) return 'resend';
  if (process.env.SMTP_HOST) return 'smtp';
  return null;
}
const isConfigured = () => !!provider();

/** Throws on failure. `to` may be a string, comma list or array. */
async function deliver({ to, subject, html, text, from }) {
  const recipients = (Array.isArray(to) ? to : String(to).split(',')).map(s => s.trim()).filter(Boolean);
  const p = provider();
  if (p === 'resend') {
    await axios.post('https://api.resend.com/emails', {
      from: from || fromAddress(), to: recipients, subject, html, text: text || subject,
    }, { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` }, timeout: 15000 });
    return true;
  }
  if (p === 'smtp') {
    await smtpTransport().sendMail({ from: from || fromAddress(), to: recipients.join(','), subject, html, text: text || subject });
    return true;
  }
  console.log(`[email not configured] to=${recipients.join(',')} subject=${subject}`);
  return false;
}

/** Never throws; returns true when sent. */
async function sendMail(msg) {
  try { return await deliver(msg); }
  catch (e) {
    const detail = e.response && e.response.data ? JSON.stringify(e.response.data) : e.message;
    console.error('Email error:', detail);
    return false;
  }
}

/** For the admin "Test Email" button: sends and reports the real error. */
async function testSend(to) {
  try {
    await deliver({ to, subject: 'StormCheck Pro email test', html: '<p>Email is working. You will receive alerts, password resets and review notifications.</p>' });
    return { success: true, provider: provider(), from: fromAddress() };
  } catch (e) {
    return { success: false, provider: provider(), from: fromAddress(), error: e.response && e.response.data ? (e.response.data.message || JSON.stringify(e.response.data)) : e.message };
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

module.exports = { sendMail, deliver, testSend, isConfigured, provider, layout, baseUrl, escapeHtml };
