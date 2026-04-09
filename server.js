const http = require('http');
const fs = require('fs');
const path = require('path');
const { readProspectCSV } = require('./csv-reader');
const { scrapeCompanyWebsite } = require('./scraper');
const { generateEmail } = require('./email-generator');
const { sendEmail } = require('./mail-sender');
const { getEmailClient } = require('./auth');
const { generate } = require('./llm');
const logger = require('./logger');
const { loadSettings, saveSettings, CREDENTIALS_PATH, TOKEN_PATH, LOGS_DIR } = require('./config');
let scheduler;
try { scheduler = require('./scheduler'); } catch { scheduler = null; }

const crypto = require('crypto');

const PORT = 3456;
const activeSessions = new Set();
let emailClient = null;
let isRunning = false;
let shouldStop = false;
let currentStatus = { phase: 'idle', sent: 0, failed: 0, skipped: 0, total: 0, current: '' };
let storedAttachments = []; // { fileName, mimeType, base64Data }

// ---------------------------------------------------------------------------
// Request body parser
// ---------------------------------------------------------------------------
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 50e6) reject(new Error('Too large')); });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(body); } });
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// API Routes
// ---------------------------------------------------------------------------
async function handleAPI(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Parse CSV
  if (url.pathname === '/api/parse-csv' && req.method === 'POST') {
    try {
      const { csvText, fileName } = await parseBody(req);
      // Write temp file
      const tmpPath = path.join(__dirname, 'tmp-upload.csv');
      fs.writeFileSync(tmpPath, csvText, 'utf8');
      const prospects = readProspectCSV(tmpPath);
      fs.unlinkSync(tmpPath);
      json(res, { success: true, prospects, count: prospects.length });
    } catch (err) {
      json(res, { success: false, error: err.message }, 400);
    }
    return;
  }

  // Preview single email
  if (url.pathname === '/api/preview-one' && req.method === 'POST') {
    try {
      const { prospect, instructions } = await parseBody(req);
      const scraped = await scrapeCompanyWebsite(prospect.website);
      const email = await generateEmailWithInstructions(prospect, scraped, instructions);
      const suggestedTime = scheduler.suggestSendTime(prospect);
      json(res, { success: true, email, suggestedTime, scraped: { success: scraped.success, chars: scraped.rawText?.length || 0 } });
    } catch (err) {
      json(res, { success: false, error: err.message }, 500);
    }
    return;
  }

  // Preview batch
  if (url.pathname === '/api/preview-batch' && req.method === 'POST') {
    try {
      const { prospects, instructions, batchSize } = await parseBody(req);
      const batch = prospects.slice(0, batchSize || 5);
      const results = [];
      for (const prospect of batch) {
        const scraped = await scrapeCompanyWebsite(prospect.website);
        const email = await generateEmailWithInstructions(prospect, scraped, instructions);
        const suggestedTime = scheduler.suggestSendTime(prospect);
        results.push({ prospect, email, suggestedTime, scraped: { success: scraped.success } });
      }
      json(res, { success: true, results });
    } catch (err) {
      json(res, { success: false, error: err.message }, 500);
    }
    return;
  }

  // Send batch
  if (url.pathname === '/api/send' && req.method === 'POST') {
    if (isRunning) { json(res, { success: false, error: 'Already running' }, 409); return; }
    const { prospects, instructions, batchSize, delay } = await parseBody(req);
    json(res, { success: true, message: 'Send started' });

    // Run async
    runSendPipeline(prospects, instructions, batchSize || 50, delay || 15000);
    return;
  }

  // Stop
  if (url.pathname === '/api/stop' && req.method === 'POST') {
    shouldStop = true;
    json(res, { success: true, message: 'Stopping after current email' });
    return;
  }

  // Status
  if (url.pathname === '/api/status' && req.method === 'GET') {
    json(res, { ...currentStatus, isRunning });
    return;
  }

  // Send single email (from preview)
  if (url.pathname === '/api/send-one' && req.method === 'POST') {
    try {
      if (!emailClient) emailClient = await getEmailClient();
      const { to, subject, body, company, contactName } = await parseBody(req);
      // Block blank emails
      if (!subject || !subject.trim() || !body || !body.trim() || body.trim() === '-') {
        json(res, { success: false, error: 'Email has no subject or body — cannot send blank email' });
        return;
      }
      const result = await sendEmail(emailClient, { to, subject, body, attachments: storedAttachments });
      if (result.success) {
        logger.logSend({ email: to, company: company || '', contactName: contactName || '', subject, status: 'sent', messageId: result.messageId });
        logger.registerSend({ trackingId: result.trackingId, threadId: result.threadId, messageId: result.messageId, email: to, company: company || '', contactName: contactName || '', subject });
      }
      json(res, result);
    } catch (err) {
      json(res, { success: false, error: err.message }, 500);
    }
    return;
  }

  // Upload attachments
  if (url.pathname === '/api/upload-attachment' && req.method === 'POST') {
    try {
      const { fileName, mimeType, base64Data } = await parseBody(req);
      storedAttachments.push({ fileName, mimeType, base64Data });
      json(res, { success: true, count: storedAttachments.length, files: storedAttachments.map(a => a.fileName) });
    } catch (err) {
      json(res, { success: false, error: err.message }, 400);
    }
    return;
  }

  // Remove attachment
  if (url.pathname === '/api/remove-attachment' && req.method === 'POST') {
    try {
      const { index } = await parseBody(req);
      storedAttachments.splice(index, 1);
      json(res, { success: true, count: storedAttachments.length, files: storedAttachments.map(a => a.fileName) });
    } catch (err) {
      json(res, { success: false, error: err.message }, 400);
    }
    return;
  }

  // List attachments
  if (url.pathname === '/api/attachments' && req.method === 'GET') {
    json(res, { count: storedAttachments.length, files: storedAttachments.map(a => ({ fileName: a.fileName, mimeType: a.mimeType, size: Math.round(a.base64Data.length * 3 / 4 / 1024) + ' KB' })) });
    return;
  }

  // Save instructions preset
  if (url.pathname === '/api/save-preset' && req.method === 'POST') {
    try {
      const { name, instructions } = await parseBody(req);
      const presetsPath = path.join(__dirname, 'presets.json');
      const presets = fs.existsSync(presetsPath) ? JSON.parse(fs.readFileSync(presetsPath, 'utf8')) : [];
      const existing = presets.findIndex(p => p.name === name);
      if (existing >= 0) presets[existing].instructions = instructions;
      else presets.push({ name, instructions, created: new Date().toISOString() });
      fs.writeFileSync(presetsPath, JSON.stringify(presets, null, 2));
      json(res, { success: true, presets: presets.map(p => ({ name: p.name, created: p.created })) });
    } catch (err) {
      json(res, { success: false, error: err.message }, 400);
    }
    return;
  }

  // List presets
  if (url.pathname === '/api/presets' && req.method === 'GET') {
    const presetsPath = path.join(__dirname, 'presets.json');
    const presets = fs.existsSync(presetsPath) ? JSON.parse(fs.readFileSync(presetsPath, 'utf8')) : [];
    json(res, { presets });
    return;
  }

  // Load preset
  if (url.pathname === '/api/load-preset' && req.method === 'POST') {
    try {
      const { name } = await parseBody(req);
      const presetsPath = path.join(__dirname, 'presets.json');
      const presets = fs.existsSync(presetsPath) ? JSON.parse(fs.readFileSync(presetsPath, 'utf8')) : [];
      const preset = presets.find(p => p.name === name);
      if (preset) json(res, { success: true, instructions: preset.instructions });
      else json(res, { success: false, error: 'Preset not found' }, 404);
    } catch (err) {
      json(res, { success: false, error: err.message }, 400);
    }
    return;
  }

  // Delete preset
  if (url.pathname === '/api/delete-preset' && req.method === 'POST') {
    try {
      const { name } = await parseBody(req);
      const presetsPath = path.join(__dirname, 'presets.json');
      const presets = fs.existsSync(presetsPath) ? JSON.parse(fs.readFileSync(presetsPath, 'utf8')) : [];
      const filtered = presets.filter(p => p.name !== name);
      fs.writeFileSync(presetsPath, JSON.stringify(filtered, null, 2));
      json(res, { success: true, presets: filtered.map(p => ({ name: p.name, created: p.created })) });
    } catch (err) {
      json(res, { success: false, error: err.message }, 400);
    }
    return;
  }

  // Check for replies (scans Gmail threads)
  if (url.pathname === '/api/check-replies' && req.method === 'POST') {
    try {
      if (!emailClient) emailClient = await getEmailClient();
      const db = logger.loadTrackingDB();
      let checked = 0, newReplies = 0;
      for (const [trackingId, entry] of Object.entries(db)) {
        if (!entry.threadId || entry.replied) continue;
        checked++;
        try {
          const thread = await emailClient.users.threads.get({ userId: 'me', id: entry.threadId, format: 'metadata', metadataHeaders: ['From'] });
          const messages = thread.data.messages || [];
          // If thread has more than 1 message, someone replied
          if (messages.length > 1) {
            const replyFrom = messages[messages.length - 1]?.payload?.headers?.find(h => h.name === 'From')?.value || '';
            // Check the reply isn't from us
            if (!replyFrom.includes(loadSettings().senderEmail)) {
              logger.markReplied(trackingId);
              newReplies++;
            }
          }
        } catch (e) {
          // Thread might be deleted or inaccessible, skip
        }
      }
      json(res, { success: true, checked, newReplies });
    } catch (err) {
      json(res, { success: false, error: err.message }, 500);
    }
    return;
  }

  // Tracking stats
  if (url.pathname === '/api/tracking-stats' && req.method === 'GET') {
    json(res, logger.getTrackingStats());
    return;
  }

  // Analytics
  if (url.pathname === '/api/analytics' && req.method === 'GET') {
    try {
      const logsDir = LOGS_DIR;
      if (!fs.existsSync(logsDir)) { json(res, { days: [], totals: { sent: 0, failed: 0, total: 0, rate: 0 }, recent: [], companies: [], verticals: [] }); return; }

      const logFiles = fs.readdirSync(logsDir).filter(f => f.startsWith('outreach-') && f.endsWith('.csv')).sort().reverse();
      const allRows = [];
      const dailyStats = {};

      for (const file of logFiles) {
        const lines = fs.readFileSync(path.join(logsDir, file), 'utf8').split('\n').slice(1).filter(l => l.trim());
        const dateMatch = file.match(/outreach-(\d{4}-\d{2}-\d{2})\.csv/);
        const day = dateMatch ? dateMatch[1] : 'unknown';
        if (!dailyStats[day]) dailyStats[day] = { date: day, sent: 0, failed: 0, total: 0 };

        for (const line of lines) {
          // Parse CSV row carefully (handle quoted fields)
          const fields = [];
          let current = '', inQuotes = false;
          for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (ch === '"') { inQuotes = !inQuotes; }
            else if (ch === ',' && !inQuotes) { fields.push(current); current = ''; }
            else { current += ch; }
          }
          fields.push(current);

          const [timestamp, email, company, contactName, subject, status, messageId, error] = fields;
          if (!email) continue;
          const row = { timestamp, email, company, contactName, subject, status, messageId, error, date: day };
          allRows.push(row);
          dailyStats[day].total++;
          if (status === 'sent') dailyStats[day].sent++;
          else dailyStats[day].failed++;
        }
      }

      // Totals
      const totalSent = allRows.filter(r => r.status === 'sent').length;
      const totalFailed = allRows.filter(r => r.status === 'failed').length;
      const totalAll = allRows.length;

      // Company breakdown
      const companyMap = {};
      allRows.forEach(r => {
        if (!r.company) return;
        if (!companyMap[r.company]) companyMap[r.company] = { name: r.company, sent: 0, failed: 0, total: 0 };
        companyMap[r.company].total++;
        if (r.status === 'sent') companyMap[r.company].sent++;
        else companyMap[r.company].failed++;
      });
      const companies = Object.values(companyMap).sort((a, b) => b.total - a.total);

      // Days sorted
      const days = Object.values(dailyStats).sort((a, b) => b.date.localeCompare(a.date));

      // Recent (last 50)
      const recent = allRows.slice(-50).reverse();

      // Merge tracking data
      const tracking = logger.getTrackingStats();

      json(res, {
        days,
        totals: {
          sent: totalSent, failed: totalFailed, total: totalAll,
          rate: totalAll > 0 ? Math.round((totalSent / totalAll) * 100) : 0,
          opened: tracking.opened, openRate: tracking.openRate,
          replied: tracking.replied, replyRate: tracking.replyRate,
        },
        recent,
        companies,
        tracking: tracking.entries.slice(0, 100),
      });
    } catch (err) {
      json(res, { days: [], totals: { sent: 0, failed: 0, total: 0, rate: 0 }, recent: [], companies: [], error: err.message });
    }
    return;
  }

  // Hunter: search domain for emails
  if (url.pathname === '/api/hunter-search' && req.method === 'POST') {
    try {
      const HUNTER_KEY = loadSettings().hunterApiKey;
      if (!HUNTER_KEY) { json(res, { success: false, error: 'HUNTERIO_API_KEY not set in .env' }); return; }
      const { domains } = await parseBody(req);
      const results = [];
      for (const domain of domains) {
        const hres = await fetch(`https://api.hunter.io/v2/domain-search?domain=${domain}&api_key=${HUNTER_KEY}&limit=5`);
        const hdata = await hres.json();
        const emails = (hdata.data?.emails || []).map(e => ({
          email: e.value, firstName: e.first_name, lastName: e.last_name,
          title: e.position || '', department: e.department || '',
          confidence: e.confidence, verified: e.verification?.status === 'valid',
        }));
        results.push({ domain, org: hdata.data?.organization || '', pattern: hdata.data?.pattern || '', emails });
        await new Promise(r => setTimeout(r, 500));
      }
      json(res, { success: true, results });
    } catch (err) {
      json(res, { success: false, error: err.message }, 500);
    }
    return;
  }

  // Hunter: find specific person's email
  if (url.pathname === '/api/hunter-find' && req.method === 'POST') {
    try {
      const HUNTER_KEY = loadSettings().hunterApiKey;
      if (!HUNTER_KEY) { json(res, { success: false, error: 'HUNTERIO_API_KEY not set' }); return; }
      const { domain, firstName, lastName } = await parseBody(req);
      const hres = await fetch(`https://api.hunter.io/v2/email-finder?domain=${domain}&first_name=${encodeURIComponent(firstName)}&last_name=${encodeURIComponent(lastName)}&api_key=${HUNTER_KEY}`);
      const hdata = await hres.json();
      if (hdata.data?.email) {
        json(res, { success: true, email: hdata.data.email, score: hdata.data.score, status: hdata.data.verification?.status || 'unknown' });
      } else {
        json(res, { success: false, error: 'Email not found' });
      }
    } catch (err) {
      json(res, { success: false, error: err.message }, 500);
    }
    return;
  }

  // Hunter: bulk enrich — takes array of {domain, firstName, lastName} and returns verified emails
  if (url.pathname === '/api/hunter-enrich' && req.method === 'POST') {
    try {
      const HUNTER_KEY = loadSettings().hunterApiKey;
      if (!HUNTER_KEY) { json(res, { success: false, error: 'HUNTERIO_API_KEY not set' }); return; }
      const { companies } = await parseBody(req);
      const results = [];
      for (const c of companies) {
        const domain = (c.domain || c.website || '').replace(/^www\./, '');
        if (!domain) { results.push({ ...c, email: '', status: 'no_domain' }); continue; }

        let email = '', contactName = '', title = '', score = 0, status = 'not_found';

        // Try email finder if we have a name
        if (c.firstName && c.lastName) {
          const fres = await fetch(`https://api.hunter.io/v2/email-finder?domain=${domain}&first_name=${encodeURIComponent(c.firstName)}&last_name=${encodeURIComponent(c.lastName)}&api_key=${HUNTER_KEY}`);
          const fdata = await fres.json();
          if (fdata.data?.email && fdata.data.score >= 70) {
            email = fdata.data.email;
            contactName = `${c.firstName} ${c.lastName}`;
            title = c.title || '';
            score = fdata.data.score;
            status = fdata.data.verification?.status === 'valid' ? 'verified' : 'unverified';
          }
        }

        // Fallback: domain search
        if (!email) {
          const dres = await fetch(`https://api.hunter.io/v2/domain-search?domain=${domain}&api_key=${HUNTER_KEY}&limit=5`);
          const ddata = await dres.json();
          const emails = ddata.data?.emails || [];
          // Pick best: prefer personal emails with executive/management titles
          const best = emails
            .filter(e => e.type === 'personal')
            .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0];
          if (best) {
            email = best.value;
            contactName = [best.first_name, best.last_name].filter(Boolean).join(' ');
            title = best.position || '';
            score = best.confidence || 0;
            status = best.verification?.status === 'valid' ? 'verified' : 'unverified';
          }
        }

        results.push({ domain, companyName: c.companyName || '', email, contactName, title, score, status });
        await new Promise(r => setTimeout(r, 800));
      }

      json(res, { success: true, results, found: results.filter(r => r.email).length, total: results.length });
    } catch (err) {
      json(res, { success: false, error: err.message }, 500);
    }
    return;
  }

  // Auth check
  if (url.pathname === '/api/auth-check' && req.method === 'GET') {
    const hasToken = fs.existsSync(TOKEN_PATH);
    const hasCreds = fs.existsSync(CREDENTIALS_PATH);
    const settings = loadSettings();
    json(res, { hasToken, hasCreds, email: settings.senderEmail, provider: settings.llmProvider });
    return;
  }

  // Get settings
  if (url.pathname === '/api/settings' && req.method === 'GET') {
    const settings = loadSettings();
    // Mask API keys for display
    const masked = { ...settings };
    if (masked.llmApiKey) masked.llmApiKey = masked.llmApiKey.substring(0, 8) + '...' + masked.llmApiKey.slice(-4);
    if (masked.hunterApiKey) masked.hunterApiKey = masked.hunterApiKey.substring(0, 8) + '...' + masked.hunterApiKey.slice(-4);
    if (masked.loginPassword) masked.loginPassword = '********';
    json(res, masked);
    return;
  }

  // Save settings
  if (url.pathname === '/api/settings' && req.method === 'POST') {
    try {
      const updates = await parseBody(req);
      const saved = saveSettings(updates);
      json(res, { success: true, settings: saved });
    } catch (err) {
      json(res, { success: false, error: err.message }, 400);
    }
    return;
  }

  // Test LLM connection
  if (url.pathname === '/api/test-llm' && req.method === 'POST') {
    try {
      const result = await generate({ system: 'You are a helpful assistant.', user: 'Say "LLM connected successfully" in exactly those words.', temperature: 0, maxTokens: 50 });
      json(res, { success: true, response: result.text, tokens: result.tokens });
    } catch (err) {
      json(res, { success: false, error: err.message });
    }
    return;
  }

  // ---- Scheduling routes ----

  // Suggest send time for a prospect
  if (url.pathname === '/api/suggest-send-time' && req.method === 'POST') {
    try {
      const { prospect } = await parseBody(req);
      json(res, scheduler.suggestSendTime(prospect));
    } catch (err) {
      json(res, { error: err.message }, 400);
    }
    return;
  }

  // Schedule a single email
  if (url.pathname === '/api/schedule-one' && req.method === 'POST') {
    try {
      const { prospect, email, scheduledAt, instructions } = await parseBody(req);
      const entry = scheduler.scheduleEmail({
        prospect, email, scheduledAt, instructions,
        attachments: storedAttachments.length > 0,
      });
      json(res, { success: true, entry });
    } catch (err) {
      json(res, { success: false, error: err.message }, 500);
    }
    return;
  }

  // Schedule a batch of emails
  if (url.pathname === '/api/schedule-batch' && req.method === 'POST') {
    try {
      const { items } = await parseBody(req);
      const entries = [];
      for (const item of items) {
        const entry = scheduler.scheduleEmail({
          prospect: item.prospect,
          email: item.email,
          scheduledAt: item.scheduledAt,
          instructions: item.instructions,
          attachments: storedAttachments.length > 0,
        });
        entries.push(entry);
      }
      json(res, { success: true, entries, count: entries.length });
    } catch (err) {
      json(res, { success: false, error: err.message }, 500);
    }
    return;
  }

  // List all schedules
  if (url.pathname === '/api/schedules' && req.method === 'GET') {
    json(res, { schedules: scheduler.getSchedules() });
    return;
  }

  // Cancel a scheduled email
  if (url.pathname === '/api/cancel-schedule' && req.method === 'POST') {
    try {
      const { id } = await parseBody(req);
      const entry = scheduler.cancelSchedule(id);
      if (entry) json(res, { success: true, entry });
      else json(res, { success: false, error: 'Schedule not found' }, 404);
    } catch (err) {
      json(res, { success: false, error: err.message }, 500);
    }
    return;
  }

  json(res, { error: 'Not found' }, 404);
}

// ---------------------------------------------------------------------------
// Email generation — uses generic LLM abstraction
// ---------------------------------------------------------------------------
const { generateEmail: genEmail, buildSystemPrompt } = require('./email-generator');

async function generateEmailWithInstructions(prospect, scrapedData, instructions) {
  return genEmail(prospect, scrapedData, instructions);
}

// ---------------------------------------------------------------------------
// Send pipeline (runs in background)
// ---------------------------------------------------------------------------
async function runSendPipeline(prospects, instructions, batchSize, delay) {
  isRunning = true;
  shouldStop = false;
  currentStatus = { phase: 'authenticating', sent: 0, failed: 0, skipped: 0, total: Math.min(prospects.length, batchSize), current: '' };

  try {
    if (!emailClient) emailClient = await getEmailClient();
    const alreadySent = logger.getAlreadySent();
    const batch = prospects.slice(0, batchSize);

    currentStatus.phase = 'sending';

    for (let i = 0; i < batch.length; i++) {
      if (shouldStop) { currentStatus.phase = 'stopped'; break; }
      if (!logger.canSendMore(loadSettings().dailyLimit)) { currentStatus.phase = 'daily limit reached'; break; }

      const prospect = batch[i];
      currentStatus.current = `${prospect.companyName} (${prospect.email})`;

      if (alreadySent.has(prospect.email)) { currentStatus.skipped++; continue; }

      const scraped = await scrapeCompanyWebsite(prospect.website);
      const email = await generateEmailWithInstructions(prospect, scraped, instructions);

      if (email.error || !email.subject || !email.subject.trim() || !email.body || !email.body.trim()) {
        currentStatus.failed++;
        logger.logSend({ email: prospect.email, company: prospect.companyName, contactName: prospect.contactName, subject: '', status: 'failed', error: email.error || 'Empty subject or body — skipped' });
        continue;
      }

      const result = await sendEmail(emailClient, { to: prospect.email, subject: email.subject, body: email.body, attachments: storedAttachments });

      if (result.success) {
        currentStatus.sent++;
        logger.logSend({ email: prospect.email, company: prospect.companyName, contactName: prospect.contactName, subject: email.subject, status: 'sent', messageId: result.messageId });
        logger.registerSend({ trackingId: result.trackingId, threadId: result.threadId, messageId: result.messageId, email: prospect.email, company: prospect.companyName, contactName: prospect.contactName, subject: email.subject });
      } else {
        currentStatus.failed++;
        logger.logSend({ email: prospect.email, company: prospect.companyName, contactName: prospect.contactName, subject: email.subject, status: 'failed', error: result.error });
      }

      if (i < batch.length - 1 && !shouldStop) await new Promise(r => setTimeout(r, delay));
    }

    if (!shouldStop) currentStatus.phase = 'complete';
  } catch (err) {
    currentStatus.phase = 'error: ' + err.message;
  }

  isRunning = false;
}

// ---------------------------------------------------------------------------
// Serve static GUI
// ---------------------------------------------------------------------------
function serveGUI(res) {
  const htmlPath = path.join(__dirname, 'ui.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
}

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
    return;
  }

  // Tracking pixel
  const trackMatch = req.url.match(/^\/track\/([a-f0-9]+)\.png$/);
  if (trackMatch) {
    logger.recordOpen(trackMatch[1]);
    const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': pixel.length, 'Cache-Control': 'no-cache, no-store, must-revalidate' });
    res.end(pixel);
    return;
  }

  if (req.url.startsWith('/api/')) {
    await handleAPI(req, res);
  } else {
    serveGUI(res);
  }
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  Outreach Engine running at ${url}`);

  // Initialize scheduler — pass a callback that sends the email when a timer fires
  scheduler.initScheduler(async (entry) => {
    if (!emailClient) emailClient = await getEmailClient();
    const attachments = entry.attachments ? storedAttachments : [];
    return sendEmail(emailClient, {
      to: entry.prospect.email,
      subject: entry.email.subject,
      body: entry.email.body,
      attachments,
    });
  });

  console.log('');
  // Open browser
  require('child_process').exec(`start "" "${url}"`);
});
