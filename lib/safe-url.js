/**
 * Guards outgoing webhooks to customer-supplied URLs: HTTPS only, and the
 * host must resolve to public internet addresses (no localhost, private
 * networks or cloud metadata endpoints).
 */
const dns = require('dns').promises;
const net = require('net');

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v === '::1' || v === '::') return true;
  if (v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80')) return true;
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? isPrivateIp(mapped[1]) : false;
}

async function assertPublicHttpsUrl(raw, { lookup = dns.lookup } = {}) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new Error('Enter a full URL starting with https://'); }
  if (u.protocol !== 'https:') throw new Error('Webhook URL must start with https://');
  if (u.username || u.password) throw new Error('Webhook URL must not contain a username or password');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new Error('Could not find that web address');
  if (addrs.some(a => isPrivateIp(a.address))) throw new Error('Webhook URL must be a public internet address');
  return u.toString();
}

module.exports = { assertPublicHttpsUrl, isPrivateIp };
