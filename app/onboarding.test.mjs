import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');

test('App onboarding uses the Console V2 email claim endpoints', () => {
  assert.match(source, /\/api\/v2\/account-email-bindings\/challenges/);
  assert.match(source, /\/api\/v2\/account-email-bindings\/verify/);
  assert.match(source, /autocomplete="one-time-code"/);
  assert.match(source, /不要把验证码发给 Agent/);
});

test('Unauthenticated App users can sign in with a bound email OTP', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  assert.match(html, /id="console-email-login-form"/);
  assert.match(html, /id="console-email-verify-form"/);
  assert.match(html, /autocomplete="email"/);
  assert.match(html, /autocomplete="one-time-code"/);
  assert.match(source, /\/api\/v2\/auth\/email\/challenges/);
  assert.match(source, /\/api\/v2\/auth\/email\/verify/);
  assert.match(source, /purpose: 'login'/);
  assert.match(source, /EMAIL_NOT_BOUND/);
});

test('App onboarding saves a full draft before explicit step confirmation', () => {
  assert.match(source, /\/api\/v2\/console\/onboarding-draft/);
  assert.match(source, /expected_revision/);
  assert.match(source, /\/api\/v2\/agents\/me\/onboarding-draft\/confirm/);
  assert.match(source, /expected_onboarding_revision/);
  assert.match(source, /idempotency_key/);
});

test('App onboarding exposes all five owner-controlled stages', () => {
  for (const label of ['邮箱认领', 'Agent Card', '网络目标', '意图规则', '安全边界']) {
    assert.match(source, new RegExp(label));
  }
  assert.match(source, /name="understood" type="checkbox" required/);
});
