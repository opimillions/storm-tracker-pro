/**
 * Auth middleware — JWT-based authentication
 */
const jwt = require('jsonwebtoken');
const { userOps } = require('./db');

const { jwtSecret } = require('./lib/app-secret');
const { clearSessionCookie } = require('./lib/security');
const JWT_EXPIRES = '7d';

// `tv` (token version) lets us end every session for a user at once:
// bump user.tokenVersion and older tokens stop working.
function generateToken(user) {
  return jwt.sign(
    { id: user._id, email: user.email, role: user.role, tier: user.tier, tv: user.tokenVersion || 0 },
    jwtSecret(),
    { expiresIn: JWT_EXPIRES, algorithm: 'HS256' }
  );
}

/** Short-lived ticket between a correct password and the two-step code. */
function generateMfaTicket(user) {
  return jwt.sign({ id: user._id, purpose: 'mfa', tv: user.tokenVersion || 0 }, jwtSecret(), { expiresIn: '5m', algorithm: 'HS256' });
}
function readMfaTicket(ticket) {
  try {
    const d = jwt.verify(String(ticket || ''), jwtSecret(), { algorithms: ['HS256'] });
    return d.purpose === 'mfa' ? d : null;
  } catch { return null; }
}

function requireAuth(req, res, next) {
  const token = req.cookies?.token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
    return res.redirect('/login');
  }

  let decoded;
  try {
    decoded = jwt.verify(token, jwtSecret(), { algorithms: ['HS256'] });
    if (decoded.purpose) throw new Error('not a session token');
  } catch (err) {
    clearSessionCookie(req, res);
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Session expired' });
    return res.redirect('/login');
  }

  userOps.findById(decoded.id).then(user => {
    if (!user || (decoded.tv || 0) !== (user.tokenVersion || 0)) {
      clearSessionCookie(req, res);
      if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'User not found' });
      return res.redirect('/login');
    }
    if (user.tier === 'suspended') {
      clearSessionCookie(req, res);
      if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Account suspended. Contact support.' });
      return res.redirect('/login?error=suspended');
    }
    req.user = user;
    next();
  }).catch(err => {
    if (req.path.startsWith('/api/')) return res.status(500).json({ error: 'Auth error' });
    return res.redirect('/login');
  });
}

async function requireAdmin(req, res, next) {
  // Re-check role from DB (not just JWT) to handle role changes after token issued
  if (!req.user) {
    if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Admin access required' });
    return res.redirect('/dashboard');
  }
  // Accept admin from token OR re-verify from DB
  if (req.user.role === 'admin') return next();
  // Token might be stale - check DB
  try {
    const freshUser = await userOps.findById(req.user._id);
    if (freshUser && freshUser.role === 'admin') {
      req.user = freshUser;
      return next();
    }
  } catch (e) {}
  if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Admin access required' });
  return res.redirect('/dashboard');
}

function requireActiveSubscription(req, res, next) {
  const user = req.user;
  if (!userOps.canLookup(user)) {
    const msg = user.tier === 'trial'
      ? 'Your 1 free report has been used. Upgrade for unlimited reports (from $39/mo).'
      : 'Subscription required.';
    if (req.path.startsWith('/api/')) return res.status(402).json({ error: msg, upgrade: true });
    return res.redirect('/upgrade');
  }
  next();
}

module.exports = { generateMfaTicket, readMfaTicket, generateToken, requireAuth, requireAdmin, requireActiveSubscription };
