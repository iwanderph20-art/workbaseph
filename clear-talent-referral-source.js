// One-off cleanup: wipe referral_source for freelancers (talents).
//
// "Where did you hear about us?" is employer-only attribution now, so any values
// stored against talents from the old signup form are stale. Employers are NEVER
// touched (WHERE role = 'freelancer' guard).
//
// Usage:
//   node clear-talent-referral-source.js --dry-run   # report only, change nothing
//   node clear-talent-referral-source.js             # report, then clear
//
// This is IRREVERSIBLE — the old values are not recoverable afterwards.
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

const DRY_RUN = process.argv.includes('--dry-run');

(async () => {
  try {
    // ── Pre-flight: show exactly what is about to be cleared ──
    const { rows: breakdown } = await pool.query(`
      SELECT referral_source, COUNT(*)::int AS c
      FROM users
      WHERE role = 'freelancer' AND referral_source IS NOT NULL
      GROUP BY referral_source
      ORDER BY c DESC
    `);
    const affected = breakdown.reduce((n, r) => n + r.c, 0);

    // Sanity check the guard: employers must be untouched by this script.
    const { rows: empRows } = await pool.query(
      `SELECT COUNT(*)::int AS c FROM users WHERE role = 'employer' AND referral_source IS NOT NULL`
    );

    console.log('\nTalent (freelancer) referral_source values currently stored:');
    if (!affected) {
      console.log('  (none — nothing to clear)');
    } else {
      for (const r of breakdown) console.log(`  ${String(r.referral_source).padEnd(28)} ${r.c}`);
      console.log(`  ${'—'.repeat(28)} ----`);
      console.log(`  ${'TOTAL to clear'.padEnd(28)} ${affected}`);
    }
    console.log(`\nEmployer values (will NOT be touched): ${empRows[0].c}`);

    if (DRY_RUN) {
      console.log('\n--dry-run: no changes made.');
      return;
    }
    if (!affected) {
      console.log('\nNothing to do.');
      return;
    }

    const { rowCount } = await pool.query(
      `UPDATE users SET referral_source = NULL WHERE role = 'freelancer' AND referral_source IS NOT NULL`
    );
    console.log(`\n✅ Cleared referral_source for ${rowCount} talent${rowCount === 1 ? '' : 's'}.`);

    const { rows: check } = await pool.query(
      `SELECT COUNT(*)::int AS c FROM users WHERE role = 'freelancer' AND referral_source IS NOT NULL`
    );
    console.log(`Remaining talent values (should be 0): ${check[0].c}`);
    const { rows: empAfter } = await pool.query(
      `SELECT COUNT(*)::int AS c FROM users WHERE role = 'employer' AND referral_source IS NOT NULL`
    );
    console.log(`Employer values still intact: ${empAfter[0].c}`);
  } catch (err) {
    console.error('❌ Failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
