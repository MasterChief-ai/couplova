import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import type { ActiveDeckThemeId, GenderTheme } from '../constants/theme';
import { hashSecret } from './security';

export interface DbUser {
  id: string;
  full_name: string;
  username: string;
  email: string;
  country: string;
  date_of_birth: string;
  partner_name: string;
  password_hash: string | null;
  google_sub: string | null;
  gender_theme: GenderTheme;
  active_deck_theme: ActiveDeckThemeId;
  is_verified: boolean;
  last_seen_at: string;
  created_at: string;
}

export interface DbOtpCode {
  id: string;
  email: string;
  code_hash: string;
  purpose: 'signup' | 'login' | 'admin';
  attempts: number;
  expires_at: string;
  used: boolean;
  created_at: string;
}

export interface DbSession {
  id: string;
  user_id: string;
  refresh_token_hash: string;
  last_active_at: string;
  expires_at: string;
  revoked: boolean;
}

export interface DbSavedCard {
  user_id: string;
  card_id: string;
  created_at: string;
}

export interface DbCoupleIou {
  id: string;
  user_id: string;
  card_id: string;
  deck_id: string;
  deck_title: string;
  title: string;
  owed_by: 'me' | 'partner' | 'both';
  redeemed: boolean;
  redeemed_at: string | null;
  created_at: string;
}

export interface DbUsedConfirmJti {
  jti: string;
  expires_at: string;
}

export interface DbRotatedRefreshHash {
  token_hash: string;
  user_id: string;
  expires_at: string;
}

export interface CouplyDatabase {
  users: DbUser[];
  otp_codes: DbOtpCode[];
  sessions: DbSession[];
  saved_cards: DbSavedCard[];
  ious: DbCoupleIou[];
  used_confirm_jtis: DbUsedConfirmJti[];
  rotated_refresh_hashes: DbRotatedRefreshHash[];
}

function getDbFilePath(): string {
  const override = process.env.COUP_DB_PATH?.trim();
  if (override) {
    return path.resolve(override);
  }
  return path.resolve(process.cwd(), '.data', 'couply-db.json');
}

function getBackupFilePath(dbPath: string): string {
  return `${dbPath}.bak`;
}

function stripOuterQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function resolveExternalDatabaseUrl(): string | null {
  const raw =
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.SUPABASE_DB_URL ||
    '';
  const url = stripOuterQuotes(raw);
  if (!url) return null;
  if (url.includes('[YOUR-PASSWORD]') || url.includes('[YOUR-PROJECT-REF]')) {
    return null;
  }
  if (!url.startsWith('postgres://') && !url.startsWith('postgresql://')) {
    return null;
  }
  return url;
}

export function isExternalDatabaseConfigured(): boolean {
  return resolveExternalDatabaseUrl() !== null;
}

export interface DatabaseHealth {
  mode: 'postgresql' | 'local-json';
  configured: boolean;
  connected: boolean;
  host: string | null;
  lastError: string | null;
}

let pgHealthState: DatabaseHealth = {
  mode: 'local-json',
  configured: false,
  connected: false,
  host: null,
  lastError: null,
};

export function getDatabaseHealth(): DatabaseHealth {
  const url = resolveExternalDatabaseUrl();
  if (!url) {
    return {
      mode: 'local-json',
      configured: false,
      connected: false,
      host: null,
      lastError: null,
    };
  }
  return { ...pgHealthState, configured: true };
}

export function createSeedDatabase(): CouplyDatabase {
  const now = new Date().toISOString();
  const demoUserId = '11111111-1111-4111-8111-111111111111';
  const partnerUserId = '22222222-2222-4222-8222-222222222222';
  const sessionExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  return {
    users: [
      {
        id: demoUserId,
        full_name: 'Maya Lin',
        username: 'maya_lin',
        email: 'maya@couply.app',
        country: 'United States',
        date_of_birth: '1999-05-14',
        partner_name: 'Julian',
        password_hash: hashSecret('CouplyDemo2026!'),
        google_sub: null,
        gender_theme: 'female',
        active_deck_theme: 'default',
        is_verified: true,
        last_seen_at: now,
        created_at: now,
      },
      {
        id: partnerUserId,
        full_name: 'Julian Vance',
        username: 'julian_v',
        email: 'julian@couply.app',
        country: 'United States',
        date_of_birth: '1998-09-22',
        partner_name: 'Maya',
        password_hash: hashSecret('CouplyDemo2026!'),
        google_sub: null,
        gender_theme: 'male',
        active_deck_theme: 'default',
        is_verified: true,
        last_seen_at: now,
        created_at: now,
      },
    ],
    otp_codes: [],
    sessions: [
      {
        id: '33333333-3333-4333-8333-333333333333',
        user_id: partnerUserId,
        refresh_token_hash: crypto.createHash('sha256').update('seed-partner-session').digest('hex'),
        last_active_at: now,
        expires_at: sessionExpires,
        revoked: false,
      },
    ],
    saved_cards: [
      {
        user_id: demoUserId,
        card_id: 'dc-01',
        created_at: now,
      },
      {
        user_id: demoUserId,
        card_id: 'wnrs-12',
        created_at: now,
      },
    ],
    ious: [
      {
        id: '44444444-4444-4444-8444-444444444444',
        user_id: demoUserId,
        card_id: 'ah-26',
        deck_id: 'after-hours',
        deck_title: 'After Hours',
        title: '10-minute neck & shoulder rub, no rushing',
        owed_by: 'me',
        redeemed: false,
        redeemed_at: null,
        created_at: now,
      },
    ],
    used_confirm_jtis: [],
    rotated_refresh_hashes: [],
  };
}

function normalizeDatabaseShape(parsed: Partial<CouplyDatabase>): CouplyDatabase {
  return {
    users: Array.isArray(parsed.users) ? parsed.users : [],
    otp_codes: Array.isArray(parsed.otp_codes) ? parsed.otp_codes : [],
    sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
    saved_cards: Array.isArray(parsed.saved_cards) ? parsed.saved_cards : [],
    ious: Array.isArray(parsed.ious) ? parsed.ious : [],
    used_confirm_jtis: Array.isArray(parsed.used_confirm_jtis) ? parsed.used_confirm_jtis : [],
    rotated_refresh_hashes: Array.isArray(parsed.rotated_refresh_hashes)
      ? parsed.rotated_refresh_hashes
      : [],
  };
}

function pruneExpiredTokens(db: CouplyDatabase): void {
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;

  db.otp_codes = db.otp_codes.filter((o) => {
    const exp = Date.parse(o.expires_at);
    return !o.used ? exp > now : exp > oneHourAgo;
  });
  db.used_confirm_jtis = (db.used_confirm_jtis || []).filter(
    (entry) => Date.parse(entry.expires_at) > now,
  );
  db.rotated_refresh_hashes = (db.rotated_refresh_hashes || []).filter(
    (entry) => Date.parse(entry.expires_at) > now,
  );
}

function ensureParentDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function writeFileDurableAtomic(filePath: string, content: string): void {
  ensureParentDir(filePath);
  const dir = path.dirname(filePath);
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const fd = fs.openSync(tempPath, 'w', 0o600);
  try {
    fs.writeFileSync(fd, content, { encoding: 'utf8' });
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tempPath, filePath);
}

function writeDbAtomic(db: CouplyDatabase, dbPath: string): void {
  const json = JSON.stringify(db, null, 2);
  // Preserve last known-good backup before swapping primary file
  if (fs.existsSync(dbPath)) {
    try {
      const existing = fs.readFileSync(dbPath, 'utf8');
      JSON.parse(existing);
      writeFileDurableAtomic(getBackupFilePath(dbPath), existing);
    } catch {
      // Existing primary file is corrupt; do not overwrite valid backup with corrupt content
    }
  }
  writeFileDurableAtomic(dbPath, json);
}

function readDbFromDisk(dbPath: string): CouplyDatabase {
  ensureParentDir(dbPath);
  if (!fs.existsSync(dbPath)) {
    const backupPath = getBackupFilePath(dbPath);
    if (fs.existsSync(backupPath)) {
      try {
        const backupRaw = fs.readFileSync(backupPath, 'utf8');
        const recovered = normalizeDatabaseShape(JSON.parse(backupRaw) as Partial<CouplyDatabase>);
        writeDbAtomic(recovered, dbPath);
        return recovered;
      } catch {
        // Ignore corrupt backup and fall through to seed
      }
    }
    const seed = createSeedDatabase();
    writeDbAtomic(seed, dbPath);
    return seed;
  }

  try {
    const raw = fs.readFileSync(dbPath, 'utf8');
    return normalizeDatabaseShape(JSON.parse(raw) as Partial<CouplyDatabase>);
  } catch (primaryErr) {
    const backupPath = getBackupFilePath(dbPath);
    if (fs.existsSync(backupPath)) {
      try {
        const backupRaw = fs.readFileSync(backupPath, 'utf8');
        const recovered = normalizeDatabaseShape(JSON.parse(backupRaw) as Partial<CouplyDatabase>);
        // Preserve corrupt primary copy for forensics instead of silently destroying it
        const corruptCopy = `${dbPath}.corrupt.${Date.now()}`;
        try {
          fs.copyFileSync(dbPath, corruptCopy);
        } catch {
          // Ignore forensic copy failure
        }
        writeDbAtomic(recovered, dbPath);
        return recovered;
      } catch {
        // Backup also corrupt
      }
    }
    throw primaryErr;
  }
}

// Single-process in-memory authoritative cache + serialized write queue
let activeDbPath: string | null = null;
let cachedDb: CouplyDatabase | null = null;
let mutationQueue: Promise<unknown> = Promise.resolve();
let pgPool: Pool | null = null;
let pgInitialized = false;

function describePgError(err: unknown, host: string | null): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (
    (msg.includes('ENETUNREACH') || msg.includes('EAI_AGAIN') || msg.includes('ENOTFOUND')) &&
    host &&
    /^db\.[^.]+\.supabase\.co$/i.test(host)
  ) {
    return 'Supabase direct host (db.*.supabase.co) requires IPv6; switch DATABASE_URL to the Supabase Session/Transaction Pooler URI (*.pooler.supabase.com).';
  }
  return msg.slice(0, 220);
}

function getPgPool(): { pool: Pool; host: string | null } | null {
  const connString = resolveExternalDatabaseUrl();
  if (!connString) return null;

  let parsedHost: string | null = null;
  let cleanedUrl = connString;
  let useSsl = !connString.includes('localhost') && !connString.includes('127.0.0.1');

  try {
    const u = new URL(connString);
    parsedHost = u.hostname || null;
    if (parsedHost === 'localhost' || parsedHost === '127.0.0.1') {
      useSsl = false;
    }
    // Strip sslmode from URL so pg-connection-string does not override rejectUnauthorized: false
    if (u.searchParams.has('sslmode')) {
      u.searchParams.delete('sslmode');
      cleanedUrl = u.toString();
    }
  } catch {
    // Keep raw connection string if URL parsing fails
  }

  if (!pgPool) {
    pgPool = new Pool({
      connectionString: cleanedUrl,
      max: 5,
      idleTimeoutMillis: 15_000,
      connectionTimeoutMillis: 8_000,
      ...(useSsl ? { ssl: { rejectUnauthorized: false } } : {}),
    });
    pgHealthState = {
      mode: 'local-json',
      configured: true,
      connected: false,
      host: parsedHost,
      lastError: null,
    };
  }
  return { pool: pgPool, host: parsedHost };
}

async function ensurePgTable(pool: Pool): Promise<void> {
  if (pgInitialized) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS couplova_state (
      id TEXT PRIMARY KEY,
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  pgInitialized = true;
}

async function hydrateFromPgOrLocal(dbPath: string): Promise<CouplyDatabase> {
  const pgInfo = getPgPool();
  if (!pgInfo) {
    pgHealthState = {
      mode: 'local-json',
      configured: false,
      connected: false,
      host: null,
      lastError: null,
    };
    return readDbFromDisk(dbPath);
  }

  const { pool, host } = pgInfo;
  try {
    await ensurePgTable(pool);
    const res = await pool.query<{ payload: Partial<CouplyDatabase> }>(
      'SELECT payload FROM couplova_state WHERE id = $1 LIMIT 1',
      ['main'],
    );
    if (res.rows.length > 0 && res.rows[0].payload) {
      const normalized = normalizeDatabaseShape(res.rows[0].payload);
      writeDbAtomic(normalized, dbPath);
      pgHealthState = {
        mode: 'postgresql',
        configured: true,
        connected: true,
        host,
        lastError: null,
      };
      console.log(`[Couplova Store] PostgreSQL connected (${host ?? 'remote'}): ${normalized.users.length} users hydrated.`);
      return normalized;
    }

    // First boot against empty Postgres: seed from local disk (or defaults) and store in Postgres
    const initial = readDbFromDisk(dbPath);
    await pool.query(
      `INSERT INTO couplova_state (id, payload, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (id) DO NOTHING`,
      ['main', JSON.stringify(initial)],
    );
    pgHealthState = {
      mode: 'postgresql',
      configured: true,
      connected: true,
      host,
      lastError: null,
    };
    console.log(`[Couplova Store] PostgreSQL initialized (${host ?? 'remote'}) with ${initial.users.length} users.`);
    return initial;
  } catch (err) {
    const safeError = describePgError(err, host);
    pgHealthState = {
      mode: 'local-json',
      configured: true,
      connected: false,
      host,
      lastError: safeError,
    };
    console.warn(
      '[Couplova Store] PostgreSQL unavailable, falling back to local disk store:',
      safeError,
    );
    return readDbFromDisk(dbPath);
  }
}

async function persistToPgAndDisk(db: CouplyDatabase, dbPath: string): Promise<void> {
  pruneExpiredTokens(db);
  writeDbAtomic(db, dbPath);

  const pgInfo = getPgPool();
  if (!pgInfo) return;

  const { pool, host } = pgInfo;
  try {
    await ensurePgTable(pool);
    await pool.query(
      `INSERT INTO couplova_state (id, payload, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE
       SET payload = EXCLUDED.payload, updated_at = NOW()`,
      ['main', JSON.stringify(db)],
    );
    pgHealthState = {
      mode: 'postgresql',
      configured: true,
      connected: true,
      host,
      lastError: null,
    };
  } catch (err) {
    const safeError = describePgError(err, host);
    pgHealthState = {
      mode: 'local-json',
      configured: true,
      connected: false,
      host,
      lastError: safeError,
    };
    console.warn(
      '[Couplova Store] PostgreSQL write warning (local backup saved):',
      safeError,
    );
  }
}

export function resetStoreCacheForTests(): void {
  activeDbPath = null;
  cachedDb = null;
  mutationQueue = Promise.resolve();
  pgInitialized = false;
  if (pgPool) {
    void pgPool.end().catch(() => {});
    pgPool = null;
  }
  pgHealthState = {
    mode: 'local-json',
    configured: false,
    connected: false,
    host: null,
    lastError: null,
  };
}

export async function initDatabase(): Promise<CouplyDatabase> {
  const dbPath = getDbFilePath();
  if (cachedDb && activeDbPath === dbPath) {
    return cachedDb;
  }
  const loaded = await hydrateFromPgOrLocal(dbPath);
  cachedDb = loaded;
  activeDbPath = dbPath;
  return loaded;
}

export function loadDatabase(): CouplyDatabase {
  const dbPath = getDbFilePath();
  if (cachedDb && activeDbPath === dbPath) {
    return cachedDb;
  }
  const loaded = readDbFromDisk(dbPath);
  cachedDb = loaded;
  activeDbPath = dbPath;
  return loaded;
}

export function saveDatabase(db: CouplyDatabase): void {
  const dbPath = getDbFilePath();
  pruneExpiredTokens(db);
  cachedDb = db;
  activeDbPath = dbPath;
  writeDbAtomic(db, dbPath);
}

/**
 * Serializes all database reads + mutations through a single FIFO queue so concurrent
 * requests (e.g., signup + heartbeat + OTP verification + token rotation) never overwrite
 * each other with stale snapshots.
 */
export function mutateDatabase<T>(mutator: (db: CouplyDatabase) => T | Promise<T>): Promise<T> {
  const task = mutationQueue.then(async () => {
    const dbPath = getDbFilePath();
    const db = await initDatabase();
    const workingCopy = normalizeDatabaseShape(structuredClone(db));
    const result = await mutator(workingCopy);
    await persistToPgAndDisk(workingCopy, dbPath);
    cachedDb = workingCopy;
    activeDbPath = dbPath;
    return result;
  });

  // Prevent a failed mutation from poisoning subsequent queued mutations
  mutationQueue = task.catch(() => {});
  return task;
}
