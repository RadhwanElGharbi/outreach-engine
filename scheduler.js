const fs = require('fs');
const crypto = require('crypto');
const config = require('./config');
const logger = require('./logger');

// ---------------------------------------------------------------------------
// Timezone offset map (UTC hours). Covers Colony's target markets.
// DST is ignored — ±1 hr is acceptable for cold email timing.
// ---------------------------------------------------------------------------
const STATE_OFFSETS = {
  // US states
  AL: -6, AK: -9, AZ: -7, AR: -6, CA: -8, CO: -7, CT: -5, DE: -5, FL: -5,
  GA: -5, HI: -10, ID: -7, IL: -6, IN: -5, IA: -6, KS: -6, KY: -5, LA: -6,
  ME: -5, MD: -5, MA: -5, MI: -5, MN: -6, MS: -6, MO: -6, MT: -7, NE: -6,
  NV: -8, NH: -5, NJ: -5, NM: -7, NY: -5, NC: -5, ND: -6, OH: -5, OK: -6,
  OR: -8, PA: -5, RI: -5, SC: -5, SD: -6, TN: -6, TX: -6, UT: -7, VT: -5,
  VA: -5, WA: -8, WV: -5, WI: -6, WY: -7, DC: -5,
  // Canadian provinces
  BC: -8, AB: -7, SK: -6, MB: -6, ON: -5, QC: -5, NB: -4, NS: -4, PE: -4,
  NL: -3.5, YT: -7, NT: -7, NU: -5,
  // Australian states
  NSW: 11, VIC: 11, QLD: 10, SA: 9.5, WA: 8, TAS: 11, ACT: 11, NT_AU: 9.5,
};

const COUNTRY_OFFSETS = {
  'united states': -5, 'usa': -5, 'us': -5,
  'canada': -5, 'ca': -5,
  'united kingdom': 0, 'uk': 0, 'gb': 0,
  'australia': 10, 'au': 10,
  'germany': 1, 'de': 1, 'france': 1, 'fr': 1, 'spain': 1, 'es': 1,
  'italy': 1, 'it': 1, 'netherlands': 1, 'nl': 1, 'belgium': 1, 'be': 1,
  'switzerland': 1, 'ch': 1, 'austria': 1, 'at': 1, 'poland': 1, 'pl': 1,
  'sweden': 1, 'se': 1, 'norway': 1, 'no': 1, 'denmark': 1, 'dk': 1,
  'finland': 2, 'fi': 2, 'greece': 2, 'gr': 2, 'romania': 2, 'ro': 2,
  'portugal': 0, 'pt': 0, 'ireland': 0, 'ie': 0,
  'uae': 4, 'united arab emirates': 4, 'ae': 4,
  'saudi arabia': 3, 'sa_country': 3, 'qatar': 3, 'qa': 3,
  'oman': 4, 'om': 4, 'kuwait': 3, 'kw': 3, 'bahrain': 3, 'bh': 3,
  'india': 5.5, 'in': 5.5,
  'japan': 9, 'jp': 9, 'south korea': 9, 'kr': 9,
  'china': 8, 'cn': 8, 'singapore': 8, 'sg': 8, 'malaysia': 8, 'my': 8,
  'indonesia': 7, 'id_country': 7, 'thailand': 7, 'th': 7,
  'new zealand': 12, 'nz': 12,
  'brazil': -3, 'br': -3, 'argentina': -3, 'ar': -3,
  'chile': -4, 'cl': -4, 'colombia': -5, 'co_country': -5,
  'mexico': -6, 'mx': -6, 'peru': -5, 'pe_country': -5,
  'south africa': 2, 'za': 2, 'nigeria': 1, 'ng': 1,
  'egypt': 2, 'eg': 2, 'kenya': 3, 'ke': 3,
  'israel': 2, 'il': 2, 'turkey': 3, 'tr': 3,
};

const CITY_OFFSETS = {
  'new york': -5, 'los angeles': -8, 'chicago': -6, 'houston': -6,
  'phoenix': -7, 'dallas': -6, 'san francisco': -8, 'seattle': -8,
  'denver': -7, 'boston': -5, 'atlanta': -5, 'miami': -5, 'detroit': -5,
  'minneapolis': -6, 'portland': -8, 'las vegas': -8, 'austin': -6,
  'san diego': -8, 'pittsburgh': -5, 'charlotte': -5, 'nashville': -6,
  'toronto': -5, 'vancouver': -8, 'montreal': -5, 'calgary': -7,
  'edmonton': -7, 'ottawa': -5, 'winnipeg': -6, 'saskatoon': -6,
  'waterloo': -5, 'victoria': -8, 'halifax': -4, 'regina': -6,
  'london': 0, 'manchester': 0, 'edinburgh': 0, 'glasgow': 0,
  'sydney': 11, 'melbourne': 11, 'brisbane': 10, 'perth': 8, 'adelaide': 9.5,
  'dubai': 4, 'abu dhabi': 4, 'riyadh': 3, 'doha': 3, 'muscat': 4,
  'berlin': 1, 'munich': 1, 'paris': 1, 'madrid': 1, 'rome': 1,
  'amsterdam': 1, 'zurich': 1, 'stockholm': 1, 'oslo': 1, 'copenhagen': 1,
  'helsinki': 2, 'vienna': 1, 'brussels': 1, 'warsaw': 1, 'lisbon': 0,
  'dublin': 0, 'tel aviv': 2, 'istanbul': 3,
  'mumbai': 5.5, 'delhi': 5.5, 'bangalore': 5.5,
  'tokyo': 9, 'singapore': 8, 'hong kong': 8, 'shanghai': 8, 'beijing': 8,
  'seoul': 9, 'kuala lumpur': 8, 'jakarta': 7, 'bangkok': 7,
  'sao paulo': -3, 'rio de janeiro': -3, 'buenos aires': -3,
  'santiago': -4, 'bogota': -5, 'lima': -5, 'mexico city': -6,
  'johannesburg': 2, 'cape town': 2, 'nairobi': 3, 'cairo': 2, 'lagos': 1,
  'auckland': 12, 'wellington': 12,
};

// ---------------------------------------------------------------------------
// Resolve UTC offset from prospect fields
// ---------------------------------------------------------------------------
function resolveTimezoneOffset(prospect) {
  const city = (prospect.city || '').trim().toLowerCase();
  const state = (prospect.state || '').trim().toUpperCase();
  const country = (prospect.country || '').trim().toLowerCase();
  const region = (prospect.region || '').trim().toLowerCase();

  // 1. City lookup
  if (city && CITY_OFFSETS[city] !== undefined) {
    return { offset: CITY_OFFSETS[city], source: city };
  }

  // 2. State/province lookup
  if (state && STATE_OFFSETS[state] !== undefined) {
    return { offset: STATE_OFFSETS[state], source: state };
  }

  // 3. Country lookup
  if (country && COUNTRY_OFFSETS[country] !== undefined) {
    return { offset: COUNTRY_OFFSETS[country], source: country };
  }

  // 4. Parse region string — try to extract state codes or known city/country names
  if (region) {
    // Try matching a 2-letter state code in the region string
    const stateMatch = region.match(/\b([A-Z]{2})\b/i);
    if (stateMatch) {
      const code = stateMatch[1].toUpperCase();
      if (STATE_OFFSETS[code] !== undefined) {
        return { offset: STATE_OFFSETS[code], source: code + ' (from region)' };
      }
    }
    // Try matching known city names within region
    for (const [name, offset] of Object.entries(CITY_OFFSETS)) {
      if (region.includes(name)) {
        return { offset, source: name + ' (from region)' };
      }
    }
    // Try matching country names within region
    for (const [name, offset] of Object.entries(COUNTRY_OFFSETS)) {
      if (name.length > 2 && region.includes(name)) {
        return { offset, source: name + ' (from region)' };
      }
    }
  }

  // 5. Default: US Eastern (Colony's primary market is North American infrastructure)
  return { offset: -5, source: 'default (US Eastern)' };
}

// ---------------------------------------------------------------------------
// Suggest optimal send time
// ---------------------------------------------------------------------------
function formatOffsetLabel(offset) {
  const sign = offset >= 0 ? '+' : '';
  if (offset % 1 !== 0) return `UTC${sign}${Math.floor(offset)}:30`;
  return `UTC${sign}${offset}`;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function suggestSendTime(prospect) {
  const { offset, source } = resolveTimezoneOffset(prospect);
  const now = new Date();

  // Target: next Tue/Wed/Thu at 9:00 AM in the prospect's local time
  // 9 AM local = 9 - offset hours in UTC
  const targetLocalHour = 9;
  const targetUTCHour = targetLocalHour - offset;

  // Find the next Tue (2), Wed (3), or Thu (4)
  const preferredDays = [2, 3, 4]; // Tue, Wed, Thu — highest B2B open rates
  const fallbackDays = [1, 5];     // Mon, Fri — acceptable fallback

  let best = null;

  for (const daySet of [preferredDays, fallbackDays]) {
    for (let daysAhead = 0; daysAhead < 8; daysAhead++) {
      const candidate = new Date(now.getTime() + daysAhead * 86400000);
      candidate.setUTCHours(Math.floor(targetUTCHour), (targetUTCHour % 1) * 60, 0, 0);

      if (!daySet.includes(candidate.getUTCDay())) continue;
      // Must be at least 1 hour in the future to allow review
      if (candidate.getTime() - now.getTime() < 3600000) continue;

      best = candidate;
      break;
    }
    if (best) break;
  }

  // Absolute fallback: next day at target hour
  if (!best) {
    best = new Date(now.getTime() + 86400000);
    best.setUTCHours(Math.floor(targetUTCHour), (targetUTCHour % 1) * 60, 0, 0);
  }

  const localDay = DAY_NAMES[best.getUTCDay()];
  // Compute local hour accounting for offset
  let localHourRaw = best.getUTCHours() + offset;
  if (localHourRaw < 0) localHourRaw += 24;
  if (localHourRaw >= 24) localHourRaw -= 24;
  const localH = Math.floor(localHourRaw);
  const localM = (localHourRaw % 1) * 60;
  const ampm = localH >= 12 ? 'PM' : 'AM';
  const h12 = localH === 0 ? 12 : localH > 12 ? localH - 12 : localH;
  const localTimeStr = `${localDay} ${h12}:${String(Math.round(localM)).padStart(2, '0')} ${ampm}`;

  const location = [prospect.city, prospect.state, prospect.country]
    .filter(Boolean).join(', ') || prospect.region || 'Unknown';

  return {
    suggestedUTC: best.toISOString(),
    timezoneOffset: offset,
    localTime: localTimeStr,
    reasoning: `${location} \u2192 ${formatOffsetLabel(offset)}, targeting ${localTimeStr} local`,
    source,
  };
}

// ---------------------------------------------------------------------------
// Schedule persistence
// ---------------------------------------------------------------------------
function loadSchedules() {
  if (!fs.existsSync(config.SCHEDULES_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(config.SCHEDULES_PATH, 'utf8'));
  } catch { return []; }
}

function saveSchedules(schedules) {
  fs.writeFileSync(config.SCHEDULES_PATH, JSON.stringify(schedules, null, 2));
}

// ---------------------------------------------------------------------------
// Timer management
// ---------------------------------------------------------------------------
const activeTimers = new Map();
let sendCallback = null; // set by initScheduler

function clearTimer(id) {
  const ref = activeTimers.get(id);
  if (ref) { clearTimeout(ref); activeTimers.delete(id); }
}

function setTimer(entry) {
  clearTimer(entry.id);
  const delay = new Date(entry.scheduledAt).getTime() - Date.now();

  if (delay <= 0) {
    // Overdue — fire immediately
    fireSchedule(entry.id);
    return;
  }

  // setTimeout max is ~24.8 days (2^31-1 ms). For longer, chain a 24h wake-up.
  const MAX_TIMEOUT = 2147483647;
  if (delay > MAX_TIMEOUT) {
    activeTimers.set(entry.id, setTimeout(() => setTimer(entry), MAX_TIMEOUT));
    return;
  }

  activeTimers.set(entry.id, setTimeout(() => fireSchedule(entry.id), delay));
}

async function fireSchedule(id) {
  activeTimers.delete(id);
  const schedules = loadSchedules();
  const entry = schedules.find(s => s.id === id);
  if (!entry || entry.status !== 'pending') return;

  entry.status = 'sending';
  saveSchedules(schedules);

  try {
    if (!sendCallback) throw new Error('Scheduler not initialized');
    const result = await sendCallback(entry);

    entry.status = result.success ? 'sent' : 'failed';
    entry.sentAt = new Date().toISOString();
    entry.error = result.error || null;
    entry.messageId = result.messageId || null;
    entry.trackingId = result.trackingId || null;

    if (result.success) {
      logger.logSend({
        email: entry.prospect.email,
        company: entry.prospect.companyName,
        contactName: entry.prospect.contactName,
        subject: entry.email.subject,
        status: 'sent',
        messageId: result.messageId,
      });
      logger.registerSend({
        trackingId: result.trackingId,
        threadId: result.threadId,
        messageId: result.messageId,
        email: entry.prospect.email,
        company: entry.prospect.companyName,
        contactName: entry.prospect.contactName,
        subject: entry.email.subject,
      });
    } else {
      logger.logSend({
        email: entry.prospect.email,
        company: entry.prospect.companyName,
        contactName: entry.prospect.contactName,
        subject: entry.email.subject,
        status: 'failed',
        error: result.error,
      });
    }
  } catch (err) {
    entry.status = 'failed';
    entry.sentAt = new Date().toISOString();
    entry.error = err.message;
  }

  saveSchedules(schedules);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
function initScheduler(callback) {
  sendCallback = callback;
  const schedules = loadSchedules();
  let armed = 0;
  let overdue = 0;

  // Clean old completed/cancelled entries (>30 days)
  const cutoff = Date.now() - 30 * 86400000;
  const active = schedules.filter(s => {
    if ((s.status === 'sent' || s.status === 'cancelled') && new Date(s.createdAt).getTime() < cutoff) return false;
    // Reset stuck 'sending' entries from a crashed run
    if (s.status === 'sending') s.status = 'pending';
    return true;
  });
  if (active.length !== schedules.length) saveSchedules(active);

  for (const entry of active) {
    if (entry.status !== 'pending') continue;
    const delay = new Date(entry.scheduledAt).getTime() - Date.now();
    if (delay <= 0) overdue++;
    armed++;
    setTimer(entry);
  }

  if (armed > 0) {
    console.log(`  Scheduler: ${armed} pending (${overdue} overdue, sending now)`);
  }
}

function scheduleEmail({ prospect, email, scheduledAt, instructions, attachments }) {
  const id = crypto.randomBytes(8).toString('hex');
  const suggestion = suggestSendTime(prospect);

  const entry = {
    id,
    prospect,
    email,
    instructions: instructions || null,
    attachments: !!attachments,
    scheduledAt: scheduledAt || suggestion.suggestedUTC,
    timezoneOffset: suggestion.timezoneOffset,
    localTime: suggestion.localTime,
    status: 'pending',
    createdAt: new Date().toISOString(),
    sentAt: null,
    error: null,
    messageId: null,
    trackingId: null,
  };

  const schedules = loadSchedules();
  schedules.push(entry);
  saveSchedules(schedules);
  setTimer(entry);

  return entry;
}

function cancelSchedule(id) {
  clearTimer(id);
  const schedules = loadSchedules();
  const entry = schedules.find(s => s.id === id);
  if (!entry) return null;
  if (entry.status === 'pending') {
    entry.status = 'cancelled';
    entry.sentAt = new Date().toISOString();
    saveSchedules(schedules);
  }
  return entry;
}

function getSchedules() {
  const schedules = loadSchedules();
  const now = Date.now();
  return schedules.map(s => ({
    ...s,
    msUntil: s.status === 'pending' ? Math.max(0, new Date(s.scheduledAt).getTime() - now) : 0,
  }));
}

module.exports = { suggestSendTime, initScheduler, scheduleEmail, cancelSchedule, getSchedules };
