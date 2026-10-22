/**
 * Auth middleware — JWT-based authentication
 */
const jwt = require('jsonwebtoken');
const { userOps } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const JWT_EXPIRES = '7d';

function generateToken(user) {
  return jwt.sign(
    { id: user._id, email: user.email, role: user.role, tier: user.tier },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
}

function requireAuth(req, res, next) {
  const token = req.cookies?.token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
    return res.redirect('/login');
  }

  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    res.clearCookie('token');
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Session expired' });
    return res.redirect('/login');
  }

  userOps.findById(decoded.id).then(user => {
    if (!user) {
      res.clearCookie('token');
      if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'User not found' });
      return res.redirect('/login');
    }
    if (user.tier === 'suspended') {
      res.clearCookie('token');
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
      ? 'Your 1 free report has been used. Upgrade to Pro for unlimited lookups ($79/mo).'
      : 'Subscription required.';
    if (req.path.startsWith('/api/')) return res.status(402).json({ error: msg, upgrade: true });
    return res.redirect('/upgrade');
  }
  next();
}

module.exports = { generateToken, requireAuth, requireAdmin, requireActiveSubscription };
