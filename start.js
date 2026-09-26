// Starts OpenClaw the way velixir runs apps: as a sandbox whose settings come from environment
// variables and whose state is thrown away on every restart.
//
// OpenClaw's gateway (the agent, its web Control UI and its chat channels) normally keeps a config
// file and a state directory on a disk it expects to keep, and is set up once through an
// interactive onboarding. On velixir the disk is wiped on every restart and redeploy, and there is
// no terminal. So this file:
//
//   1. Rebuilds OpenClaw's config from the environment on every boot, so a restart comes back
//      configured and only state (chats, memory, workspace, paired browsers) resets.
//   2. Keeps the gateway locked. It requires its token (OPENCLAW_GATEWAY_TOKEN, or a random one
//      generated at boot and printed once to the log) and listens on loopback only. Everything
//      from the internet reaches it through the small proxy below, which tells it the real client
//      address so it never mistakes a visitor for a local process.
//   3. Serves the pages OpenClaw itself cannot: a setup page while no AI provider key is set
//      (never a crash loop), and /velixir/pair, where the owner enters the token and gets
//      OpenClaw's own one-time owner link for this browser. Upstream documents that link, from
//      `openclaw dashboard`, as the way to connect a browser from the gateway's host; velixir has
//      no shell to run it in, so this page runs it on the owner's behalf.
//
// Nothing here weakens OpenClaw's own checks: the token, device pairing, origin checks and rate
// limits are all still the gateway's, and it refuses anything that did not come through the proxy.

'use strict';

const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const PORT = Number(process.env.PORT || 8080);
// The gateway's private port. Only $PORT is routed from the internet; this one never leaves the
// container because the gateway binds it on loopback.
const GATEWAY_PORT = PORT === 18789 ? 18790 : 18789;
const OPENCLAW_ENTRY = path.join(__dirname, 'node_modules', 'openclaw', 'openclaw.mjs');
const OPENCLAW_VERSION = readOpenClawVersion();
const BOOT_ID = crypto.randomBytes(9).toString('base64url');
const MIN_TOKEN_LENGTH = 24;

// ─── Settings from the environment ──────────────────────────────────────────

const env = (name) => {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : '';
};

// Providers bundled in the openclaw npm package, with the model this template starts on. The first
// key found wins; OPENCLAW_MODEL picks any other model (or provider) instead. Anthropic starts on
// Opus 5.5, the newest Opus in this OpenClaw release's catalog (OpenClaw's own default is still
// Opus 5); anthropic/claude-sonnet-5 costs less per token.
const PROVIDERS = [
  { key: 'ANTHROPIC_API_KEY', name: 'Anthropic', model: 'anthropic/claude-opus-5-5' },
  { key: 'OPENAI_API_KEY', name: 'OpenAI', model: 'openai/gpt-6-astra' },
  { key: 'GEMINI_API_KEY', name: 'Google Gemini', model: 'google/gemini-3.1-pro-preview' },
  { key: 'OPENROUTER_API_KEY', name: 'OpenRouter', model: 'openrouter/auto' },
  { key: 'XAI_API_KEY', name: 'xAI', model: 'xai/grok-4.7' },
];

// Variables only this file reads. They are not passed on to OpenClaw.
const TEMPLATE_VARS = ['OPENCLAW_MODEL', 'OPENCLAW_CONFIG_JSON', 'TELEGRAM_ALLOW_FROM'];

const problems = []; // shown on the setup page; nothing starts while there are any

const provider = PROVIDERS.find((p) => env(p.key));
const model = env('OPENCLAW_MODEL') || (provider ? provider.model : '');
if (!provider && !env('OPENCLAW_MODEL')) {
  problems.push({
    name: 'ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY or XAI_API_KEY',
    fix: 'set the API key of the AI provider OpenClaw should use. For another provider, set its key and OPENCLAW_MODEL.',
  });
}
if (env('OPENCLAW_MODEL') && !/^[a-z0-9][\w.-]*\/\S+$/i.test(env('OPENCLAW_MODEL'))) {
  problems.push({ name: 'OPENCLAW_MODEL', fix: 'use the provider/model form, for example anthropic/claude-sonnet-5.' });
}

const tokenFromEnv = env('OPENCLAW_GATEWAY_TOKEN');
const gatewayToken = tokenFromEnv || crypto.randomBytes(32).toString('base64url');
if (tokenFromEnv && (tokenFromEnv.length < MIN_TOKEN_LENGTH || /\s/.test(tokenFromEnv)
    || /^(undefined|null|changeme|change-me|your-token.*|replace-with.*)$/i.test(tokenFromEnv))) {
  problems.push({
    name: 'OPENCLAW_GATEWAY_TOKEN',
    fix: `use a long random value of at least ${MIN_TOKEN_LENGTH} characters with no spaces (openssl rand -hex 32 makes one), or remove it to have one generated on every start.`,
  });
}

const publicUrl = resolvePublicUrl();
const allowedOrigins = [...new Set([
  publicUrl && new URL(publicUrl).origin,
  env('VELIXIR_APP_SLUG') && `https://${env('VELIXIR_APP_SLUG')}.velixir.run`,
].filter(Boolean))];

const telegramToken = env('TELEGRAM_BOT_TOKEN');
const telegramAllowFrom = parseTelegramAllowFrom(env('TELEGRAM_ALLOW_FROM'));
if (telegramToken && !/^\d+:[\w-]{20,}$/.test(telegramToken)) {
  console.warn('TELEGRAM_BOT_TOKEN does not look like a token from @BotFather (123456789:AA...). Starting anyway; OpenClaw will report what Telegram says.');
}

const extraConfig = parseExtraConfig(env('OPENCLAW_CONFIG_JSON'));

function resolvePublicUrl() {
  const raw = env('PUBLIC_URL')
    || (env('VELIXIR_APP_SLUG') ? `https://${env('VELIXIR_APP_SLUG')}.velixir.run` : `http://localhost:${PORT}`);
  try {
    const url = new URL(raw);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) return url.origin;
  } catch { /* reported below */ }
  problems.push({ name: 'PUBLIC_URL', fix: 'use the https:// address of the app, for example https://claw.example.com, with no path.' });
  return '';
}

function parseTelegramAllowFrom(raw) {
  if (!raw) return [];
  const ids = [];
  for (const part of raw.split(/[\s,]+/).filter(Boolean)) {
    const id = part.replace(/^(telegram|tg):/i, '');
    if (/^\d{1,20}$/.test(id)) ids.push(id);
    else {
      problems.push({ name: 'TELEGRAM_ALLOW_FROM', fix: `"${part}" is not a numeric Telegram user ID. Use numbers only, separated by commas (your bot tells you yours when you message it).` });
      return [];
    }
  }
  return ids;
}

function parseExtraConfig(raw) {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch { /* reported below */ }
  problems.push({ name: 'OPENCLAW_CONFIG_JSON', fix: 'must be a JSON object, for example {"agents":{"defaults":{"heartbeat":{"every":"30m"}}}}.' });
  return null;
}

function readOpenClawVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'node_modules', 'openclaw', 'package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

// ─── OpenClaw's config, rebuilt on every boot ───────────────────────────────

// The state directory is OpenClaw's whole memory: config, SQLite databases, workspace, paired
// devices, channel approvals. It lives on the container disk, so it is gone after a restart
// anyway; clearing it at boot makes a local `docker restart` behave the same way. It sits in this
// app's own folder rather than OpenClaw's usual ~/.openclaw, so running the template on a machine
// where you also use OpenClaw never touches your own. A directory you point OPENCLAW_STATE_DIR at
// yourself is never cleared.
const stateDirFromEnv = env('OPENCLAW_STATE_DIR');
const stateDir = stateDirFromEnv || path.join(__dirname, '.openclaw');
const configPath = path.join(stateDir, 'openclaw.json');

function buildConfig() {
  const config = {
    gateway: {
      publicOrigin: publicUrl,
      controlUi: {
        // The browser origins allowed to open the Control UI's WebSocket. Written out even though
        // newer OpenClaw releases derive it from publicOrigin: 2026.9.6 checks only this list.
        allowedOrigins,
        // Hides the sidebar card inviting you to OpenClaw's own Discord community. It is
        // upstream's, not velixir's; set it back to true in OPENCLAW_CONFIG_JSON to show it.
        communityInvite: false,
      },
    },
    agents: {
      defaults: {
        model: { primary: model },
        // The heartbeat is a model call every 30 minutes, whether anyone is chatting or not.
        // Off by default here so a forgotten sandbox does not spend your credit.
        heartbeat: { every: '0m' },
      },
    },
    // Updates come from the version pinned in package.json, not from a check at every start.
    update: { checkOnStart: false },
  };

  if (telegramToken) {
    // Long polling: outbound HTTPS only, so no webhook has to be routed. The token itself is read
    // from TELEGRAM_BOT_TOKEN. Strangers who find the bot get nowhere: with an allowlist they are
    // ignored, and without one they get a pairing code that the owner has to approve.
    config.channels = {
      telegram: telegramAllowFrom.length
        ? { enabled: true, dmPolicy: 'allowlist', allowFrom: telegramAllowFrom }
        : { enabled: true, dmPolicy: 'pairing' },
    };
    if (telegramAllowFrom.length) config.commands = { ownerAllowFrom: [`telegram:${telegramAllowFrom[0]}`] };
  }

  if (extraConfig) deepMerge(config, extraConfig);

  // Re-applied after OPENCLAW_CONFIG_JSON so it cannot turn off the lock: the gateway always
  // requires its token, listens on loopback only, and trusts forwarded addresses only from the
  // proxy in this file.
  const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (!isObject(config.gateway)) config.gateway = {};
  Object.assign(config.gateway, {
    mode: 'local',
    port: GATEWAY_PORT,
    bind: 'loopback',
    trustedProxies: ['127.0.0.1', '::1'],
  });
  config.gateway.auth = { ...(isObject(config.gateway.auth) ? config.gateway.auth : {}), mode: 'token' };
  delete config.gateway.auth.token; // the token comes from OPENCLAW_GATEWAY_TOKEN, never the file
  return config;
}

function deepMerge(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (value && typeof value === 'object' && !Array.isArray(value)
        && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      deepMerge(target[key], value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

function writeConfig() {
  if (!stateDirFromEnv) fs.rmSync(stateDir, { recursive: true, force: true });
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath, `${JSON.stringify(buildConfig(), null, 2)}\n`, { mode: 0o600 });
}

// What the gateway (and the CLI this file runs for owner links) gets: your environment, minus the
// port this file owns and the variables only this file reads.
function openclawEnv() {
  const childEnv = { ...process.env };
  for (const name of ['PORT', 'OPENCLAW_GATEWAY_PORT', 'OPENCLAW_GATEWAY_PASSWORD', ...TEMPLATE_VARS]) delete childEnv[name];
  Object.assign(childEnv, {
    OPENCLAW_GATEWAY_TOKEN: gatewayToken,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_WORKSPACE_DIR: childEnv.OPENCLAW_WORKSPACE_DIR || path.join(stateDir, 'workspace'),
    OPENCLAW_NO_AUTO_UPDATE: '1',
    NODE_ENV: childEnv.NODE_ENV || 'production',
  });
  if (!childEnv.OPENCLAW_DISABLE_BONJOUR) childEnv.OPENCLAW_DISABLE_BONJOUR = '1';
  return childEnv;
}

// ─── Pages ──────────────────────────────────────────────────────────────────

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function page(title, body, { refresh = 0 } = {}) {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ''}
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; background:#0b0b10; color:#e8e8ef;
         font:15px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif; }
  .wrap { max-width:38rem; margin:0 auto; padding:3rem 1.25rem 4rem; }
  h1 { font-size:1.5rem; margin:0 0 .25rem; letter-spacing:-.02em; }
  .sub { color:#9a9aac; margin:0 0 2rem; }
  code { background:#16161f; border:1px solid #26263a; border-radius:5px;
         padding:.1rem .35rem; color:#fca5a5; font-size:.8125rem; overflow-wrap:anywhere; }
  ol, ul { padding-left:1.25rem; margin:0 0 1.5rem; }
  li { margin-bottom:.9rem; }
  .problems li { color:#fecaca; }
  .note { color:#8a8a9c; font-size:.8125rem; }
  .error { color:#fca5a5; }
  form { display:flex; flex-direction:column; gap:.75rem; margin:0 0 1.5rem; }
  input[type=password] { background:#12121a; border:1px solid #2e2e44; border-radius:8px; color:#e8e8ef;
         padding:.7rem .85rem; font:inherit; width:100%; }
  button { background:#ef4444; border:0; border-radius:8px; color:#fff; font:inherit; font-weight:600;
         padding:.7rem 1rem; cursor:pointer; }
  a { color:#fca5a5; }
  table { border-collapse:collapse; width:100%; margin:0 0 1.5rem; font-size:.875rem; }
  td { border-top:1px solid #20202e; padding:.5rem .5rem .5rem 0; vertical-align:top; }
  .hidden { display:none; }
  footer { color:#4b4b5c; font-size:.75rem; margin-top:2.5rem; text-align:center; }
  footer a { color:#7a7a8c; }
</style>
<div class="wrap">
  ${body}
  <footer>OpenClaw sandbox, running on <a href="https://velixir.net">velixir</a></footer>
</div>
</html>`;
}

const SANDBOX_NOTE = `<p class="note">This is a sandbox: chats, memory, the workspace, paired browsers and Telegram
  approvals are wiped whenever the app restarts or redeploys. Settings come back from the environment variables.</p>`;

function setupPage() {
  const items = problems.map((p) => `<li><code>${escapeHtml(p.name)}</code>: ${escapeHtml(p.fix)}</li>`).join('');
  return page('Finish setting up OpenClaw', `
  <h1>Finish setting up OpenClaw</h1>
  <p class="sub">The app is running, but OpenClaw starts only once these are sorted out.</p>
  <ul class="problems">${items}</ul>
  <ol>
    <li>Open the app's <strong>Environment</strong> tab on velixir and set the variables above.
      Mark API keys and tokens as secret.</li>
    <li>Save. Changing a variable redeploys the app, and OpenClaw starts with the new settings.</li>
  </ol>
  <table>
    <tr><td><code>OPENCLAW_GATEWAY_TOKEN</code></td><td>The token you sign in with, at least ${MIN_TOKEN_LENGTH} characters.
      Without it a new one is generated on every start and printed in the log.</td></tr>
    <tr><td><code>OPENCLAW_MODEL</code></td><td>The model to use, for example <code>anthropic/claude-sonnet-5</code>.</td></tr>
    <tr><td><code>TELEGRAM_BOT_TOKEN</code></td><td>A bot token from @BotFather, to chat with OpenClaw on Telegram.</td></tr>
    <tr><td><code>TELEGRAM_ALLOW_FROM</code></td><td>Numeric Telegram user IDs allowed to talk to the bot, separated by commas.</td></tr>
  </table>
  ${SANDBOX_NOTE}`);
}

const startingPage = () => page('Starting OpenClaw', `
  <h1>Starting OpenClaw</h1>
  <p class="sub">This takes about half a minute. The page refreshes on its own.</p>
  ${SANDBOX_NOTE}`, { refresh: 5 });

const failedPage = (reason) => page('OpenClaw did not start', `
  <h1>OpenClaw did not start</h1>
  <p class="sub">${escapeHtml(reason)}</p>
  <p>The app's log has OpenClaw's own message just above this. If it names a setting, fix it on the
    <strong>Environment</strong> tab: saving redeploys the app. Otherwise, redeploy to try again.</p>`);

function pairPage({ error = '' } = {}) {
  return page('Connect this browser', `
  <h1>Connect this browser</h1>
  <p class="sub">This OpenClaw sandbox opens only for its owner. Enter the gateway token and this browser
    connects as the owner. It takes a few seconds.</p>
  <form method="post" action="/velixir/pair">
    <input class="hidden" type="text" name="username" value="openclaw" autocomplete="username" tabindex="-1" aria-hidden="true">
    <input type="password" name="token" placeholder="Gateway token" aria-label="Gateway token"
           autocomplete="current-password" required autofocus>
    <button type="submit">Connect</button>
  </form>
  ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
  <p class="note">The token is <code>OPENCLAW_GATEWAY_TOKEN</code> from the app's Environment tab. If you have not
    set one, it is the token printed in the app's log when it started, and it changes on every restart.</p>
  <p class="note">Already connected in this browser since the last restart?
    <a href="/velixir/continue">Open the Control UI</a>.</p>
  ${SANDBOX_NOTE}`);
}

const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

function sendHtml(res, status, html, extraHeaders = {}) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS, ...extraHeaders });
  res.end(html);
}

function redirect(res, location, extraHeaders = {}) {
  res.writeHead(303, { location, ...SECURITY_HEADERS, ...extraHeaders });
  res.end();
}

// ─── Who is asking ──────────────────────────────────────────────────────────

// The visitor's address. velixir's edge passes it in X-Forwarded-For and X-Real-IP; the gateway
// gets exactly one address from us, never a chain it would have to trust. A loopback or garbage
// value is not passed through as a client address: the gateway would refuse it anyway.
function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  for (const candidate of [forwarded, req.headers['x-real-ip'], req.socket.remoteAddress]) {
    const ip = String(candidate || '').trim().replace(/^::ffff:/i, '');
    if (net.isIP(ip) && !/^(127\.|::1$|0\.0\.0\.0$|::$)/.test(ip)) return ip;
  }
  return String(req.socket.remoteAddress || '127.0.0.1').replace(/^::ffff:/i, '');
}

const requestProto = (req) => (String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https'
  ? 'https' : (publicUrl.startsWith('https:') && !isLocalRequest(req) ? 'https' : 'http'));

const isLocalRequest = (req) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(req.headers.host || '');

// The origin the browser is on, when it is one the gateway accepts; otherwise the public URL.
function browserOrigin(req) {
  const origin = `${requestProto(req)}://${req.headers.host || ''}`;
  return allowedOrigins.includes(origin) ? origin : publicUrl;
}

// A hint, not a lock: set once this browser has connected since the gateway last started, so the
// bare address goes straight to the Control UI instead of the connect page. The gateway still
// checks the token and the paired device on every connection.
const cookieName = (req) => (isLocalRequest(req) ? 'openclaw_connected' : '__Host-openclaw_connected');
function hasConnectedCookie(req) {
  const name = cookieName(req);
  return (req.headers.cookie || '').split(';').some((part) => part.trim() === `${name}=${BOOT_ID}`);
}
const connectedCookie = (req) => `${cookieName(req)}=${BOOT_ID}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax${isLocalRequest(req) ? '' : '; Secure'}`;

// A brake on guessing the token through the connect page: every wrong token waits a second before
// its answer. Deliberately not a lockout per address: the addresses an app sees can collapse onto
// one proxy, and then a stranger's ten wrong guesses would lock the owner out. Guessing a token of
// at least 24 characters is hopeless at any speed; this only keeps a script from hammering it. The
// gateway has its own limiter for tokens sent to it directly.
const WRONG_TOKEN_DELAY_MS = 1000;

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest();
const tokenMatches = (input) => crypto.timingSafeEqual(sha256(String(input || '').trim()), sha256(gatewayToken));

// ─── The owner link ─────────────────────────────────────────────────────────

// Runs `openclaw dashboard --json`, OpenClaw's documented way to connect a browser from the
// gateway's host. It asks the running gateway for a single-use owner link that expires in ten
// minutes and works only for the browser that opens it first. The CLI briefly takes a few hundred
// MB, so links are made one at a time, and the CLI marks itself as the first thing the kernel
// should stop if memory runs out, so a squeeze costs a link, never the gateway.
let linkQueue = Promise.resolve();
function mintOwnerLink(origin) {
  const run = linkQueue.then(() => runDashboardCli(origin));
  linkQueue = run.catch(() => {});
  return run;
}

function runDashboardCli(origin) {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', 'echo 1000 > /proc/self/oom_score_adj 2>/dev/null; exec "$0" "$@"',
      process.execPath, OPENCLAW_ENTRY, 'dashboard', '--json'], { env: openclawEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const result = lastJsonObject(stdout);
      if (result && result.ok && result.browserUrl) {
        try { return resolve(publicLink(result.browserUrl, origin)); } catch (err) { return reject(err); }
      }
      const reason = (result && result.reason) || (signal ? `stopped (${signal})` : `exit code ${code}`);
      console.error(`Could not create an owner link: ${reason}${stderr ? `\n${stderr.trim().slice(-600)}` : ''}`);
      reject(new Error(reason));
    });
  });
}

function lastJsonObject(text) {
  const lines = text.trim().split('\n').reverse();
  for (const line of lines) {
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object') return value;
    } catch { /* not this line */ }
  }
  try { return JSON.parse(text); } catch { return null; }
}

// The CLI speaks from inside the container, so its link points at 127.0.0.1. Keep the one-time
// credential in the fragment and point everything else at the address the browser is on.
function publicLink(browserUrl, origin) {
  const local = new URL(browserUrl);
  const params = new URLSearchParams(local.hash.replace(/^#/, ''));
  if (!params.get('bootstrapToken')) throw new Error('the owner link had no one-time token in it');
  const target = new URL(origin);
  params.set('gatewayUrl', `${target.protocol === 'https:' ? 'wss:' : 'ws:'}//${target.host}`);
  // /chat is the Control UI's own start page; unlike the bare address it is never sent back here.
  return `${target.origin}/chat#${params.toString()}`;
}

// ─── HTTP ───────────────────────────────────────────────────────────────────

let state = problems.length ? 'setup' : 'starting'; // setup | starting | running | failed
let failureReason = '';

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(`request failed: ${err && err.stack ? err.stack : err}`);
    if (!res.headersSent) sendHtml(res, 500, page('Something went wrong', '<h1>Something went wrong</h1>'));
    else res.destroy();
  });
});
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
server.requestTimeout = 0; // uploads and long streams are the gateway's business
server.on('upgrade', handleUpgrade);
server.on('clientError', (err, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); });

async function handle(req, res) {
  const pathname = (req.url || '/').split('?')[0];

  // Cheap and always 200 while this process is up, setup mode included: a missing key is not a
  // reason for the platform to restart the app. If the gateway dies, this process exits with it.
  if (pathname === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
    res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
    return res.end(req.method === 'HEAD' ? undefined : `ok (${state})`);
  }

  if (state === 'setup') return sendHtml(res, 200, setupPage());
  if (state === 'failed') return sendHtml(res, 503, failedPage(failureReason));
  if (state !== 'running') return sendHtml(res, 503, startingPage(), { 'retry-after': '5' });

  if (pathname === '/velixir/pair') return handlePair(req, res);
  if (pathname === '/velixir/continue') return redirect(res, '/chat', { 'set-cookie': connectedCookie(req) });

  // First visit to the bare address since the gateway started: the connect page, rather than the
  // Control UI's own sign-in, which would take the token and then wait for a device approval that
  // nobody can give without a shell.
  const wantsHtml = /text\/html/.test(req.headers.accept || '');
  if (req.method === 'GET' && req.url === '/' && wantsHtml && !hasConnectedCookie(req)) {
    return redirect(res, '/velixir/pair');
  }

  return proxyHttp(req, res);
}

async function handlePair(req, res) {
  if (req.method === 'GET' || req.method === 'HEAD') return sendHtml(res, 200, pairPage());
  if (req.method !== 'POST') return sendHtml(res, 405, pairPage(), { allow: 'GET, POST' });

  const ip = clientIp(req);

  let form;
  try {
    form = new URLSearchParams(await readBody(req, 4096));
  } catch {
    return sendHtml(res, 413, pairPage({ error: 'That request was too large.' }));
  }
  if (!tokenMatches(form.get('token'))) {
    console.warn(`Wrong token on the connect page from ${ip}.`);
    await new Promise((resolve) => setTimeout(resolve, WRONG_TOKEN_DELAY_MS));
    return sendHtml(res, 401, pairPage({ error: 'That is not the gateway token. Check it and try again.' }));
  }

  try {
    const link = await mintOwnerLink(browserOrigin(req));
    console.log(`Created a one-time owner link for a browser at ${ip}.`);
    // Clear-Site-Data wipes what the Control UI keeps in this browser (its device key, cached
    // chats, settings) before it opens the link. A browser that still holds the key of a device
    // the gateway no longer knows, which is every browser after a restart, otherwise keeps
    // retrying that device instead of redeeming the link. Cookies are left alone.
    return redirect(res, link, { 'set-cookie': connectedCookie(req), 'clear-site-data': '"storage"' });
  } catch (err) {
    return sendHtml(res, 503, pairPage({ error: `Could not create the link (${err.message}). Wait a few seconds and try again.` }));
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ─── The proxy ──────────────────────────────────────────────────────────────

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer',
  'upgrade', 'proxy-authorization', 'proxy-authenticate']);
// Rebuilt by us on every request: whatever a client sends in these is dropped.
const FORWARDING = new Set(['forwarded', 'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host',
  'x-forwarded-port', 'x-real-ip', 'x-forwarded-user', 'true-client-ip', 'cf-connecting-ip', 'x-client-ip']);

const upstreamAgent = new http.Agent({ keepAlive: true, maxSockets: 256 });

function upstreamHeaders(req, upgrade) {
  const headers = {};
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i];
    const lower = name.toLowerCase();
    if (FORWARDING.has(lower)) continue;
    if (HOP_BY_HOP.has(lower) && !(upgrade && (lower === 'connection' || lower === 'upgrade'))) continue;
    const value = req.rawHeaders[i + 1];
    if (headers[name] === undefined) headers[name] = value;
    else headers[name] = [].concat(headers[name], value);
  }
  headers['X-Forwarded-For'] = clientIp(req);
  headers['X-Forwarded-Proto'] = requestProto(req);
  headers['X-Forwarded-Host'] = req.headers.host || '';
  return headers;
}

function proxyHttp(req, res) {
  const upstream = http.request({
    host: '127.0.0.1', port: GATEWAY_PORT, method: req.method, path: req.url,
    headers: upstreamHeaders(req, false), agent: upstreamAgent,
  }, (upRes) => {
    const headers = {};
    for (const [name, value] of Object.entries(upRes.headers)) if (!HOP_BY_HOP.has(name)) headers[name] = value;
    res.writeHead(upRes.statusCode || 502, upRes.statusMessage, headers);
    upRes.pipe(res);
    upRes.on('error', () => res.destroy());
  });
  upstream.on('error', (err) => {
    if (!res.headersSent) sendHtml(res, 502, page('OpenClaw is not answering', `<h1>OpenClaw is not answering</h1><p class="sub">${escapeHtml(err.message)}</p>`));
    else res.destroy();
  });
  res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
  req.pipe(upstream);
}

// WebSockets: the Control UI and every other client talk to the gateway over one. The upgrade is
// passed through with the same rebuilt forwarding headers, then the two sockets are joined.
function handleUpgrade(req, socket, head) {
  socket.on('error', () => socket.destroy());
  if (state !== 'running') {
    socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  const upstream = http.request({
    host: '127.0.0.1', port: GATEWAY_PORT, method: req.method, path: req.url,
    headers: upstreamHeaders(req, true), agent: false,
  });
  upstream.on('upgrade', (upRes, upSocket, upHead) => {
    let raw = `HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}\r\n`;
    for (let i = 0; i < upRes.rawHeaders.length; i += 2) raw += `${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}\r\n`;
    socket.write(`${raw}\r\n`);
    if (upHead && upHead.length) socket.write(upHead);
    if (head && head.length) upSocket.write(head);
    socket.setNoDelay(true);
    upSocket.setNoDelay(true);
    upSocket.on('error', () => socket.destroy());
    socket.on('close', () => upSocket.destroy());
    upSocket.on('close', () => socket.destroy());
    upSocket.pipe(socket);
    socket.pipe(upSocket);
  });
  // The gateway refused the upgrade (no token, wrong origin, too many attempts): relay its answer.
  upstream.on('response', (upRes) => {
    const chunks = [];
    upRes.on('data', (c) => { if (chunks.length < 64) chunks.push(c); });
    upRes.on('end', () => {
      const body = Buffer.concat(chunks);
      socket.end(Buffer.concat([Buffer.from(`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}\r\n`
        + `Content-Type: ${upRes.headers['content-type'] || 'text/plain'}\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`), body]));
    });
  });
  upstream.on('error', () => socket.destroy());
  socket.on('close', () => upstream.destroy());
  upstream.end();
}

// ─── The gateway ────────────────────────────────────────────────────────────

let gateway = null;
let stopping = false;

function startGateway() {
  writeConfig();
  console.log(`Starting OpenClaw ${OPENCLAW_VERSION} with ${model}${telegramToken
    ? `, Telegram on (${telegramAllowFrom.length ? `allowlist of ${telegramAllowFrom.length}` : 'pairing'})` : ''}. This is a sandbox: it starts empty.`);
  gateway = spawn(process.execPath, [OPENCLAW_ENTRY, 'gateway', 'run', '--port', String(GATEWAY_PORT), '--bind', 'loopback'],
    { env: openclawEnv(), stdio: 'inherit' });

  gateway.on('error', (err) => fail(`the gateway could not be started (${err.message})`));
  gateway.on('exit', (code, signal) => {
    if (stopping) process.exit(0);
    const how = signal ? `was stopped by ${signal}` : `exited with code ${code}`;
    if (state === 'running') {
      // A crash after a good start: exit so the platform restarts the app (and the sandbox resets).
      console.error(`OpenClaw ${how}. Exiting so the app restarts.`);
      process.exit(code || 1);
    }
    // It never got going, which is usually a setting. Stay up with a page that says so instead of
    // restarting into the same failure over and over.
    fail(`OpenClaw ${how} while starting.`);
  });

  waitUntilReady().then(() => {
    if (state !== 'starting') return;
    state = 'running';
    printReadyBox();
  }, (err) => {
    if (state === 'starting') {
      fail(err.message);
      if (gateway && gateway.exitCode === null) gateway.kill('SIGTERM');
    }
  });
}

function fail(reason) {
  if (state === 'failed') return;
  state = 'failed';
  failureReason = reason;
  console.error(`${reason} Serving a page that says so; fix the setting and redeploy.`);
}

// /startupz answers 200 once the gateway has finished starting. /readyz would also wait for every
// channel, and a Telegram token that Telegram rejects must not keep the Control UI closed.
async function waitUntilReady() {
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    if (state !== 'starting') return;
    if (await probe('/startupz') === 200) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('OpenClaw did not finish starting within five minutes.');
}

function probe(pathname) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: GATEWAY_PORT, path: pathname, timeout: 3000 }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(0));
  });
}

function printReadyBox() {
  const line = '='.repeat(68);
  const tokenLines = tokenFromEnv
    ? ['   Token:  the value of OPENCLAW_GATEWAY_TOKEN']
    : [`   Token:  ${gatewayToken}`,
      '           Generated for this start. It changes on every restart until',
      '           you set OPENCLAW_GATEWAY_TOKEN on the Environment tab.'];
  const telegramLines = !telegramToken ? [] : telegramAllowFrom.length
    ? ['', ' Telegram: the bot answers the allowed user IDs only.']
    : ['', ' Telegram: message your bot. It replies with a pairing code; approve it',
      ' in the Control UI under Settings > Channels > DM access requests.'];
  console.log([
    '', line,
    ' OpenClaw is ready. Connect your browser as the owner:',
    '',
    `   Open:   ${publicUrl}/velixir/pair`,
    ...tokenLines,
    ...telegramLines,
    '',
    ' This is a sandbox. Chats, memory, files, paired browsers and Telegram',
    ' approvals are wiped on every restart; connect again afterwards.',
    line, '',
  ].join('\n'));
}

// ─── Signals ────────────────────────────────────────────────────────────────

// This process is PID 1 in its container, and PID 1 gets no default signal handling. A redeploy's
// SIGTERM goes to the gateway so it can close cleanly. Its own drain can wait up to five minutes
// for running work, longer than the platform waits, so after 25 seconds it is stopped outright:
// the sandbox's state is thrown away either way.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    server.close();
    if (gateway && gateway.exitCode === null && gateway.signalCode === null) {
      gateway.kill('SIGTERM');
      setTimeout(() => { if (gateway.exitCode === null) gateway.kill('SIGKILL'); }, 25_000).unref();
    } else {
      process.exit(0);
    }
  });
}

// ─── Main ───────────────────────────────────────────────────────────────────

server.listen(PORT, '0.0.0.0', () => {
  if (state === 'setup') {
    console.log(`OpenClaw is not started: ${problems.map((p) => p.name).join('; ')} needs attention. `
      + `Serving the setup page on port ${PORT}; set the variables on the Environment tab.`);
    return;
  }
  startGateway();
});
