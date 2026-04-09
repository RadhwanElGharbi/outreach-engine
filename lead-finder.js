const fs = require('fs');
const path = require('path');
const config = require('./config');
const { scrapeCompanyWebsite } = require('./scraper');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), override: true });

const HUNTER_API_KEY = process.env.HUNTERIO_API_KEY;
const HUNTER_BASE = 'https://api.hunter.io/v2';

// Target titles for Colony's buyers
const TARGET_TITLES = [
  'owner', 'founder', 'ceo', 'president', 'cto', 'chief',
  'director of operations', 'vp operations', 'director of survey',
  'director of flight', 'chief pilot', 'general manager',
  'managing director', 'principal', 'partner',
];

const EXCLUDE_TITLES = [
  'hr', 'human resources', 'recruiting', 'talent',
  'marketing', 'social media', 'content',
  'legal', 'counsel', 'compliance',
  'accounting', 'finance', 'payroll',
  'receptionist', 'administrative', 'office manager',
  'intern', 'student',
];

// ---------------------------------------------------------------------------
// Hunter API helpers
// ---------------------------------------------------------------------------
async function hunterDomainSearch(domain) {
  const url = `${HUNTER_BASE}/domain-search?domain=${domain}&api_key=${HUNTER_API_KEY}&limit=10`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.errors) return { emails: [], error: data.errors[0]?.details || 'Unknown error' };
    return { emails: data.data?.emails || [], pattern: data.data?.pattern || '', org: data.data?.organization || '' };
  } catch (err) {
    return { emails: [], error: err.message };
  }
}

async function hunterEmailFinder(domain, firstName, lastName) {
  const url = `${HUNTER_BASE}/email-finder?domain=${domain}&first_name=${encodeURIComponent(firstName)}&last_name=${encodeURIComponent(lastName)}&api_key=${HUNTER_API_KEY}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.data?.email) {
      return { email: data.data.email, score: data.data.score, status: data.data.verification?.status || 'unknown' };
    }
    return null;
  } catch {
    return null;
  }
}

async function hunterEmailVerify(email) {
  const url = `${HUNTER_BASE}/email-verifier?email=${encodeURIComponent(email)}&api_key=${HUNTER_API_KEY}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    return { status: data.data?.status || 'unknown', score: data.data?.score || 0 };
  } catch {
    return { status: 'unknown', score: 0 };
  }
}

// ---------------------------------------------------------------------------
// Pick the best contact from Hunter results
// ---------------------------------------------------------------------------
function pickBestContact(emails) {
  if (!emails || emails.length === 0) return null;

  // Score each email
  const scored = emails.map(e => {
    const title = (e.position || '').toLowerCase();
    const dept = (e.department || '').toLowerCase();
    let score = e.confidence || 0;

    // Boost target titles
    if (TARGET_TITLES.some(t => title.includes(t))) score += 50;
    // Boost executive/management department
    if (dept === 'executive' || dept === 'management') score += 30;
    if (dept === 'engineering' || dept === 'operations') score += 20;
    // Penalize excluded titles
    if (EXCLUDE_TITLES.some(t => title.includes(t))) score -= 100;
    // Penalize unverified
    if (e.verification?.status !== 'valid') score -= 20;

    return { ...e, finalScore: score };
  });

  // Sort by score, pick highest
  scored.sort((a, b) => b.finalScore - a.finalScore);

  // Only return if not an excluded title
  const best = scored[0];
  const bestTitle = (best.position || '').toLowerCase();
  if (EXCLUDE_TITLES.some(t => bestTitle.includes(t))) return null;

  return best;
}

// ---------------------------------------------------------------------------
// Process a single company
// ---------------------------------------------------------------------------
async function processCompany(company) {
  const domain = company.domain.replace(/^www\./, '').trim();
  const result = { ...company, email: '', contactName: '', contactTitle: '', score: 0, status: 'no_email', error: '' };

  // 1. If we already have a contact name, try email finder first
  if (company.contactFirstName && company.contactLastName) {
    const found = await hunterEmailFinder(domain, company.contactFirstName, company.contactLastName);
    if (found && found.email && found.score >= 80) {
      result.email = found.email;
      result.contactName = `${company.contactFirstName} ${company.contactLastName}`;
      result.contactTitle = company.contactTitle || 'Owner';
      result.score = found.score;
      result.status = found.status === 'valid' ? 'verified' : 'unverified';
      return result;
    }
  }

  // 2. Domain search — find all emails and pick the best decision-maker
  const search = await hunterDomainSearch(domain);
  if (search.error) {
    result.error = search.error;
    result.status = 'error';
    return result;
  }

  if (search.emails.length === 0) {
    result.status = 'no_emails_found';
    return result;
  }

  const best = pickBestContact(search.emails);
  if (best) {
    result.email = best.value;
    result.contactName = [best.first_name, best.last_name].filter(Boolean).join(' ');
    result.contactTitle = best.position || 'Owner';
    result.score = best.confidence || 0;
    result.status = best.verification?.status === 'valid' ? 'verified' : 'unverified';
  } else {
    // Fallback: take the first email that isn't generic (info@, contact@, etc.)
    const nonGeneric = search.emails.find(e => e.type === 'personal');
    if (nonGeneric) {
      result.email = nonGeneric.value;
      result.contactName = [nonGeneric.first_name, nonGeneric.last_name].filter(Boolean).join(' ');
      result.contactTitle = nonGeneric.position || 'Owner';
      result.score = nonGeneric.confidence || 0;
      result.status = 'fallback';
    } else {
      result.status = 'only_generic_emails';
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main: read input, process, write output
// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const inputFlag = args.indexOf('--input');
  const inputPath = inputFlag >= 0 ? args[inputFlag + 1] : null;
  const outputFlag = args.indexOf('--output');
  const outputPath = outputFlag >= 0 ? args[outputFlag + 1] : 'enriched-prospects.csv';
  const limitFlag = args.indexOf('--limit');
  const limit = limitFlag >= 0 ? parseInt(args[limitFlag + 1]) : 999;
  const dryRun = args.includes('--dry-run');

  // Load previously emailed domains to avoid
  const logsDir = path.join(__dirname, 'logs');
  const emailedDomains = new Set();
  if (fs.existsSync(logsDir)) {
    const logFiles = fs.readdirSync(logsDir).filter(f => f.startsWith('outreach-') && f.endsWith('.csv'));
    for (const file of logFiles) {
      const lines = fs.readFileSync(path.join(logsDir, file), 'utf8').split('\n').slice(1);
      for (const line of lines) {
        const email = line.split(',')[1]?.replace(/"/g, '').toLowerCase();
        if (email) emailedDomains.add(email.split('@')[1]);
      }
    }
  }
  console.log('Previously contacted domains:', emailedDomains.size);

  // Build company list
  let companies = [];

  if (inputPath) {
    // Read from a simple CSV/text with one domain per line or domain,name columns
    const content = fs.readFileSync(inputPath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('domain'));
    for (const line of lines) {
      const parts = line.split(',').map(s => s.trim());
      const domain = parts[0];
      const firstName = parts[1] || '';
      const lastName = parts[2] || '';
      const title = parts[3] || '';
      if (domain && !emailedDomains.has(domain)) {
        companies.push({ domain, contactFirstName: firstName, contactLastName: lastName, contactTitle: title });
      }
    }
  } else {
    // Read from new-prospects-small-operators.csv — process companies still missing emails
    const csv = fs.readFileSync(path.join(__dirname, 'new-prospects-small-operators.csv'), 'utf8');
    const lines = csv.split('\n').slice(1).filter(l => l.trim());
    for (const line of lines) {
      const fields = [];
      let cur = '', inQ = false;
      for (let i = 0; i < line.length; i++) {
        if (line[i] === '"') inQ = !inQ;
        else if (line[i] === ',' && !inQ) { fields.push(cur); cur = ''; }
        else cur += line[i];
      }
      fields.push(cur);

      const email = (fields[0] || '').trim();
      const companyName = (fields[1] || '').trim();
      const domain = (fields[2] || '').trim();
      const contactName = (fields[3] || '').trim();
      const painPoint = (fields[6] || '').trim();
      const region = (fields[8] || '').trim();

      // Skip if already has email
      if (email) continue;
      if (!domain) continue;

      const nameParts = contactName.split(/\s+/);
      companies.push({
        domain,
        companyName,
        contactFirstName: nameParts[0] || '',
        contactLastName: nameParts.slice(1).join(' ') || '',
        contactTitle: (fields[4] || '').trim(),
        painPoint,
        region,
      });
    }
  }

  companies = companies.slice(0, limit);
  console.log('Companies to process:', companies.length);

  if (companies.length === 0) {
    console.log('Nothing to process.');
    return;
  }

  if (dryRun) {
    console.log('\nDRY RUN — would process:');
    companies.slice(0, 20).forEach((c, i) => console.log(`  ${i + 1}. ${c.domain} (${c.contactFirstName} ${c.contactLastName})`));
    if (companies.length > 20) console.log(`  ... and ${companies.length - 20} more`);
    return;
  }

  console.log('\nProcessing with Hunter API...\n');

  const results = [];
  let found = 0, notFound = 0, errors = 0;

  for (let i = 0; i < companies.length; i++) {
    const c = companies[i];
    process.stdout.write(`[${i + 1}/${companies.length}] ${c.domain} ... `);

    const result = await processCompany(c);
    result.companyName = c.companyName || result.contactName || '';
    result.painPoint = c.painPoint || '';
    result.region = c.region || '';
    results.push(result);

    if (result.email) {
      console.log(`${result.email} (${result.status}, score: ${result.score})`);
      found++;
    } else {
      console.log(`NO EMAIL (${result.status})`);
      notFound++;
    }

    if (result.error) errors++;

    // Rate limit: Hunter free = 25 req/sec, but let's be safe
    await new Promise(r => setTimeout(r, 1200));
  }

  // Write results
  const header = 'email,company_name,website,contact_name,contact_title,vertical,pain_point,difficulty_score,region,hunter_score,hunter_status';
  const csvRows = results
    .filter(r => r.email) // only include companies where we found an email
    .map(r => {
      return [r.email, r.companyName, r.domain, r.contactName, r.contactTitle, 'Aerial Survey', r.painPoint, '2', r.region, r.score, r.status]
        .map(f => { const s = String(f || ''); return s.includes(',') || s.includes('"') ? '"' + s.replace(/"/g, '""') + '"' : s; })
        .join(',');
    });

  fs.writeFileSync(outputPath, header + '\n' + csvRows.join('\n') + '\n');

  console.log('\n========================================');
  console.log('  LEAD FINDER RESULTS');
  console.log('========================================');
  console.log(`  Processed:    ${companies.length}`);
  console.log(`  Emails found: ${found}`);
  console.log(`  Not found:    ${notFound}`);
  console.log(`  Errors:       ${errors}`);
  console.log(`  Output:       ${outputPath}`);
  console.log('========================================');
  console.log(`\nTo send: node run.js --csv ${outputPath} --dry-run`);
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
