import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Db = ReturnType<typeof createDb>;

export function createDb(databaseUrl?: string) {
  const url = databaseUrl ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  return drizzle(pool, { schema });
}
