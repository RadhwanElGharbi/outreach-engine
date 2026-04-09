const fs = require('fs');
const path = require('path');

const SETTINGS_PATH = path.join(__dirname, 'settings.json');

const DEFAULTS = {
  // Sender
  senderName: '',
  senderEmail: '',
  senderTitle: '',
  companyName: '',
  companyWebsite: '',
  calendlyLink: '',
  location: '',

  // Company context (what you sell, your value prop — injected into email generation)
  companyContext: '',

  // Email style instructions
  emailInstructions: '',

  // LLM Provider
  llmProvider: 'claude',  // claude | openai | gemini
  llmApiKey: '',
  llmModel: '',           // auto-selected per provider if empty

  // Hunter.io
  hunterApiKey: '',

  // Rate Limits
  dailyLimit: 2000,
  defaultDelayMs: 15000,
  defaultBatchSize: 50,

  // Auth
  loginUser: '',
  loginPassword: '',
};

function loadSettings() {
  if (!fs.existsSync(SETTINGS_PATH)) return { ...DEFAULTS };
  try {
    const saved = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    return { ...DEFAULTS, ...saved };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings(updates) {
  const current = loadSettings();
  const merged = { ...current, ...updates };
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2));
  return merged;
}

// Static paths
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const TOKEN_PATH = path.join(__dirname, 'token.json');
const LOGS_DIR = path.join(__dirname, 'logs');
const DRAFTS_DIR = path.join(__dirname, 'drafts');
const TRACKING_DB_PATH = path.join(__dirname, 'tracking.json');
const SCHEDULES_PATH = path.join(__dirname, 'schedules.json');
const SCRAPE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SCRAPE_TIMEOUT_MS = 5000;
const SCRAPE_MAX_CHARS = 1500;
const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.readonly'];

module.exports = {
  loadSettings,
  saveSettings,
  CREDENTIALS_PATH,
  TOKEN_PATH,
  LOGS_DIR,
  DRAFTS_DIR,
  TRACKING_DB_PATH,
  SCHEDULES_PATH,
  SCRAPE_USER_AGENT,
  SCRAPE_TIMEOUT_MS,
  SCRAPE_MAX_CHARS,
  GMAIL_SCOPES,
  SETTINGS_PATH,
};
