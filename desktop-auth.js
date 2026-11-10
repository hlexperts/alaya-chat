/**
 * Pure helpers for Alaya Chat desktop Google SSO handoff.
 * Cookie contract (DISCOVERY): refreshToken + token_provider=librechat;
 * access JWT comes from SPA POST /api/auth/refresh after cookies are set.
 */

export const DEFAULT_HOST = 'https://chat.alaya.co';
export const PARTITION = 'persist:alaya-chat';
export const PROTOCOL = 'alayachat';

export function normalizeServerHost(serverHost) {
  if (!serverHost) return DEFAULT_HOST;
  const trimmed = String(serverHost).trim().replace(/\/+$/, '');
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

export function parseAuthDeepLink(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== `${PROTOCOL}:`) return null;
    // alayachat://auth?... → hostname "auth"
    if (parsed.hostname !== 'auth') return null;
    const token = parsed.searchParams.get('token');
    const state = parsed.searchParams.get('state');
    if (!token || !state) return null;
    return { token, state };
  } catch {
    return null;
  }
}

export function buildDesktopOauthUrl(serverHost) {
  const base = normalizeServerHost(serverHost);
  // TECHY-1984: Chat login is Google OpenID, not Google social.
  return `${base}/oauth/openid?desktop=1`;
}

export function ensureDesktopParam(url) {
  const parsed = new URL(url);
  if (!parsed.searchParams.has('desktop')) {
    parsed.searchParams.set('desktop', '1');
  }
  return parsed.toString();
}

export function isExternalOAuthUrl(url, serverHost = DEFAULT_HOST) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'accounts.google.com') return true;
    // Initiate OpenID only on the configured server host — not the callback
    // and not arbitrary /oauth/openid paths on other hosts.
    const expectedHost = new URL(normalizeServerHost(serverHost)).host;
    if (parsed.host !== expectedHost) return false;
    if (
      parsed.pathname === '/oauth/openid' ||
      parsed.pathname.endsWith('/oauth/openid')
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export async function exchangeDesktopOtt({
  serverHost,
  token,
  state,
  fetchImpl = globalThis.fetch,
}) {
  const base = normalizeServerHost(serverHost);
  const res = await fetchImpl(`${base}/desktop/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, state }),
  });
  if (!res.ok) {
    throw new Error(`desktop exchange failed: ${res.status}`);
  }
  return res.json();
}

/**
 * Cookie descriptors matching LibreChat setAuthTokens (DISCOVERY).
 * Access JWT is not a cookie — SPA silentRefresh uses these cookies.
 */
export function buildSessionCookies({ cookieUrl, refreshToken }) {
  const url = normalizeServerHost(cookieUrl);
  const common = {
    url,
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'strict',
  };
  return [
    { ...common, name: 'refreshToken', value: refreshToken },
    { ...common, name: 'token_provider', value: 'librechat' },
  ];
}

export async function applySessionCookies(cookieStore, { cookieUrl, refreshToken }) {
  const cookies = buildSessionCookies({ cookieUrl, refreshToken });
  for (const cookie of cookies) {
    await cookieStore.set(cookie);
  }
  return cookies;
}

export function findDeepLinkInArgv(argv = []) {
  return argv.find((arg) => typeof arg === 'string' && arg.startsWith(`${PROTOCOL}://`)) || null;
}
