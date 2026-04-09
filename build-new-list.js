const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

// ===================================================================
// Build a clean, deduplicated CSV for the outreach engine
// Merges both research sources, removes overlap with previous campaigns
// ===================================================================

// 1. Load the first CSV (44 companies)
const csv1Path = path.join(__dirname, '..', 'outreach lists', 'drone-companies-prospect-list-2026-04-08.csv');
const csv1 = parse(fs.readFileSync(csv1Path, 'utf8'), { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true });

// 2. Load the second source (markdown — parse manually)
const mdPath = path.join(__dirname, '..', 'target-small-drone-companies.md');
const mdContent = fs.readFileSync(mdPath, 'utf8');
const mdCompanies = [];
const tableRows = mdContent.match(/\|\s*\d+\s*\|[^|]+\|[^|]+\|[^|]+\|[^|]+\|[^|]+\|[^|]+\|[^|]+\|[^|]+\|/g) || [];
for (const row of tableRows) {
  const cells = row.split('|').map(c => c.trim()).filter(c => c);
  if (cells.length >= 8) {
    const [num, name, whatTheyDo, website, location, size, founded, contact, email] = cells;
    mdCompanies.push({
      name: name.replace(/\*\*/g, '').trim(),
      whatTheyDo: whatTheyDo.trim(),
      website: website.trim(),
      location: location.trim(),
      size: size.trim(),
      founded: founded.trim(),
      contact: contact.trim(),
      email: (email || '').trim(),
    });
  }
}

// 3. Load ALL previously emailed addresses (from logs)
const logsDir = path.join(__dirname, 'logs');
const previouslySent = new Set();
if (fs.existsSync(logsDir)) {
  const logFiles = fs.readdirSync(logsDir).filter(f => f.startsWith('outreach-') && f.endsWith('.csv'));
  for (const file of logFiles) {
    const lines = fs.readFileSync(path.join(logsDir, file), 'utf8').split('\n').slice(1);
    for (const line of lines) {
      if (!line.trim()) continue;
      const email = line.split(',')[1]?.replace(/"/g, '').toLowerCase();
      if (email) previouslySent.add(email);
    }
  }
}
console.log('Previously emailed addresses:', previouslySent.size);

// 4. Load previously contacted company domains (from all existing prospect lists)
const previousDomains = new Set();
const existingFiles = [
  path.join(__dirname, '..', 'apollo_accounts_import.csv'),
  path.join(__dirname, '..', 'apollo_endcustomer_accounts.csv'),
];
for (const f of existingFiles) {
  if (!fs.existsSync(f)) continue;
  const rows = parse(fs.readFileSync(f, 'utf8'), { columns: true, skip_empty_lines: true, trim: true });
  rows.forEach(r => {
    const domain = (r.Website || r.website || '').toLowerCase().replace(/^www\./, '');
    if (domain) previousDomains.add(domain);
  });
}
console.log('Previously contacted domains:', previousDomains.size);

// 5. Merge and deduplicate
const allCompanies = new Map(); // domain -> company object

// From CSV1
for (const row of csv1) {
  const domain = (row.Website || '').toLowerCase().replace(/^www\./, '').trim();
  if (!domain) continue;
  if (previousDomains.has(domain)) continue;

  const region = [row.Location, row['State/Province'], row.Country === 'CA' ? 'Canada' : row.Country === 'US' ? 'USA' : ''].filter(Boolean).join(', ');

  allCompanies.set(domain, {
    company_name: row['Company Name'] || '',
    website: domain,
    vertical: row.Category || 'Aerial Survey',
    pain_point: row['What They Do'] + (row.Notes ? ' ' + row.Notes : ''),
    region: region,
    size: row['Approx Employees'] || '',
    contact_name: row['Contact Name'] || '',
    contact_title: row['Contact Title'] || 'Owner',
    contact_email: row['Email Pattern / Contact Email'] || '',
    linkedin: row['LinkedIn URL'] || '',
  });
}

// From MD
for (const c of mdCompanies) {
  const domain = c.website.toLowerCase().replace(/^www\./, '').trim();
  if (!domain) continue;
  if (previousDomains.has(domain)) continue;
  if (allCompanies.has(domain)) continue; // already from CSV1

  // Parse location into region
  const isCanada = c.location.match(/\b(AB|BC|ON|SK|MB|QC|NB|NS|PE|NL|YT|NT|NU)\b/) || c.location.includes('Canada');
  const country = isCanada ? 'Canada' : 'USA';

  allCompanies.set(domain, {
    company_name: c.name,
    website: domain,
    vertical: 'Aerial Survey',
    pain_point: c.whatTheyDo,
    region: c.location + ', ' + country,
    size: c.size,
    contact_name: c.contact.replace(/\(.*?\)/g, '').replace(/CEO|Founder|President|Owner|Co-founder|Managing Director/gi, '').replace(/[,&:]/g, '').trim().split(/\s+/).slice(0, 3).join(' '),
    contact_title: 'Owner',
    contact_email: c.email.includes('@') ? c.email : '',
    linkedin: '',
  });
}

// 6. Final filter: remove any company whose domain matches a previously-emailed address domain
const emailedDomains = new Set();
previouslySent.forEach(e => { const d = e.split('@')[1]; if (d) emailedDomains.add(d); });

const final = [];
for (const [domain, company] of allCompanies) {
  // Skip if we already emailed someone at this domain
  if (emailedDomains.has(domain)) continue;
  final.push(company);
}

console.log('\nMerge results:');
console.log('  From CSV1:', csv1.length);
console.log('  From Markdown:', mdCompanies.length);
console.log('  After dedup + domain filter:', final.length);

// 7. Write outreach-engine-compatible CSV
// Format: email,company_name,website,contact_name,contact_title,vertical,pain_point,difficulty_score,region
const header = 'email,company_name,website,contact_name,contact_title,vertical,pain_point,difficulty_score,region';
const rows = final.map(c => {
  const fields = [
    c.contact_email, // email — may be empty, user needs to fill via Hunter
    c.company_name,
    c.website,
    c.contact_name,
    c.contact_title,
    c.vertical,
    c.pain_point,
    '2', // difficulty score — all small companies
    c.region,
  ];
  return fields.map(f => {
    const s = String(f || '');
    return s.includes(',') || s.includes('"') || s.includes('\n') ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',');
});

const csvOut = header + '\n' + rows.join('\n') + '\n';
const outPath = path.join(__dirname, 'new-prospects-small-operators.csv');
fs.writeFileSync(outPath, csvOut, 'utf8');

console.log('\nSaved:', outPath);
console.log('Total companies:', final.length);
console.log('With email:', final.filter(c => c.contact_email).length);
console.log('Need email lookup:', final.filter(c => !c.contact_email).length);

// Also write a Hunter-ready CSV for email lookup
const hunterHeader = 'company_name,domain,contact_name,contact_title';
const hunterRows = final.filter(c => !c.contact_email).map(c => {
  return [c.company_name, c.website, c.contact_name, c.contact_title].map(f => {
    const s = String(f || '');
    return s.includes(',') ? '"' + s + '"' : s;
  }).join(',');
});
const hunterPath = path.join(__dirname, 'hunter-lookup-needed.csv');
fs.writeFileSync(hunterPath, hunterHeader + '\n' + hunterRows.join('\n') + '\n', 'utf8');
console.log('\nHunter lookup list:', hunterPath);
console.log('Companies needing email lookup:', hunterRows.length);
