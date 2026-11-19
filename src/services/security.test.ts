import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateOpaqueRefreshToken,
  generateSixDigitOtp,
  hashRefreshToken,
  hashSecret,
  signAccessToken,
  signAdminToken,
  signEmailConfirmToken,
  signGooglePendingToken,
  verifyAccessToken,
  verifyAdminToken,
  verifyEmailConfirmToken,
  verifyGooglePendingToken,
  verifySecret,
} from './security';
import {
  buildAdminOtpEmailTemplate,
  buildConfirmEmailTemplate,
  buildLoginOtpEmailTemplate,
  buildWelcomeEmailTemplate,
  escapeHtml,
} from './emails';

test('salted one-way password hashing verifies matches and rejects mismatches', () => {
  const hashA = hashSecret('CouplovaSecret123!');
  const hashB = hashSecret('CouplovaSecret123!');

  assert.notEqual(hashA, hashB); // Salted
  assert.equal(verifySecret('CouplovaSecret123!', hashA), true);
  assert.equal(verifySecret('WrongPassword!', hashA), false);
});

test('generateSixDigitOtp produces zero-padded 6-digit codes', () => {
  for (let i = 0; i < 20; i++) {
    const code = generateSixDigitOtp();
    assert.match(code, /^\d{6}$/);
  }
});

test('JWT access tokens sign, verify, and reject tampered or expired tokens', () => {
  const token = signAccessToken('user-1', 'sess-1', 'maya@couplova.app', 900);
  const payload = verifyAccessToken(token);
  assert.ok(payload);
  assert.equal(payload.sub, 'user-1');
  assert.equal(payload.sessionId, 'sess-1');
  assert.equal(payload.email, 'maya@couplova.app');

  // Tamper payload
  const [h, p, s] = token.split('.');
  const tampered = `${h}.${p}a.${s}`;
  assert.equal(verifyAccessToken(tampered), null);

  // Expired token
  const expired = signAccessToken('user-1', 'sess-1', 'maya@couplova.app', -10);
  assert.equal(verifyAccessToken(expired), null);
});

test('JWT tokenType separation prevents cross-endpoint token confusion including admin tokens', () => {
  const accessToken = signAccessToken('user-1', 'sess-1', 'maya@couplova.app', 900);
  const pendingToken = signGooglePendingToken('sub-1', 'maya@couplova.app', 'Maya Lin');
  const confirmToken = signEmailConfirmToken('user-1', 'maya@couplova.app', 600);
  const adminToken = signAdminToken('daveking248@gmail.com', 3600);

  assert.equal(verifyAccessToken(pendingToken), null);
  assert.equal(verifyAccessToken(confirmToken), null);
  assert.equal(verifyAccessToken(adminToken), null);
  assert.equal(verifyGooglePendingToken(accessToken), null);
  assert.equal(verifyGooglePendingToken(confirmToken), null);
  assert.equal(verifyGooglePendingToken(adminToken), null);
  assert.equal(verifyEmailConfirmToken(accessToken), null);
  assert.equal(verifyEmailConfirmToken(pendingToken), null);
  assert.equal(verifyEmailConfirmToken(adminToken), null);
  assert.equal(verifyAdminToken(accessToken), null);
  assert.equal(verifyAdminToken(pendingToken), null);
  assert.equal(verifyAdminToken(confirmToken), null);

  const validAdmin = verifyAdminToken(adminToken);
  assert.ok(validAdmin);
  assert.equal(validAdmin.role, 'owner');
  assert.equal(validAdmin.email, 'daveking248@gmail.com');
  assert.equal(verifyAdminToken(signAdminToken('daveking248@gmail.com', -5)), null);

  const validConfirm = verifyEmailConfirmToken(confirmToken);
  assert.ok(validConfirm);
  assert.ok(validConfirm.jti);
  assert.equal(verifyEmailConfirmToken(signEmailConfirmToken('user-1', 'maya@couplova.app', -5)), null);
});

test('opaque refresh token hashing is deterministic', () => {
  const raw = generateOpaqueRefreshToken();
  assert.ok(raw.length >= 32);
  assert.equal(hashRefreshToken(raw), hashRefreshToken(raw));
});

test('transactional email templates include expiry, ignore copy, Couplova branding, and HTML escaping', () => {
  const confirm = buildConfirmEmailTemplate({
    email: 'romeo@couplova.app',
    partnerName: '<script>alert(1)</script>Juliet',
    code: '482910',
    confirmUrl: 'https://couplova.app/?confirm=abc',
    expiryMinutes: 10,
  });
  assert.ok(confirm.html.includes('Confirm Email Address'));
  assert.ok(confirm.html.includes('Couplova'));
  assert.ok(confirm.html.includes('482910'));
  assert.ok(confirm.html.includes('Expires in 10 minutes'));
  assert.ok(confirm.html.includes("If you didn&#39;t request this, you can safely ignore this email."));
  assert.equal(confirm.html.includes('<script>'), false);
  assert.ok(confirm.html.includes(escapeHtml('<script>alert(1)</script>Juliet')));

  const welcome = buildWelcomeEmailTemplate({
    fullName: 'Romeo Montague',
    partnerName: 'Juliet',
    appUrl: 'https://couplova.app',
  });
  assert.ok(welcome.html.includes('Welcome, Romeo'));
  assert.ok(welcome.html.includes('Open Couplova'));

  const loginOtp = buildLoginOtpEmailTemplate({
    email: 'romeo@couplova.app',
    partnerName: 'Juliet',
    code: '910283',
    expiryMinutes: 10,
  });
  assert.ok(loginOtp.html.includes('910283'));
  assert.ok(loginOtp.html.includes('Expires in 10 minutes'));
  assert.ok(loginOtp.html.includes("not trying to log in right now, you can safely ignore this email"));

  const adminOtp = buildAdminOtpEmailTemplate({
    email: 'daveking248@gmail.com',
    code: '551199',
    expiryMinutes: 10,
  });
  assert.ok(adminOtp.html.includes('551199'));
  assert.ok(adminOtp.html.includes('Owner Console Sign-In'));
});
