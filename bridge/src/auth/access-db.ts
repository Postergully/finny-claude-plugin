import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';

let db: InstanceType<typeof Database> | null = null;

export function initAccessDb(env: string): void {
  if (!env) {
    throw new Error('ENV must be set to initialize access database');
  }
  // Allow tests + non-standard deploy targets to override the default path.
  const dbDir = process.env.ACCESS_DB_DIR ?? `/opt/deployments/${env}/bridge/data`;
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'bridge_access_logs.db');

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS issuers (
      id TEXT PRIMARY KEY,
      issuer_url TEXT UNIQUE NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issuer_id TEXT NOT NULL REFERENCES issuers(id),
      sub TEXT NOT NULL,
      email TEXT,
      name TEXT,
      data TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(issuer_id, sub)
    );

    CREATE TABLE IF NOT EXISTS access_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issuer_id TEXT NOT NULL REFERENCES issuers(id),
      email TEXT,
      jti TEXT,
      client_id TEXT,
      token_exp TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

export function getOrCreateIssuer(issuerUrl: string): string {
  if (!db) throw new Error('Access DB not initialized');

  const row = db.prepare('SELECT id FROM issuers WHERE issuer_url = ?').get(issuerUrl) as
    | { id: string }
    | undefined;
  if (row) return row.id;

  const id = randomUUID();
  db.prepare('INSERT INTO issuers (id, issuer_url) VALUES (?, ?)').run(id, issuerUrl);
  return id;
}

const STALE_HOURS = 24;

export interface TokenClaims {
  sub: string;
  jti?: string;
  client_id?: string;
  exp?: number;
}

export async function recordAccess(
  issuerUrl: string,
  claims: TokenClaims,
  token: string,
  userinfoEndpoint: string
): Promise<string | undefined> {
  if (!db) throw new Error('Access DB not initialized');

  const { sub, jti, client_id, exp } = claims;
  const issuerId = getOrCreateIssuer(issuerUrl);

  const user = db
    .prepare('SELECT id, email, updated_at FROM users WHERE issuer_id = ? AND sub = ?')
    .get(issuerId, sub) as { id: number; email: string | null; updated_at: string } | undefined;

  let email: string | undefined;

  const isStale =
    !user ||
    !user.email ||
    (Date.now() - new Date(user.updated_at + 'Z').getTime()) / (1000 * 60 * 60) > STALE_HOURS;

  if (isStale) {
    try {
      const res = await fetch(userinfoEndpoint, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const info = (await res.json()) as Record<string, unknown>;
        email = info.email as string | undefined;
        const name = info.name as string | undefined;
        const data = JSON.stringify(info);

        if (user) {
          db.prepare(
            "UPDATE users SET email = ?, name = ?, data = ?, updated_at = datetime('now') WHERE id = ?"
          ).run(email || null, name || null, data, user.id);
        } else {
          db.prepare(
            'INSERT INTO users (issuer_id, sub, email, name, data) VALUES (?, ?, ?, ?, ?)'
          ).run(issuerId, sub, email || null, name || null, data);
        }
      }
    } catch {
      // Userinfo fetch failed — continue with cached email if available
      email = user?.email || undefined;
    }
  } else {
    email = user?.email || undefined;
  }

  const tokenExp = exp ? new Date(exp * 1000).toISOString() : null;
  db.prepare(
    'INSERT INTO access_logs (issuer_id, email, jti, client_id, token_exp) VALUES (?, ?, ?, ?, ?)'
  ).run(issuerId, email || null, jti || null, client_id || null, tokenExp);

  return email;
}
