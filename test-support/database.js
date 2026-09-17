import { PGlite } from "@electric-sql/pglite";
import { pool, initDb } from "../db.js";

// Real PostgreSQL SQL engine in memory; never uses DATABASE_URL or production data.
export async function createTestDatabase() {
  const db = await PGlite.create();
  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  const query = async (sql, values = []) => {
    const result = await db.query(sql, values);
    return { ...result, rowCount: result.affectedRows || result.rows?.length || 0 };
  };
  pool.query = query;
  pool.connect = async () => ({ query, release() {} });
  await initDb();
  return { db, close: async () => { pool.query = originalQuery; pool.connect = originalConnect; await db.close(); await pool.end(); } };
}
