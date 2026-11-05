import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAuthDeepLink,
  buildDesktopOauthUrl,
  ensureDesktopParam,
  isExternalOAuthUrl,
  exchangeDesktopOtt,
  buildSessionCookies,
} from './desktop-auth.js';

test('parseAuthDeepLink extracts token and state', () => {
  const r = parseAuthDeepLink('alayachat://auth?token=abc&state=xyz');
  assert.deepEqual(r, { token: 'abc', state: 'xyz' });
});

test('parseAuthDeepLink returns null for non-auth deep links', () => {
  assert.equal(parseAuthDeepLink('alayachat://other?token=abc&state=xyz'), null);
  assert.equal(parseAuthDeepLink('https://chat.alaya.co/'), null);
  assert.equal(parseAuthDeepLink('alayachat://auth?token=abc'), null);
});

test('buildDesktopOauthUrl appends desktop=1', () => {
  assert.equal(
    buildDesktopOauthUrl('https://chat.alaya.co'),
    'https://chat.alaya.co/oauth/google?desktop=1',
  );
});

test('ensureDesktopParam appends desktop=1 when missing', () => {
  assert.equal(
    ensureDesktopParam('https://chat.alaya.co/oauth/google'),
    'https://chat.alaya.co/oauth/google?desktop=1',
  );
  assert.equal(
    ensureDesktopParam('https://chat.alaya.co/oauth/google?desktop=1'),
    'https://chat.alaya.co/oauth/google?desktop=1',
  );
});

test('isExternalOAuthUrl matches Google OAuth navigations on configured host', () => {
  const host = 'https://chat.alaya.co';
  assert.equal(isExternalOAuthUrl('https://chat.alaya.co/oauth/google', host), true);
  assert.equal(isExternalOAuthUrl('https://chat.alaya.co/oauth/google?desktop=1', host), true);
  assert.equal(
    isExternalOAuthUrl('https://accounts.google.com/o/oauth2/v2/auth?client_id=x', host),
    true,
  );
  assert.equal(isExternalOAuthUrl('https://chat.alaya.co/c/new', host), false);
  assert.equal(isExternalOAuthUrl('https://chat.alaya.co/oauth/google/callback', host), false);
  assert.equal(isExternalOAuthUrl('https://evil.example/oauth/google', host), false);
  assert.equal(
    isExternalOAuthUrl('https://chat.alaya.co/oauth/google', 'https://other.alaya.co'),
    false,
  );
});

test('exchangeDesktopOtt POSTs token/state and returns tokens', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      async json() {
        return { token: 'access-jwt', refreshToken: 'refresh-jwt' };
      },
    };
  };

  const tokens = await exchangeDesktopOtt({
    serverHost: 'https://chat.alaya.co',
    token: 'ott',
    state: 'st',
    fetchImpl,
  });

  assert.deepEqual(tokens, { token: 'access-jwt', refreshToken: 'refresh-jwt' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://chat.alaya.co/desktop/exchange');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), { token: 'ott', state: 'st' });
});

test('exchangeDesktopOtt throws on non-OK response', async () => {
  await assert.rejects(
    () =>
      exchangeDesktopOtt({
        serverHost: 'https://chat.alaya.co',
        token: 'ott',
        state: 'st',
        fetchImpl: async () => ({ ok: false, status: 401, async json() { return {}; } }),
      }),
    /401/,
  );
});

test('buildSessionCookies sets refreshToken and token_provider per discovery', () => {
  const cookies = buildSessionCookies({
    cookieUrl: 'https://chat.alaya.co',
    refreshToken: 'refresh-jwt',
  });
  assert.deepEqual(cookies, [
    {
      url: 'https://chat.alaya.co',
      name: 'refreshToken',
      value: 'refresh-jwt',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'strict',
    },
    {
      url: 'https://chat.alaya.co',
      name: 'token_provider',
      value: 'librechat',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'strict',
    },
  ]);
});
