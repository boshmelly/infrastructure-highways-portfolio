#!/usr/bin/env node
// illas-recruiter-agent.js
// Daily: search for 75%+ match jobs and clean up expired unapplied listings.
// Zero external dependencies - native https module only.

const https = require('https');
const fs = require('fs');
const path = require('path');

const JOBS_FILE = path.join(__dirname, 'jobs.json');
const APP_ID   = process.env.ADZUNA_APP_ID  || '';
const APP_KEY  = process.env.ADZUNA_APP_KEY || '';
const COUNTRY  = 'gb';
const TODAY    = new Date().toISOString().split('T')[0];

// --- Scoring profile (Ola Mellila) ---
const PROFILE = {
  high:   { weight: 15, terms: ['traffic management', 'nrswa', 'highway', 'lantra', 'm7', '12d', 'tsrgd'] },
  medium: { weight: 9,  terms: ['tfl', 'hs2', 'infrastructure', 'programme manager', 'traffic signs', 'permit', 'undertaking'] },
  low:    { weight: 4,  terms: ['stakeholder', 'compliance', 'supervisor', 'civil', 'construction', 'contractor'] }
};
const THRESHOLD = 75;

// --- Lean search queries for Ola's profile ---
const QUERIES = [
  'traffic management manager London',
  'NRSWA highways manager London',
  'traffic management coordinator infrastructure London'
];

function score(job) {
  const txt = `${job.title} ${job.description || ''} ${job.category || ''}`.toLowerCase();
  let pts = 0;
  for (const [, { weight, terms }] of Object.entries(PROFILE)) {
    for (const t of terms) if (txt.includes(t)) pts += weight;
  }
  return Math.min(100, pts);
}

function matchReasons(job) {
  const txt = `${job.title} ${job.description || ''}`.toLowerCase();
  return Object.values(PROFILE).flatMap(({ terms }) => terms.filter(t => txt.includes(t)));
}

function load() {
  if (!fs.existsSync(JOBS_FILE)) return { jobs: [], last_updated: null };
  return JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
}

function save(store) {
  store.last_updated = new Date().toISOString();
  fs.writeFileSync(JOBS_FILE, JSON.stringify(store, null, 2));
}

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return get(res.headers.location).then(resolve).catch(reject);
      }
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); }
        catch (e) { reject(new Error(`Parse error: ${buf.slice(0, 80)}`)); }
      });
    }).on('error', reject);
  });
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchAdzuna(query) {
  const url = `https://api.adzuna.com/v1/api/jobs/${COUNTRY}/search/1`
    + `?app_id=${APP_ID}&app_key=${APP_KEY}`
    + `&results_per_page=20&max_days_old=7`
    + `&what=${encodeURIComponent(query)}&where=London`
    + `&content-type=application%2Fjson`;
  return get(url);
}

async function run() {
  const store = load();
  const seen  = new Set(store.jobs.map(j => j.id));
  let added = 0, removed = 0;

  // 1. Remove expired unapplied jobs
  store.jobs = store.jobs.filter(j => {
    if (j.status !== 'applied' && j.closing_date && j.closing_date < TODAY) {
      removed++;
      return false;
    }
    return true;
  });

  // 2. Fetch and score new jobs
  if (!APP_ID || !APP_KEY) {
    console.log('WARN: ADZUNA_APP_ID / ADZUNA_APP_KEY not set. Skipping search.');
    console.log('      Register free at https://developer.adzuna.com and add secrets to GitHub.');
  } else {
    for (const q of QUERIES) {
      try {
        const res = await fetchAdzuna(q);
        for (const item of (res.results || [])) {
          if (seen.has(item.id)) continue;
          const s = score(item);
          if (s < THRESHOLD) continue;
          const closing = item.expiration_date ? item.expiration_date.split('T')[0] : null;
          store.jobs.push({
            id:            item.id,
            title:         item.title,
            company:       item.company?.display_name || 'Unknown',
            location:      item.location?.display_name || 'London',
            salary:        item.salary_min
                             ? `£${Math.round(item.salary_min / 1000)}k - £${Math.round(item.salary_max / 1000)}k`
                             : 'Not stated',
            match_score:   s,
            match_reasons: matchReasons(item),
            posted_date:   item.created?.split('T')[0] || TODAY,
            closing_date:  closing,
            url:           item.redirect_url,
            source:        'adzuna',
            status:        'new',
            added_at:      new Date().toISOString()
          });
          seen.add(item.id);
          added++;
        }
      } catch (e) {
        console.error(`Search failed: "${q}" -`, e.message);
      }
      await delay(600);
    }
  }

  // Sort by match score desc
  store.jobs.sort((a, b) => b.match_score - a.match_score);

  save(store);
  console.log(`[${TODAY}] Done. +${added} added | -${removed} expired removed | ${store.jobs.length} total jobs.`);
}

run().catch(e => { console.error(e); process.exit(1); });
