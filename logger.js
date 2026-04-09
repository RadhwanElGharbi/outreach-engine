const fs = require('fs');
const path = require('path');
const cfgModule = require('./config');
const config = { LOGS_DIR: cfgModule.LOGS_DIR, DRAFTS_DIR: cfgModule.DRAFTS_DIR, TRACKING_DB_PATH: cfgModule.TRACKING_DB_PATH };

function today() {
  return new Date().toISOString().split('T')[0];
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function csvEscape(val) {
  const s = String(val || '');
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// ---------------------------------------------------------------------------
// Send log (CSV)
// ---------------------------------------------------------------------------
function getLogPath() {
  ensureDir(config.LOGS_DIR);
  return path.join(config.LOGS_DIR, `outreach-${today()}.csv`);
}

function logSend({ email, company, contactName, subject, status, messageId, error }) {
  const logPath = getLogPath();
  const isNew = !fs.existsSync(logPath);
  const row = [
    new Date().toISOString(),
    email,
    company,
    contactName,
    subject,
    status,
    messageId || '',
    error || '',
  ].map(csvEscape).join(',');

  if (isNew) {
    fs.writeFileSync(logPath, 'timestamp,email,company,contact_name,subject,status,message_id,error\n');
  }
  fs.appendFileSync(logPath, row + '\n');
}

function getAlreadySent() {
  const logPath = getLogPath();
  if (!fs.existsSync(logPath)) return new Set();
  const lines = fs.readFileSync(logPath, 'utf8').split('\n').slice(1);
  const sent = new Set();
  for (const line of lines) {
    if (!line.trim()) continue;
    const email = line.split(',')[1]?.replace(/"/g, '');
    const status = line.split(',')[5]?.replace(/"/g, '');
    if (email && status === 'sent') sent.add(email.toLowerCase());
  }
  return sent;
}

// ---------------------------------------------------------------------------
// Daily send count
// ---------------------------------------------------------------------------
function getSendCountPath() {
  ensureDir(config.LOGS_DIR);
  return path.join(config.LOGS_DIR, `send-count-${today()}.json`);
}

function getSendCount() {
  const p = getSendCountPath();
  if (!fs.existsSync(p)) return 0;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')).count || 0; } catch { return 0; }
}

function incrementSendCount() {
  const p = getSendCountPath();
  const count = getSendCount() + 1;
  fs.writeFileSync(p, JSON.stringify({ date: today(), count }));
  return count;
}

function canSendMore(dailyLimit) {
  return getSendCount() < dailyLimit;
}

// ---------------------------------------------------------------------------
// Dry-run preview (JSON)
// ---------------------------------------------------------------------------
function saveDraftPreview(previews) {
  ensureDir(config.DRAFTS_DIR);
  const draftPath = path.join(config.DRAFTS_DIR, `preview-${today()}.json`);
  fs.writeFileSync(draftPath, JSON.stringify(previews, null, 2));
  return draftPath;
}

// ---------------------------------------------------------------------------
// Console output
// ---------------------------------------------------------------------------
function progress(index, total, company, email, steps) {
  const parts = [`[${index}/${total}] ${company} — ${email}`];
  for (const [label, value] of Object.entries(steps)) {
    parts.push(`  ${label}: ${value}`);
  }
  console.log(parts.join('\n'));
}

function summary({ sent, failed, skipped, dryRun, total }) {
  console.log('\n' + '='.repeat(50));
  if (dryRun) {
    console.log(`DRY RUN COMPLETE — ${total} emails previewed`);
  } else {
    console.log(`OUTREACH COMPLETE`);
    console.log(`  Sent:    ${sent}`);
    console.log(`  Failed:  ${failed}`);
    console.log(`  Skipped: ${skipped}`);
    console.log(`  Total:   ${total}`);
  }
  console.log('='.repeat(50));
}

// ---------------------------------------------------------------------------
// Tracking database (opens, replies, threadIds)
// ---------------------------------------------------------------------------
function loadTrackingDB() {
  if (!fs.existsSync(config.TRACKING_DB_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(config.TRACKING_DB_PATH, 'utf8')); } catch { return {}; }
}

function saveTrackingDB(db) {
  fs.writeFileSync(config.TRACKING_DB_PATH, JSON.stringify(db, null, 2));
}

function registerSend({ trackingId, threadId, messageId, email, company, contactName, subject }) {
  if (!trackingId) return;
  const db = loadTrackingDB();
  db[trackingId] = {
    threadId: threadId || null,
    messageId: messageId || null,
    email,
    company: company || '',
    contactName: contactName || '',
    subject: subject || '',
    sentAt: new Date().toISOString(),
    opens: [],
    replied: false,
    repliedAt: null,
  };
  saveTrackingDB(db);
}

function recordOpen(trackingId) {
  const db = loadTrackingDB();
  if (!db[trackingId]) return false;
  db[trackingId].opens.push(new Date().toISOString());
  saveTrackingDB(db);
  return true;
}

function markReplied(trackingId) {
  const db = loadTrackingDB();
  if (!db[trackingId]) return;
  if (!db[trackingId].replied) {
    db[trackingId].replied = true;
    db[trackingId].repliedAt = new Date().toISOString();
    saveTrackingDB(db);
  }
}

function getTrackingStats() {
  const db = loadTrackingDB();
  const entries = Object.values(db);
  const total = entries.length;
  const opened = entries.filter(e => e.opens.length > 0).length;
  const replied = entries.filter(e => e.replied).length;
  return {
    total,
    opened,
    replied,
    openRate: total > 0 ? Math.round((opened / total) * 100) : 0,
    replyRate: total > 0 ? Math.round((replied / total) * 100) : 0,
    entries: entries.sort((a, b) => (b.sentAt || '').localeCompare(a.sentAt || '')),
  };
}

module.exports = {
  logSend,
  getAlreadySent,
  getSendCount,
  incrementSendCount,
  canSendMore,
  saveDraftPreview,
  progress,
  summary,
  loadTrackingDB,
  saveTrackingDB,
  registerSend,
  recordOpen,
  markReplied,
  getTrackingStats,
};
