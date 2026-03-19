const express = require('express');
const path = require('path');
const fs = require('fs');
const { XMLParser } = require('fast-xml-parser');

// ---------------------------------------------------------------------------
// Load .env file manually (no dotenv dependency)
// ---------------------------------------------------------------------------
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

const PORT = process.env.PORT || 3000;
const COMPANIES_HOUSE_API_KEY = process.env.COMPANIES_HOUSE_API_KEY || '';
const OPENSANCTIONS_API_KEY = process.env.OPENSANCTIONS_API_KEY || '';
const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY || '';
const SEC_USER_AGENT = 'KaylaPKYCDemo demo@example.com';

const app = express();
app.use(require('cors')());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/mockups', express.static(path.join(__dirname, 'public', 'mockups')));

// ---------------------------------------------------------------------------
// OFAC SDN list — downloaded and parsed on startup, searched in memory
// ---------------------------------------------------------------------------
let sdnEntries = [];

async function loadOFAC() {
  try {
    console.log('[OFAC] Downloading SDN list...');
    const start = Date.now();
    const res = await fetch('https://www.treasury.gov/ofac/downloads/sdn.xml');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const parser = new XMLParser({ ignoreAttributes: false });
    const parsed = parser.parse(xml);
    const entries = parsed?.sdnList?.sdnEntry || [];
    sdnEntries = (Array.isArray(entries) ? entries : [entries]).map(e => ({
      uid: e.uid,
      name: [e.firstName, e.lastName].filter(Boolean).join(' ') || e.lastName || '',
      type: e.sdnType || '',
      programs: e.programList?.program || [],
      remarks: e.remarks || '',
    }));
    console.log(`[OFAC] Loaded ${sdnEntries.length} entries in ${Date.now() - start}ms`);
  } catch (err) {
    console.warn(`[OFAC] Failed to download SDN list: ${err.message}. OFAC search will return empty results.`);
    sdnEntries = [];
  }
}

// ---------------------------------------------------------------------------
// Logging middleware for /api routes
// ---------------------------------------------------------------------------
app.use('/api', (req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

// ---------------------------------------------------------------------------
// SEC EDGAR proxies
// ---------------------------------------------------------------------------
app.get('/api/sec/search', async (req, res) => {
  try {
    const { q, forms } = req.query;
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (forms) params.set('forms', forms);
    const url = `https://efts.sec.gov/LATEST/search-index?${params}`;
    const r = await fetch(url, { headers: { 'User-Agent': SEC_USER_AGENT } });
    if (!r.ok) return res.status(r.status).json({ error: `SEC search returned ${r.status}` });
    res.json(await r.json());
  } catch (err) {
    res.status(502).json({ error: 'SEC search unavailable', details: err.message });
  }
});

app.get('/api/sec/submissions/:cik', async (req, res) => {
  try {
    const cik = req.params.cik.replace(/\D/g, '').padStart(10, '0');
    const url = `https://data.sec.gov/submissions/CIK${cik}.json`;
    const r = await fetch(url, { headers: { 'User-Agent': SEC_USER_AGENT } });
    if (!r.ok) return res.status(r.status).json({ error: `SEC submissions returned ${r.status}` });
    res.json(await r.json());
  } catch (err) {
    res.status(502).json({ error: 'SEC submissions unavailable', details: err.message });
  }
});

// ---------------------------------------------------------------------------
// UK Companies House proxies
// ---------------------------------------------------------------------------
const CH_BASE = 'https://api.company-information.service.gov.uk';

function chAuth() {
  return 'Basic ' + Buffer.from(COMPANIES_HOUSE_API_KEY + ':').toString('base64');
}

app.get('/api/ch/search', async (req, res) => {
  try {
    const { q } = req.query;
    const url = `${CH_BASE}/search/companies?q=${encodeURIComponent(q || '')}`;
    const r = await fetch(url, { headers: { Authorization: chAuth() } });
    if (!r.ok) return res.status(r.status).json({ error: `Companies House search returned ${r.status}` });
    res.json(await r.json());
  } catch (err) {
    res.status(502).json({ error: 'Companies House unavailable', details: err.message });
  }
});

app.get('/api/ch/company/:number', async (req, res) => {
  try {
    const url = `${CH_BASE}/company/${encodeURIComponent(req.params.number)}`;
    const r = await fetch(url, { headers: { Authorization: chAuth() } });
    if (!r.ok) return res.status(r.status).json({ error: `Companies House returned ${r.status}` });
    res.json(await r.json());
  } catch (err) {
    res.status(502).json({ error: 'Companies House unavailable', details: err.message });
  }
});

app.get('/api/ch/company/:number/officers', async (req, res) => {
  try {
    const url = `${CH_BASE}/company/${encodeURIComponent(req.params.number)}/officers`;
    const r = await fetch(url, { headers: { Authorization: chAuth() } });
    if (!r.ok) return res.status(r.status).json({ error: `Companies House returned ${r.status}` });
    res.json(await r.json());
  } catch (err) {
    res.status(502).json({ error: 'Companies House unavailable', details: err.message });
  }
});

app.get('/api/ch/company/:number/psc', async (req, res) => {
  try {
    const url = `${CH_BASE}/company/${encodeURIComponent(req.params.number)}/persons-with-significant-control`;
    const r = await fetch(url, { headers: { Authorization: chAuth() } });
    if (!r.ok) return res.status(r.status).json({ error: `Companies House returned ${r.status}` });
    res.json(await r.json());
  } catch (err) {
    res.status(502).json({ error: 'Companies House unavailable', details: err.message });
  }
});

// ---------------------------------------------------------------------------
// OpenSanctions proxy
// ---------------------------------------------------------------------------
app.get('/api/sanctions/opensanctions', async (req, res) => {
  try {
    const { q } = req.query;
    const url = `https://api.opensanctions.org/search/default?q=${encodeURIComponent(q || '')}`;
    const headers = {};
    if (OPENSANCTIONS_API_KEY) {
      headers['Authorization'] = `ApiKey ${OPENSANCTIONS_API_KEY}`;
    }
    const r = await fetch(url, { headers });
    if (!r.ok) return res.status(r.status).json({ error: `OpenSanctions returned ${r.status}` });
    res.json(await r.json());
  } catch (err) {
    res.status(502).json({ error: 'OpenSanctions unavailable', details: err.message });
  }
});

// ---------------------------------------------------------------------------
// OFAC SDN local search
// ---------------------------------------------------------------------------
app.get('/api/sanctions/ofac', (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  if (!q) return res.json({ results: [], query: '' });
  const matches = sdnEntries.filter(e => e.name.toLowerCase().includes(q));
  res.json({ results: matches, query: req.query.q, total: matches.length });
});

// ---------------------------------------------------------------------------
// Perplexity Sonar API — AI-powered news search
// ---------------------------------------------------------------------------
async function callPerplexity(messages, model = 'sonar') {
  const r = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${PERPLEXITY_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, messages }),
  });
  if (!r.ok) throw new Error(`Perplexity returned ${r.status}: ${await r.text()}`);
  return r.json();
}

app.post('/api/perplexity/search', async (req, res) => {
  if (!PERPLEXITY_API_KEY) {
    return res.status(503).json({ error: 'PERPLEXITY_API_KEY not configured' });
  }
  try {
    const { query } = req.body;
    const data = await callPerplexity([{ role: 'user', content: query }]);
    const content = data.choices?.[0]?.message?.content || '';
    const citations = data.citations || [];
    res.json({ content, citations, model: data.model, usage: data.usage });
  } catch (err) {
    res.status(502).json({ error: 'Perplexity search failed', details: err.message });
  }
});

app.post('/api/perplexity/extract', async (req, res) => {
  if (!PERPLEXITY_API_KEY) {
    return res.status(503).json({ error: 'PERPLEXITY_API_KEY not configured' });
  }
  try {
    const { url, title } = req.body;
    const prompt = `Analyze this news article for KYC/AML compliance purposes: "${title}" (${url}).

Provide a structured extraction with these exact sections:
1. ARTICLE SUMMARY: 2-3 sentence summary of the article
2. MATERIAL CHANGE TYPE: What type of corporate change is described (e.g., Acquisition, Merger, Funding Round, Executive Change)
3. ENTITIES IDENTIFIED: List all companies and their roles (acquirer, target, investor, etc.)
4. KEY INDIVIDUALS: List people mentioned with their titles and relevance
5. FINANCIAL DETAILS: Any deal values, funding amounts, or financial metrics
6. REGULATORY IMPLICATIONS: What compliance actions this would trigger (change of beneficial ownership, new UBO identification, sanctions screening, etc.)
7. RISK INDICATORS: Any red flags or positive indicators for compliance purposes
8. CONFIDENCE LEVEL: How reliable is this information based on the source`;

    const data = await callPerplexity([{ role: 'user', content: prompt }]);
    const content = data.choices?.[0]?.message?.content || '';
    const citations = data.citations || [];
    res.json({ content, citations, model: data.model });
  } catch (err) {
    res.status(502).json({ error: 'Perplexity extraction failed', details: err.message });
  }
});

// ---------------------------------------------------------------------------
// Stub endpoints for paid data sources
// ---------------------------------------------------------------------------
function stubHandler(filename, minDelay, maxDelay) {
  return async (req, res) => {
    const filePath = path.join(__dirname, 'stubs', filename);
    try {
      const data = await fs.promises.readFile(filePath, 'utf8');
      const delay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
      setTimeout(() => {
        res.setHeader('Content-Type', 'application/json');
        res.send(data);
      }, delay);
    } catch (err) {
      res.status(404).json({ error: `Stub file ${filename} not found`, details: err.message });
    }
  };
}

app.get('/api/stubs/bvd-orbis', stubHandler('bvd-orbis.json', 300, 600));
app.get('/api/stubs/dun-bradstreet', stubHandler('dun-bradstreet.json', 200, 500));
app.get('/api/stubs/crunchbase', stubHandler('crunchbase.json', 200, 400));
app.get('/api/stubs/pitchbook', stubHandler('pitchbook.json', 300, 500));
app.get('/api/stubs/dow-jones', stubHandler('dow-jones.json', 400, 700));
app.get('/api/stubs/world-check', stubHandler('world-check.json', 300, 600));

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Kayla pKYC Live server running on http://localhost:${PORT}`);
  // Download OFAC SDN list in background — server is already accepting requests
  loadOFAC();
});
