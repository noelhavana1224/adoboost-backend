const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const { getStatusForUser, checkForUser } = require('../services/blacklistService');

const router = express.Router();
router.use(authMiddleware);

// Resolve the effective user (team members share the owner's domains)
function uid(req) { return req.ownerId || req.userId; }

// Cached status for the user's sending domains
router.get('/', async (req, res) => {
  try {
    res.json({ domains: await getStatusForUser(uid(req)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Run a fresh check on demand (can take a few seconds per domain)
router.post('/check', async (req, res) => {
  try {
    res.json({ domains: await checkForUser(uid(req)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
