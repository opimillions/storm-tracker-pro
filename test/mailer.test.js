const test = require('node:test');
const assert = require('node:assert');
const axios = require('axios');

test('sends through Resend when RESEND_API_KEY is set', async () => {
  process.env.RESEND_API_KEY = 're_test';
  process.env.EMAIL_FROM = 'StormCheck Pro <alerts@example.com>';
  let call = null;
  const orig = axios.post;
  axios.post = async (url, body, opts) => { call = { url, body, opts }; return { data: { id: '1' } }; };
  const mailer = require('../lib/mailer');
  assert.strictEqual(mailer.provider(), 'resend');
  assert.strictEqual(await mailer.sendMail({ to: 'a@x.com, b@x.com', subject: 'Hi', html: '<p>x</p>' }), true);
  assert.strictEqual(call.url, 'https://api.resend.com/emails');
  assert.deepStrictEqual(call.body.to, ['a@x.com', 'b@x.com']);
  assert.strictEqual(call.body.from, 'StormCheck Pro <alerts@example.com>');
  assert.strictEqual(call.opts.headers.Authorization, 'Bearer re_test');
  axios.post = async () => { const e = new Error('422'); e.response = { data: { message: 'domain not verified' } }; throw e; };
  assert.strictEqual(await mailer.sendMail({ to: 'a@x.com', subject: 'Hi', html: 'x' }), false);
  const t = await mailer.testSend('a@x.com');
  assert.strictEqual(t.success, false);
  assert.strictEqual(t.error, 'domain not verified');
  axios.post = orig;
});
