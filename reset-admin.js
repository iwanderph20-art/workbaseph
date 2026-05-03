// One-time admin password reset — delete after use
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  const email = process.env.ADMIN_EMAIL || 'admin@workbaseph.com';
  const password = process.env.ADMIN_PASSWORD || 'WorkBasePH@2026!';
  const hash = bcrypt.hashSync(password, 10);

  const { rowCount } = await pool.query(
    "UPDATE users SET email = $1, password = $2 WHERE admin_role = 'super_admin'",
    [email, hash]
  );

  if (rowCount === 0) {
    await pool.query(
      "INSERT INTO users (email, password, full_name, role, admin_role) VALUES ($1, $2, 'Super Admin', 'employer', 'super_admin')",
      [email, hash]
    );
    console.log('Admin user created:', email);
  } else {
    console.log('Admin password reset successfully:', email);
  }

  await pool.end();
})().catch(err => { console.error(err); process.exit(1); });
