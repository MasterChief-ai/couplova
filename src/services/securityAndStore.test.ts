import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  hashSecret,
  signAccessToken,
  signAdminToken,
  signEmailConfirmToken,
  timingSafeStringEqual,
  verifyAccessToken,
  verifyAdminToken,
  verifyEmailConfirmToken,
  verifySecret,
} from './security';
import {
  getDatabaseHealth,
  initDatabase,
  isExternalDatabaseConfigured,
  mutateDatabase,
  resetStoreCacheForTests,
  resolveExternalDatabaseUrl,
} from './store';

test('timingSafeStringEqual handles equal strings, mismatched lengths, and mismatched characters', () => {
  assert.equal(timingSafeStringEqual('secret-passphrase', 'secret-passphrase'), true);
  assert.equal(timingSafeStringEqual('secret-passphrase', 'secret-passphrasE'), false);
  assert.equal(timingSafeStringEqual('short', 'much-longer-string'), false);
  assert.equal(timingSafeStringEqual('', ''), true);
});

test('verifySecret verifies valid scrypt hashes and safely rejects malformed hashes', () => {
  const hashed = hashSecret('Verona1597!');
  assert.equal(verifySecret('Verona1597!', hashed), true);
  assert.equal(verifySecret('WrongPass1!', hashed), false);

  // Malformed hashes must return false rather than throwing or returning true
  assert.equal(verifySecret('anything', ''), false);
  assert.equal(verifySecret('anything', 'nocolon'), false);
  assert.equal(verifySecret('anything', 'salt:shorthex'), false);
  assert.equal(verifySecret('anything', `salt:${'z'.repeat(128)}`), false);
  // @ts-expect-error testing runtime defense against non-string inputs
  assert.equal(verifySecret(null, hashed), false);
});

test('JWT signing/verification enforces tokenType isolation, expiry, length bounds, and object shapes', () => {
  const access = signAccessToken('user-1', 'sess-1', 'maya@couplova.app', 60);
  const decoded = verifyAccessToken(access);
  assert.ok(decoded);
  assert.equal(decoded.sub, 'user-1');
  assert.equal(decoded.sessionId, 'sess-1');

  // Token type confusion must fail
  assert.equal(verifyAdminToken(access), null);
  assert.equal(verifyEmailConfirmToken(access), null);

  const adminTok = signAdminToken('daveking248@gmail.com', 60);
  assert.ok(verifyAdminToken(adminTok));
  assert.equal(verifyAccessToken(adminTok), null);

  const confirmTok = signEmailConfirmToken('user-1', 'maya@couplova.app', -10);
  assert.equal(verifyEmailConfirmToken(confirmTok), null);

  // Oversized tokens rejected before parsing
  assert.equal(verifyAccessToken('a'.repeat(5000)), null);
  // Tampered signature rejected
  const parts = access.split('.');
  const tamperedPayload = Buffer.from(
    JSON.stringify({ tokenType: 'access', sub: 'hacker', sessionId: 's', email: 'h@x.com', iat: 1, exp: 9999999999 }),
  )
    .toString('base64url');
  assert.equal(verifyAccessToken(`${parts[0]}.${tamperedPayload}.${parts[2]}`), null);
});

test('isExternalDatabaseConfigured & resolveExternalDatabaseUrl handle placeholders, quotes, and aliases', () => {
  const prev = process.env.DATABASE_URL;
  const prevPg = process.env.POSTGRES_URL;
  const prevSupa = process.env.SUPABASE_DB_URL;
  try {
    delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_URL;
    delete process.env.SUPABASE_DB_URL;
    assert.equal(isExternalDatabaseConfigured(), false);
    assert.equal(getDatabaseHealth().configured, false);

    process.env.DATABASE_URL = 'postgresql://postgres:[YOUR-PASSWORD]@db.[YOUR-PROJECT-REF].supabase.co:5432/postgres';
    assert.equal(isExternalDatabaseConfigured(), false);

    process.env.DATABASE_URL = '"postgresql://couplova:realpass@db.example.com:5432/couplova?sslmode=require"';
    assert.equal(isExternalDatabaseConfigured(), true);
    assert.equal(
      resolveExternalDatabaseUrl(),
      'postgresql://couplova:realpass@db.example.com:5432/couplova?sslmode=require',
    );

    delete process.env.DATABASE_URL;
    process.env.SUPABASE_DB_URL = 'postgres://user:pw@aws-0.pooler.supabase.com:6543/postgres';
    assert.equal(isExternalDatabaseConfigured(), true);
  } finally {
    if (prev === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prev;
    if (prevPg === undefined) delete process.env.POSTGRES_URL;
    else process.env.POSTGRES_URL = prevPg;
    if (prevSupa === undefined) delete process.env.SUPABASE_DB_URL;
    else process.env.SUPABASE_DB_URL = prevSupa;
  }
});

test('store mutateDatabase serializes concurrent mutations without losing writes or erroring next jobs', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'couplova-store-test-'));
  const dbPath = path.join(tmpDir, 'db.json');
  const prevDbPath = process.env.COUP_DB_PATH;
  const prevDbUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  process.env.COUP_DB_PATH = dbPath;
  resetStoreCacheForTests();

  try {
    await initDatabase();

    // Queue 1 user signup + 5 concurrent updates + 1 failing mutation concurrently
    const failing = mutateDatabase(() => {
      throw new Error('Simulated handler failure');
    }).catch((err: Error) => err.message);

    const signup = mutateDatabase(async (db) => {
      await new Promise((r) => setTimeout(r, 15));
      db.users.push({
        id: 'u-concurrent-1',
        full_name: 'Clara',
        username: 'clara_c',
        email: 'clara@example.com',
        country: '',
        date_of_birth: '',
        partner_name: 'Leo',
        password_hash: 'h',
        google_sub: null,
        gender_theme: 'female',
        active_deck_theme: 'default',
        is_verified: true,
        last_seen_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      });
    });

    const iouAdds = Array.from({ length: 5 }, (_, idx) =>
      mutateDatabase((db) => {
        db.ious.push({
          id: `iou-${idx}`,
          user_id: 'u-concurrent-1',
          card_id: 'ah-23',
          deck_id: 'after-hours',
          deck_title: 'After Hours',
          title: `Task ${idx}`,
          owed_by: 'partner',
          redeemed: false,
          redeemed_at: null,
          created_at: new Date().toISOString(),
        });
      }),
    );

    const [failResult] = await Promise.all([failing, signup, ...iouAdds]);
    assert.equal(failResult, 'Simulated handler failure');

    // Clear memory cache to verify disk holds EVERY write
    resetStoreCacheForTests();
    const persisted = await initDatabase();
    assert.ok(persisted.users.some((u) => u.id === 'u-concurrent-1'));
    for (let idx = 0; idx < 5; idx++) {
      assert.ok(persisted.ious.some((i) => i.id === `iou-${idx}`));
    }
  } finally {
    resetStoreCacheForTests();
    if (prevDbPath === undefined) delete process.env.COUP_DB_PATH;
    else process.env.COUP_DB_PATH = prevDbPath;
    if (prevDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDbUrl;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('store recovers accounts automatically from .bak if primary JSON is corrupted (never silently wipes to seed)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'couplova-backup-test-'));
  const dbPath = path.join(tmpDir, 'db.json');
  const prevDbPath = process.env.COUP_DB_PATH;
  const prevDbUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  process.env.COUP_DB_PATH = dbPath;
  resetStoreCacheForTests();

  try {
    await initDatabase();
    // Write 1: adds custom user
    await mutateDatabase((db) => {
      db.users.push({
        id: 'u-preserved',
        full_name: 'Preserved User',
        username: 'preserved_user',
        email: 'preserved@example.com',
        country: '',
        date_of_birth: '',
        partner_name: 'Alex',
        password_hash: 'h',
        google_sub: null,
        gender_theme: 'male',
        active_deck_theme: 'default',
        is_verified: true,
        last_seen_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      });
    });
    // Write 2: rotates preserved state into .bak as well as primary
    await mutateDatabase((db) => {
      const target = db.users.find((u) => u.id === 'u-preserved');
      if (target) target.partner_name = 'Alex Updated';
    });

    // Simulate power-loss corruption of primary db.json while .bak remains intact
    fs.writeFileSync(dbPath, '{corrupted-json-truncated', 'utf8');
    resetStoreCacheForTests();

    const recovered = await initDatabase();
    const preserved = recovered.users.find((u) => u.id === 'u-preserved');
    assert.ok(preserved, 'Preserved user must survive primary file corruption via .bak recovery');

    const forensicFiles = fs.readdirSync(tmpDir).filter((f) => f.includes('.corrupt.'));
    assert.equal(forensicFiles.length, 1);
    assert.ok(crypto.createHash('sha256').update(JSON.stringify(recovered)).digest('hex').length === 64);
  } finally {
    resetStoreCacheForTests();
    if (prevDbPath === undefined) delete process.env.COUP_DB_PATH;
    else process.env.COUP_DB_PATH = prevDbPath;
    if (prevDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDbUrl;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
