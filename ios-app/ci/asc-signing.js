#!/usr/bin/env node
/**
 * App Store signing for CI without a Mac or registered devices.
 *
 *   node asc-signing.js setup   <workdir>  → creates an Apple Distribution certificate
 *        (from a fresh key made on the runner) and an App Store provisioning profile
 *        named PROFILE_NAME; writes cert.cer, key.pem, profile.mobileprovision and
 *        state.json into <workdir>.
 *   node asc-signing.js cleanup <workdir>  → revokes that certificate and deletes the
 *        profile. Builds already uploaded are not affected.
 *
 * Env: ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_FILE (path to the .p8), BUNDLE_ID, PROFILE_NAME
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const API = 'https://api.appstoreconnect.apple.com/v1';
const env = k => { const v = process.env[k]; if (!v) throw new Error('Missing env ' + k); return v; };

function token() {
  const u = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const d = u({ alg: 'ES256', kid: env('ASC_KEY_ID'), typ: 'JWT' }) + '.' +
    u({ iss: env('ASC_ISSUER_ID'), iat: now, exp: now + 900, aud: 'appstoreconnect-v1' });
  const sig = crypto.sign('sha256', Buffer.from(d), { key: fs.readFileSync(env('ASC_KEY_FILE')), dsaEncoding: 'ieee-p1363' });
  return d + '.' + sig.toString('base64url');
}

async function api(method, p, body) {
  const r = await fetch(API + p, {
    method,
    headers: { Authorization: 'Bearer ' + token(), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch {}
  if (!r.ok) {
    const e = new Error(`${method} ${p} → ${r.status}: ${(json.errors || []).map(x => x.detail || x.title).join('; ') || text.slice(0, 300)}`);
    e.status = r.status; e.json = json; throw e;
  }
  return json;
}

async function bundleIdRecord(identifier) {
  const r = await api('GET', `/bundleIds?filter[identifier]=${encodeURIComponent(identifier)}&limit=5`);
  const hit = (r.data || []).find(b => b.attributes.identifier === identifier);
  if (hit) return hit;
  console.log('Registering app ID', identifier);
  const c = await api('POST', '/bundleIds', { data: { type: 'bundleIds', attributes: { identifier, name: identifier.split('.').pop(), platform: 'IOS' } } });
  return c.data;
}

async function ensurePush(bundleId) {
  try {
    await api('POST', '/bundleIdCapabilities', {
      data: { type: 'bundleIdCapabilities', attributes: { capabilityType: 'PUSH_NOTIFICATIONS' }, relationships: { bundleId: { data: { type: 'bundleIds', id: bundleId.id } } } },
    });
    console.log('Push Notifications turned on for the app ID');
  } catch (e) {
    if (e.status === 409) console.log('Push Notifications already on for the app ID');
    else throw e;
  }
}

async function createCertificate(csrPem) {
  const body = { data: { type: 'certificates', attributes: { certificateType: 'DISTRIBUTION', csrContent: csrPem } } };
  try {
    return (await api('POST', '/certificates', body)).data;
  } catch (e) {
    if (e.status !== 409) throw e;
    // Apple allows only a few distribution certificates. Free the oldest one and retry.
    const list = await api('GET', '/certificates?filter[certificateType]=DISTRIBUTION&limit=20');
    const certs = (list.data || []).sort((a, b) => String(a.attributes.expirationDate).localeCompare(String(b.attributes.expirationDate)));
    if (!certs.length) throw e;
    console.log('Certificate limit reached; revoking the oldest distribution certificate', certs[0].id);
    await api('DELETE', '/certificates/' + certs[0].id);
    return (await api('POST', '/certificates', body)).data;
  }
}

async function setup(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const bundle = await bundleIdRecord(env('BUNDLE_ID'));
  await ensurePush(bundle);

  // Fresh private key + certificate signing request (made with openssl on the runner).
  const keyPem = path.join(dir, 'key.pem');
  const csrPem = path.join(dir, 'req.csr');
  execFileSync('openssl', ['genrsa', '-out', keyPem, '2048'], { stdio: 'ignore' });
  execFileSync('openssl', ['req', '-new', '-key', keyPem, '-out', csrPem, '-subj', '/CN=StormCheck CI/O=First Call Public Adjusters/C=US'], { stdio: 'ignore' });

  const cert = await createCertificate(fs.readFileSync(csrPem, 'utf8'));
  fs.writeFileSync(path.join(dir, 'cert.cer'), Buffer.from(cert.attributes.certificateContent, 'base64'));
  console.log('Created distribution certificate', cert.id);

  // Replace any earlier CI profile with the same name.
  const name = env('PROFILE_NAME');
  const old = await api('GET', `/profiles?filter[name]=${encodeURIComponent(name)}&limit=20`);
  for (const p of old.data || []) {
    try { await api('DELETE', '/profiles/' + p.id); console.log('Deleted old profile', p.id); } catch (e) { console.log('Could not delete old profile', p.id, e.message); }
  }
  const prof = (await api('POST', '/profiles', {
    data: {
      type: 'profiles',
      attributes: { name, profileType: 'IOS_APP_STORE' },
      relationships: {
        bundleId: { data: { type: 'bundleIds', id: bundle.id } },
        certificates: { data: [{ type: 'certificates', id: cert.id }] },
      },
    },
  })).data;
  fs.writeFileSync(path.join(dir, 'profile.mobileprovision'), Buffer.from(prof.attributes.profileContent, 'base64'));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ certificateId: cert.id, profileId: prof.id, profileUuid: prof.attributes.uuid }));
  console.log('Created App Store profile', name, prof.attributes.uuid);
}

async function cleanup(dir) {
  let st = {};
  try { st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')); } catch { console.log('Nothing to clean up'); return; }
  for (const [kind, id] of [['profiles', st.profileId], ['certificates', st.certificateId]]) {
    if (!id) continue;
    try { await api('DELETE', `/${kind}/${id}`); console.log('Removed', kind, id); } catch (e) { console.log('Could not remove', kind, id, e.message); }
  }
}

const [cmd, dir] = process.argv.slice(2);
(cmd === 'setup' ? setup : cmd === 'cleanup' ? cleanup : () => { throw new Error('usage: setup|cleanup <dir>'); })(dir)
  .catch(e => { console.error('::error::' + e.message); process.exit(1); });
