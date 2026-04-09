const fs = require('fs');
const { parse } = require('csv-parse/sync');

// Column name normalization map
const COLUMN_ALIASES = {
  email:           ['email', 'email_address', 'e-mail', 'contact_email', 'work_email'],
  companyName:     ['company_name', 'company', 'organization', 'account_name'],
  website:         ['website', 'domain', 'company_domain', 'url', 'company_website'],
  contactName:     ['contact_name', 'name', 'full_name', 'first_name'],
  contactLastName: ['last_name', 'surname'],
  contactTitle:    ['contact_title', 'title', 'job_title', 'target_title', 'position'],
  vertical:        ['vertical', 'industry', 'sector', 'category'],
  painPoint:       ['pain_point', 'description', 'why_they_need_colony', 'notes'],
  difficultyScore: ['difficulty_score', 'acquisition_difficulty', 'score', 'difficulty'],
  region:          ['region', 'location', 'hq', 'headquarters'],
  country:         ['country'],
  city:            ['city'],
  state:           ['state'],
  size:            ['size', 'employees', '#_employees', 'company_size'],
  tags:            ['tags', 'type'],
};

function normalizeColumnName(raw) {
  const key = raw.trim().toLowerCase().replace(/[\s\-\.]+/g, '_').replace(/[#()]/g, '');
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    if (aliases.includes(key)) return field;
  }
  return key;
}

function readProspectCSV(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`CSV file not found: ${filePath}`);
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const records = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  });

  const prospects = [];
  const skipped = [];

  for (let i = 0; i < records.length; i++) {
    const row = records[i];

    // Normalize column names
    const normalized = {};
    for (const [rawKey, value] of Object.entries(row)) {
      const normKey = normalizeColumnName(rawKey);
      normalized[normKey] = value;
    }

    // Combine first + last name if separate
    if (!normalized.contactName && normalized.contactLastName) {
      normalized.contactName = normalized.contactLastName;
    }
    if (normalized.contactName && normalized.contactLastName && !normalized.contactName.includes(normalized.contactLastName)) {
      normalized.contactName = `${normalized.contactName} ${normalized.contactLastName}`;
    }

    // Build region from parts if not present
    if (!normalized.region) {
      const parts = [normalized.city, normalized.state, normalized.country].filter(Boolean);
      if (parts.length) normalized.region = parts.join(', ');
    }

    // Validate required fields
    if (!normalized.email || !normalized.email.includes('@')) {
      skipped.push({ row: i + 2, reason: 'missing or invalid email', data: normalized });
      continue;
    }
    if (!normalized.companyName) {
      skipped.push({ row: i + 2, reason: 'missing company name', data: normalized });
      continue;
    }

    prospects.push({
      email: normalized.email.trim().toLowerCase(),
      companyName: normalized.companyName.trim(),
      website: (normalized.website || '').trim(),
      contactName: (normalized.contactName || '').trim(),
      contactTitle: (normalized.contactTitle || '').trim(),
      vertical: (normalized.vertical || '').trim(),
      painPoint: (normalized.painPoint || '').trim(),
      difficultyScore: parseInt(normalized.difficultyScore) || 0,
      region: (normalized.region || '').trim(),
      country: (normalized.country || '').trim(),
      size: (normalized.size || '').trim(),
      tags: (normalized.tags || '').trim(),
    });
  }

  if (skipped.length > 0) {
    console.log(`\nSkipped ${skipped.length} rows:`);
    for (const s of skipped.slice(0, 10)) {
      console.log(`  Row ${s.row}: ${s.reason}`);
    }
    if (skipped.length > 10) console.log(`  ... and ${skipped.length - 10} more`);
  }

  return prospects;
}

module.exports = { readProspectCSV };
