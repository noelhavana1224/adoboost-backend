const { dbRun } = require('../models/db');

async function migrate() {
  // Create va_interest log table
  await dbRun(`
    CREATE TABLE IF NOT EXISTS va_interest (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      user_email TEXT NOT NULL,
      user_name TEXT,
      va_type TEXT NOT NULL,
      hours_type TEXT,
      notes TEXT,
      created_at TEXT NOT NULL
    )
  `);

  // Add dismissed_at column to users (ignore if already exists)
  try {
    await dbRun(`ALTER TABLE users ADD COLUMN va_upsell_dismissed_at TEXT`);
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) throw e;
  }

  console.log('✅ VA upsell migration complete');
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
