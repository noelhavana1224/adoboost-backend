const { dbRun } = require('../models/db');

async function migrate() {
  await dbRun(`
    CREATE TABLE IF NOT EXISTS support_sessions (
      id TEXT PRIMARY KEY,
      admin_id TEXT NOT NULL,
      admin_email TEXT NOT NULL,
      target_user_id TEXT NOT NULL,
      target_user_email TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      ended_reason TEXT,
      ip TEXT,
      user_agent TEXT
    )
  `);

  console.log('✅ support_sessions table created');
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
