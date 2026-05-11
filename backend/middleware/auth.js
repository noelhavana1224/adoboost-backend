const jwt = require('jsonwebtoken');
const { dbGet } = require('../models/db');
const JWT_SECRET = process.env.JWT_SECRET || 'adoboost-secret-change-in-prod';

async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer '))
    return res.status(401).json({ error: 'No token provided' });
  try {
    const decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);

    // Check users table first
    let user = await dbGet('SELECT id,email,name,role,plan,is_suspended FROM users WHERE id=?', [decoded.userId]);

    if (user) {
      if (user.is_suspended) return res.status(403).json({ error: 'Account suspended. Contact support.' });
      req.userId   = user.id;
      req.userRole = user.role;
      req.user     = user;
      return next();
    }

    // Check team_members table (client team members)
    const member = await dbGet('SELECT * FROM team_members WHERE id=?', [decoded.userId]);
    if (member) {
      if (member.status === 'inactive') return res.status(403).json({ error: 'Your account has been deactivated.' });
      let permissions = {};
      try { permissions = JSON.parse(member.permissions || '{}'); } catch {}
      req.userId      = member.id;
      req.userRole    = 'team_member';
      req.ownerId     = member.owner_id;
      req.permissions = permissions;
      req.user        = { id: member.id, email: member.email, name: member.name, role: 'team_member', owner_id: member.owner_id, permissions };
      return next();
    }

    return res.status(401).json({ error: 'User not found' });
  } catch (e) { return res.status(401).json({ error: 'Invalid token' }); }
}

function adminMiddleware(req, res, next) {
  if (req.userRole !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

module.exports = { authMiddleware, adminMiddleware, JWT_SECRET };
