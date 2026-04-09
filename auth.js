const fs = require('fs');
const { google } = require('googleapis');
const readline = require('readline');
const { exec } = require('child_process');
const { CREDENTIALS_PATH, TOKEN_PATH, GMAIL_SCOPES } = require('./config');

// =========================================================================
// Gmail OAuth2
// =========================================================================
async function authorizeGmail() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    console.error('\nERROR: credentials.json not found.');
    console.error('To set up Gmail API access:\n');
    console.error('  1. Go to https://console.cloud.google.com/');
    console.error('  2. Create a project');
    console.error('  3. Enable the Gmail API');
    console.error('  4. Create OAuth2 credentials (Desktop app type)');
    console.error('  5. Download the JSON file');
    console.error('  6. Rename it to credentials.json');
    console.error(`  7. Place it at: ${CREDENTIALS_PATH}\n`);
    process.exit(1);
  }

  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  const { client_id, client_secret, redirect_uris } = credentials.installed || credentials.web;
  const oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  if (fs.existsSync(TOKEN_PATH)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    oauth2Client.setCredentials(token);
    oauth2Client.on('tokens', (tokens) => {
      const existing = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
      fs.writeFileSync(TOKEN_PATH, JSON.stringify({ ...existing, ...tokens }, null, 2));
    });
    return oauth2Client;
  }

  const authUrl = oauth2Client.generateAuthUrl({ access_type: 'offline', scope: GMAIL_SCOPES, prompt: 'consent' });
  console.log('\nOpening browser for Gmail authorization...\n');
  console.log('If the browser does not open, visit this URL:\n');
  console.log(authUrl);
  console.log('');

  const platform = process.platform;
  if (platform === 'win32') exec(`start "" "${authUrl}"`);
  else if (platform === 'darwin') exec(`open "${authUrl}"`);
  else exec(`xdg-open "${authUrl}"`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const code = await new Promise(resolve => { rl.question('Paste the authorization code here: ', a => { rl.close(); resolve(a.trim()); }); });

  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
  console.log('\nGmail authorization successful. Token saved.\n');
  return oauth2Client;
}

async function getGmailClient() {
  const oauth2Client = await authorizeGmail();
  return google.gmail({ version: 'v1', auth: oauth2Client });
}

// =========================================================================
// Outlook (Microsoft Graph) via MSAL device code flow
// =========================================================================
const OUTLOOK_TOKEN_PATH = CREDENTIALS_PATH.replace('credentials.json', 'outlook-token.json');

async function authorizeOutlook() {
  let msal;
  try { msal = require('@azure/msal-node'); } catch {
    console.error('Outlook support requires @azure/msal-node. Run: npm install @azure/msal-node');
    process.exit(1);
  }

  // Check for existing token
  if (fs.existsSync(OUTLOOK_TOKEN_PATH)) {
    const saved = JSON.parse(fs.readFileSync(OUTLOOK_TOKEN_PATH, 'utf8'));
    if (saved.expiresOn && new Date(saved.expiresOn) > new Date()) {
      return saved.accessToken;
    }
  }

  // Read client config from outlook-credentials.json or settings
  const outlookCredsPath = CREDENTIALS_PATH.replace('credentials.json', 'outlook-credentials.json');
  let clientId;
  if (fs.existsSync(outlookCredsPath)) {
    const creds = JSON.parse(fs.readFileSync(outlookCredsPath, 'utf8'));
    clientId = creds.client_id || creds.clientId;
  }
  if (!clientId) {
    console.error('\nERROR: outlook-credentials.json not found.');
    console.error('To set up Outlook:\n');
    console.error('  1. Go to https://portal.azure.com > App registrations');
    console.error('  2. New registration > Name: "Outreach Engine" > Personal accounts');
    console.error('  3. Add API permission: Microsoft Graph > Mail.Send');
    console.error('  4. Enable "Allow public client flows"');
    console.error('  5. Create outlook-credentials.json with: { "client_id": "YOUR_APP_ID" }\n');
    process.exit(1);
  }

  const app = new msal.PublicClientApplication({
    auth: { clientId, authority: 'https://login.microsoftonline.com/common' },
  });

  const deviceCodeRequest = {
    scopes: ['https://graph.microsoft.com/Mail.Send', 'https://graph.microsoft.com/Mail.ReadWrite'],
    deviceCodeCallback: (response) => {
      console.log('\n' + response.message + '\n');
      // Open browser
      const url = response.verificationUri;
      if (process.platform === 'win32') exec(`start "" "${url}"`);
      else if (process.platform === 'darwin') exec(`open "${url}"`);
      else exec(`xdg-open "${url}"`);
    },
  };

  const result = await app.acquireTokenByDeviceCode(deviceCodeRequest);
  const tokenData = { accessToken: result.accessToken, expiresOn: result.expiresOn?.toISOString() };
  fs.writeFileSync(OUTLOOK_TOKEN_PATH, JSON.stringify(tokenData, null, 2));
  console.log('\nOutlook authorization successful. Token saved.\n');
  return result.accessToken;
}

async function getOutlookClient() {
  const token = await authorizeOutlook();
  return { _outlookToken: token };
}

// =========================================================================
// Unified — returns the right client based on which provider is configured
// =========================================================================
async function getEmailClient(provider) {
  if (provider === 'outlook') return getOutlookClient();
  return getGmailClient(); // default
}

module.exports = { getGmailClient, getOutlookClient, getEmailClient };

// Run standalone for setup
if (require.main === module) {
  const provider = process.argv[2] || 'gmail';
  console.log(`Setting up ${provider} authentication...`);
  if (provider === 'outlook') {
    authorizeOutlook().then(() => console.log('Outlook setup complete.')).catch(e => console.error('Failed:', e.message));
  } else {
    authorizeGmail().then(() => console.log('Gmail setup complete.')).catch(e => console.error('Failed:', e.message));
  }
}
