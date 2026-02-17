const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');

const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const DATA_DIR = path.join(APPDATA, 'ClaudeUsageWidget');
const OUTPUT_FILE = path.join(DATA_DIR, 'usage.json');
const CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const TOKEN_URL = 'https://api.anthropic.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

function readCredentials() {
  const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf-8');
  return JSON.parse(raw);
}

function writeCredentials(creds) {
  fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds));
}

function httpRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function refreshToken(creds) {
  const body = JSON.stringify({
    grant_type: 'refresh_token',
    refresh_token: creds.claudeAiOauth.refreshToken,
    client_id: CLIENT_ID,
  });

  const res = await httpRequest(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, body);

  if (res.status !== 200) {
    throw new Error(`Token refresh failed (${res.status}): ${res.data}`);
  }

  const tokens = JSON.parse(res.data);
  creds.claudeAiOauth.accessToken = tokens.access_token;
  creds.claudeAiOauth.refreshToken = tokens.refresh_token;
  creds.claudeAiOauth.expiresAt = Date.now() + (tokens.expires_in * 1000);
  writeCredentials(creds);
  console.log('Token refreshed successfully');
  return creds;
}

async function fetchUsage(accessToken) {
  const res = await httpRequest(USAGE_URL, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'Content-Type': 'application/json',
      'User-Agent': 'claude-code/2.0.32',
      'Accept': 'application/json',
    },
  });

  if (res.status === 401 || res.status === 403) {
    return null; // Token expired, caller should refresh
  }
  if (res.status !== 200) {
    throw new Error(`Usage API error (${res.status}): ${res.data}`);
  }
  return JSON.parse(res.data);
}

function formatResetTime(resetsAt) {
  if (!resetsAt) return '';
  const reset = new Date(resetsAt);
  const now = new Date();
  const diffMs = reset - now;
  if (diffMs <= 0) return 'now';
  const hours = Math.floor(diffMs / 3600000);
  const mins = Math.floor((diffMs % 3600000) / 60000);
  if (hours > 0) return `in ${hours}h ${mins}m`;
  return `in ${mins}m`;
}

function transformUsageData(raw, subscriptionType) {
  const planName = (subscriptionType || 'Unknown').charAt(0).toUpperCase()
    + (subscriptionType || 'unknown').slice(1) + ' Plan';

  const sections = [];

  if (raw.five_hour) {
    sections.push({
      name: 'Current session',
      percent: Math.round(raw.five_hour.utilization || 0),
      resetText: formatResetTime(raw.five_hour.resets_at),
    });
  }

  if (raw.seven_day) {
    sections.push({
      name: 'All models',
      percent: Math.round(raw.seven_day.utilization || 0),
      resetText: formatResetTime(raw.seven_day.resets_at),
    });
  }

  if (raw.seven_day_opus) {
    sections.push({
      name: 'Opus only',
      percent: Math.round(raw.seven_day_opus.utilization || 0),
      resetText: formatResetTime(raw.seven_day_opus.resets_at),
    });
  }

  if (raw.seven_day_sonnet) {
    sections.push({
      name: 'Sonnet only',
      percent: Math.round(raw.seven_day_sonnet.utilization || 0),
      resetText: formatResetTime(raw.seven_day_sonnet.resets_at),
    });
  }

  const primary = sections.find(s => s.name === 'Current session')
    || sections.find(s => s.name === 'All models')
    || sections[0];

  return {
    planName,
    sections,
    usedPercent: primary ? primary.percent : 0,
    remainingPercent: primary ? (100 - primary.percent) : 100,
    resetDate: primary ? primary.resetText : '',
    usageText: primary ? `${primary.name}: ${primary.percent}% used` : '0% used',
    scrapedAt: new Date().toISOString(),
  };
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  let creds;
  try {
    creds = readCredentials();
  } catch {
    throw new Error(`Cannot read credentials from ${CREDENTIALS_PATH}. Run "claude auth" first.`);
  }

  const oauth = creds.claudeAiOauth;
  if (!oauth || !oauth.accessToken) {
    throw new Error('No OAuth token found. Run "claude auth" first.');
  }

  // Check if token is expired
  if (oauth.expiresAt && Date.now() > oauth.expiresAt - 60000) {
    console.log('Token expired, refreshing...');
    creds = await refreshToken(creds);
  }

  console.log('Fetching usage from API...');
  let raw = await fetchUsage(creds.claudeAiOauth.accessToken);

  // If unauthorized, try refreshing
  if (raw === null) {
    console.log('Token rejected, refreshing...');
    creds = await refreshToken(creds);
    raw = await fetchUsage(creds.claudeAiOauth.accessToken);
    if (raw === null) {
      throw new Error('Token refresh failed. Run "claude auth" to re-authenticate.');
    }
  }

  const usageData = transformUsageData(raw, oauth.subscriptionType);

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(usageData, null, 2));
  console.log('Usage data saved to', OUTPUT_FILE);
  console.log(JSON.stringify(usageData, null, 2));
}

main().catch(err => {
  console.error('Error:', err.message);
  const APPDATA_DIR = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const outDir = path.join(APPDATA_DIR, 'ClaudeUsageWidget');
  const outFile = path.join(outDir, 'usage.json');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({
    planName: 'Error',
    usageText: 'Could not fetch usage data',
    usedPercent: 0,
    remainingPercent: 100,
    resetDate: '',
    error: err.message,
    scrapedAt: new Date().toISOString(),
  }, null, 2));
  process.exit(1);
});
