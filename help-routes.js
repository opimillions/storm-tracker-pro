/**
 * Help page, "What's new" popup state, and the in-app AI assistant.
 *
 * Assistant: uses the Anthropic API when ANTHROPIC_API_KEY is set
 * (ASSISTANT_MODEL, default claude-haiku-5-5). Without a key it answers from
 * the built-in guide and FAQ by keyword search, so the chat always works.
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const help = require('./lib/help-content');
const { dataPath } = require('./lib/paths');
const { toCsv } = require('./lib/csv');

const LOG = () => dataPath('assistant-log.jsonl');

// Each line records the question AND the answer given, so the guide's answers can be checked.
function logQuestion(user, question, mode, answer = '', matched = []) {
  try {
    const line = JSON.stringify({
      at: new Date().toISOString(), userId: user._id, email: user.email, tier: user.tier, mode,
      question: String(question).slice(0, 1000), answer: String(answer || '').slice(0, 3000), matched,
    }) + '\n';
    fs.appendFileSync(LOG(), line);
    const st = fs.statSync(LOG());
    if (st.size > 5e6) { // keep the newest ~half
      const lines = fs.readFileSync(LOG(), 'utf8').trim().split('\n');
      fs.writeFileSync(LOG(), lines.slice(Math.floor(lines.length / 2)).join('\n') + '\n');
    }
  } catch (e) { /* logging is best-effort */ }
}

// Simple per-user limits: 20 messages / 10 minutes, 150 / day.
const usage = new Map();
function overLimit(userId) {
  const now = Date.now();
  const arr = (usage.get(userId) || []).filter(t => now - t < 86400000);
  arr.push(now); usage.set(userId, arr);
  return arr.filter(t => now - t < 600000).length > 20 || arr.length > 150;
}

function systemPrompt(user, features, ctx) {
  return `You are the StormCheck Pro in-app assistant. StormCheck Pro is a web app for roofers, public adjusters, insurance agents, realtors, property managers and real estate investors that shows hail, wind and tornado history for any U.S. address using NOAA data.

Answer questions about how to use StormCheck Pro and how to read its storm data, using ONLY the guide below. Be brief and practical: 1–4 short sentences or a few short steps. Name the exact tab and button to click. When you mention a tab, include its path in parentheses, e.g. "Hail Map (/hailmap)".

Rules:
- If the guide doesn't cover something, say you're not sure and suggest support: ${help.SUPPORT} Never invent features, prices, data or settings.
- Do not give legal advice, insurance coverage opinions, claim outcome predictions, or tell someone whether a specific roof is damaged. You can explain what the storm data shows and suggest an inspection or a meteorologist-reviewed report.
- If asked about a specific address's storm history, tell them to run it on the Lookup tab (/dashboard); you cannot see report results.
- Plain text only. No markdown headers or tables. Short dash lists are fine.

About this user: name ${user.name || 'unknown'}, plan ${features.label || user.tier}${ctx.portfolio != null ? `, ${ctx.portfolio} properties in Portfolio` : ''}${ctx.integrations.length ? `, connected: ${ctx.integrations.join(', ')}` : ''}. Plan features: storm playback ${features.playback ? 'yes' : 'no'}, hail warning heads-up ${features.predictive ? 'yes' : 'no'}, nationwide ${features.maxStates === -1 ? 'yes' : 'no (1 state)'}, logo on reports ${features.logo ? 'yes' : 'no'}. If they ask about a feature their plan doesn't include, say which plan includes it and point to Upgrade (/upgrade).

${help.asText()}`;
}

function publicPrompt() {
  return `You are the assistant on the public website of StormCheck Pro, answering questions from people deciding whether to sign up: roofers, public adjusters, insurance agents, realtors, property managers and real estate investors.

Answer using ONLY the information below. Be friendly, brief and concrete: 1–3 short sentences, or a short dash list. When it fits, end with one next step: run a free report (/register), see a sample report (/sample-report), see pricing (/#pricing), or get free hail alerts (/alerts). Include paths exactly like that so they become links.

Rules:
- Only discuss StormCheck Pro, hail and storm data, and how it helps their business. For anything unrelated, say you can only help with StormCheck Pro questions.
- Never invent features, prices, discounts, integrations or data. If it isn't below, say you're not sure and suggest contacting ${help.SUPPORT}
- Do not give legal advice, insurance coverage opinions or claim outcome predictions, and don't say whether a specific roof is damaged.
- You cannot look up an address here; tell them to run a free report at /register.
- Do not disparage competitors; describe StormCheck Pro's strengths factually.
- Plain text only, no markdown headers or tables.

${help.publicText()}`;
}

/** Keyword-search answer and the guide topics it used. */
function fallbackDetail(question, { publicOnly = false } = {}) {
  if (publicOnly) {
    const hits = help.search(question, 2, { publicOnly: true });
    if (!hits.length) return { reply: `I can help with questions about StormCheck Pro. See the sample report (/sample-report) or pricing (/#pricing), or ${help.SUPPORT}`, matched: [] };
    return { reply: hits.map(h => `${h.title}\n${h.text}`).join('\n\n') + '\n\nTry it free: /register', matched: hits.map(h => h.title) };
  }
  const hits = help.search(question, 2);
  if (!hits.length) return { reply: `I couldn't find that in the guide. Try the Help tab (/help), or ${help.SUPPORT}`, matched: [] };
  return {
    reply: hits.map(h => `${h.title}\n${h.text.length > 600 ? h.text.slice(0, 600) + '…' : h.text}\n(${h.link})`).join('\n\n') + `\n\nMore in the Help tab (/help).`,
    matched: hits.map(h => h.title),
  };
}
const fallbackReply = (q, o) => fallbackDetail(q, o).reply;

module.exports = function helpRoutes(app, { requireAuth, requireAdmin, tierFeatures, db }) {
  const { userOps, watchlistOps, integrationOps } = db;

  app.get('/help', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'help.html')));

  app.get('/api/help', requireAuth, (req, res) => {
    res.json({ guides: help.GUIDES, faq: help.FAQ, release: help.RELEASE, support: help.SUPPORT, seenRelease: req.user.lastSeenRelease || null });
  });

  app.post('/api/me/seen-release', requireAuth, async (req, res) => {
    await userOps.update(req.user._id, { lastSeenRelease: help.RELEASE.id });
    res.json({ success: true });
  });

  app.post('/api/assistant/chat', requireAuth, async (req, res) => {
    const msgs = Array.isArray(req.body && req.body.messages) ? req.body.messages : [];
    const clean = msgs
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .slice(-12)
      .map(m => ({ role: m.role, content: m.content.slice(0, 2000) }));
    while (clean.length && clean[0].role !== 'user') clean.shift();
    const last = clean[clean.length - 1];
    if (!last || last.role !== 'user') return res.status(400).json({ error: 'Ask a question.' });
    if (overLimit(String(req.user._id))) return res.status(429).json({ error: 'You have asked a lot of questions in a short time. Please wait a few minutes.' });

    if (!process.env.ANTHROPIC_API_KEY) {
      const f = fallbackDetail(last.content);
      logQuestion(req.user, last.content, 'search', f.reply, f.matched);
      return res.json({ reply: f.reply, mode: 'search' });
    }

    const features = tierFeatures(req.user.tier);
    let portfolio = null, integrations = [];
    try { portfolio = await watchlistOps.count(req.user._id); } catch { /* optional */ }
    try { integrations = (await integrationOps.getForUser(req.user._id)).map(i => i.type).filter(t => t !== 'inbound'); } catch { /* optional */ }

    try {
      const r = await axios.post('https://api.anthropic.com/v1/messages', {
        model: process.env.ASSISTANT_MODEL || 'claude-haiku-5-5',
        max_tokens: 600,
        system: systemPrompt(req.user, features, { portfolio, integrations }),
        messages: clean,
      }, {
        headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        timeout: 30000,
      });
      const reply = (r.data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      const out = reply || fallbackReply(last.content);
      logQuestion(req.user, last.content, 'ai', out);
      res.json({ reply: out, mode: 'ai' });
    } catch (e) {
      console.error('Assistant error:', e.response ? JSON.stringify(e.response.data) : e.message);
      const f = fallbackDetail(last.content);
      logQuestion(req.user, last.content, 'fallback', f.reply, f.matched);
      res.json({ reply: f.reply, mode: 'search' });
    }
  });

  // ── Public website assistant (no login) ───────────────────────────────────
  const ipUse = new Map();
  let dayKey = '', dayCount = 0;
  const DAILY_CAP = parseInt(process.env.PUBLIC_ASSISTANT_DAILY_CAP || '1500', 10);
  function publicLimited(ip) {
    const now = Date.now();
    const arr = (ipUse.get(ip) || []).filter(t => now - t < 86400000);
    arr.push(now); ipUse.set(ip, arr);
    if (ipUse.size > 50000) ipUse.clear();
    return arr.filter(t => now - t < 600000).length > 12 || arr.length > 50;
  }
  app.post('/api/public/assistant/chat', async (req, res) => {
    const msgs = Array.isArray(req.body && req.body.messages) ? req.body.messages : [];
    const clean = msgs
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .slice(-8)
      .map(m => ({ role: m.role, content: m.content.slice(0, 800) }));
    while (clean.length && clean[0].role !== 'user') clean.shift();
    const last = clean[clean.length - 1];
    if (!last || last.role !== 'user') return res.status(400).json({ error: 'Ask a question.' });
    if (publicLimited(req.ip)) return res.status(429).json({ error: `You've asked a lot of questions. Please wait a few minutes, or ${help.SUPPORT}` });

    const today = new Date().toISOString().slice(0, 10);
    if (today !== dayKey) { dayKey = today; dayCount = 0; }
    const visitor = { _id: null, email: '', tier: 'visitor' };
    if (!process.env.ANTHROPIC_API_KEY || ++dayCount > DAILY_CAP) {
      const f = fallbackDetail(last.content, { publicOnly: true });
      logQuestion(visitor, last.content, 'public-search', f.reply, f.matched);
      return res.json({ reply: f.reply, mode: 'search' });
    }
    try {
      const r = await axios.post('https://api.anthropic.com/v1/messages', {
        model: process.env.ASSISTANT_MODEL || 'claude-haiku-5-5',
        max_tokens: 400,
        system: publicPrompt(),
        messages: clean,
      }, {
        headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        timeout: 30000,
      });
      const reply = (r.data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      const out = reply || fallbackReply(last.content, { publicOnly: true });
      logQuestion(visitor, last.content, 'public-ai', out);
      res.json({ reply: out, mode: 'ai' });
    } catch (e) {
      console.error('Public assistant error:', e.response ? JSON.stringify(e.response.data) : e.message);
      const f = fallbackDetail(last.content, { publicOnly: true });
      logQuestion(visitor, last.content, 'public-fallback', f.reply, f.matched);
      res.json({ reply: f.reply, mode: 'search' });
    }
  });

  // Admin: download what users are asking (to improve the guide).
  app.get('/api/admin/assistant-log.csv', requireAuth, requireAdmin, (req, res) => {
    let lines = [];
    try { lines = fs.readFileSync(LOG(), 'utf8').trim().split('\n').filter(Boolean); } catch { /* none */ }
    const MODES = { search: 'Guide search', fallback: 'Guide search', ai: 'AI', 'public-search': 'Guide search (website)', 'public-fallback': 'Guide search (website)', 'public-ai': 'AI (website)' };
    const rows = [['asked_at', 'email', 'plan', 'answered_by', 'question', 'answer_given', 'guide_topics_used']];
    for (const l of lines.reverse()) {
      try {
        const j = JSON.parse(l);
        rows.push([j.at, j.email, j.tier, MODES[j.mode] || j.mode, j.question,
          j.answer != null ? j.answer : '(not recorded: asked before answers were saved)',
          (j.matched || []).join(' | ') || (j.answer != null && /^(guide|public-search|public-fallback|search|fallback)/.test(j.mode) ? 'none matched' : '')]);
      } catch { /* skip */ }
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="assistant-questions.csv"');
    res.send(toCsv(rows));
  });
};
