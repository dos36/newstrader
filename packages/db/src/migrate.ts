import 'dotenv/config';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

const url =
  process.env.DATABASE_URL ?? 'postgres://newstrader:newstrader@localhost:5433/newstrader';
const pool = new pg.Pool({ connectionString: url, max: 1 });

await migrate(drizzle(pool), {
  migrationsFolder: new URL('../migrations', import.meta.url).pathname,
});
console.log('migrations applied');
await pool.end();
