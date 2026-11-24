'use strict';

/**
 * REsume360 resume analysis endpoint.
 * Deploy as a separate Render Web Service with:
 *   Start command: node resume360-analysis-api.js
 *   Secret: OPENAI_API_KEY
 *   Optional env: OPENAI_MODEL, RESUME360_ORIGIN
 *
 * Resume text is never written to disk or application logs.
 */
const http = require('node:http');

const PORT = Number(process.env.PORT || 10000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-6-luna';
const ALLOWED_ORIGIN = process.env.RESUME360_ORIGIN || 'https://resume360.onrender.com';
const MAX_RESUME_CHARS = 60000;
const MAX_BODY_BYTES = 90000;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT = 4;
const requests = new Map();

const schema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    seniority: { type: 'string', enum: ['early-career', 'mid-level', 'senior', 'lead', 'executive', 'unclear'] },
    qualifyingTitles: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          fit: { type: 'string', enum: ['strong', 'adjacent', 'stretch'] },
          rationale: { type: 'string' },
          evidence: { type: 'array', items: { type: 'string' } },
          gaps: { type: 'array', items: { type: 'string' } },
          industries: { type: 'array', items: { type: 'string' } }
        },
        required: ['title', 'fit', 'rationale', 'evidence', 'gaps', 'industries']
      }
    },
    industries: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          fit: { type: 'string', enum: ['strong', 'adjacent', 'exploratory'] },
          rationale: { type: 'string' },
          evidence: { type: 'array', items: { type: 'string' } },
          exampleTitles: { type: 'array', items: { type: 'string' } }
        },
        required: ['name', 'fit', 'rationale', 'evidence', 'exampleTitles']
      }
    },
    nextSteps: { type: 'array', items: { type: 'string' } }
  },
  required: ['summary', 'seniority', 'qualifyingTitles', 'industries', 'nextSteps']
};

function json(res, status, value, origin) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
  if (origin && origin === ALLOWED_ORIGIN) headers['Access-Control-Allow-Origin'] = origin;
  res.writeHead(status, headers);
  res.end(JSON.stringify(value));
}

function redactCommonContact(text) {
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email removed]')
    .replace(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/g, '[phone removed]');
}

function rateLimit(ip) {
  const now = Date.now();
  const recent = (requests.get(ip) || []).filter(time => now - time < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) {
    requests.set(ip, recent);
    return false;
  }
  recent.push(now);
  requests.set(ip, recent);
  return true;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let bytes = 0;
    req.setEncoding('utf8');
    req.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request too large'), { status: 413 }));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); }
      catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  if (origin && origin !== ALLOWED_ORIGIN) return json(res, 403, { error: 'This site is not allowed to use the analysis service.' }, origin);
  if (req.method === 'OPTIONS') return json(res, 204, {}, origin);
  if (req.method === 'GET' && req.url === '/healthz') {
    return json(res, 200, { ok: true, analysisConfigured: Boolean(OPENAI_API_KEY) }, origin);
  }
  if (req.method !== 'POST' || req.url !== '/analyze') return json(res, 404, { error: 'Not found.' }, origin);

  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  if (!rateLimit(ip)) return json(res, 429, { error: 'Too many analysis requests. Please wait a few minutes and try again.' }, origin);
  if (!OPENAI_API_KEY) return json(res, 503, { error: 'AI analysis is not configured yet. Please try again later.' }, origin);

  try {
    const body = await readJson(req);
    if (body.privacyConsent !== true) return json(res, 400, { error: 'Please review the resume privacy notice before continuing.' }, origin);
    if (typeof body.resumeText !== 'string' || !body.resumeText.trim()) return json(res, 400, { error: 'Add resume text before analysis.' }, origin);
    if (body.resumeText.length > MAX_RESUME_CHARS) return json(res, 413, { error: 'This resume is longer than the current analysis limit. Try a shorter version.' }, origin);

    const resumeText = redactCommonContact(body.resumeText).slice(0, MAX_RESUME_CHARS);
    const instructions = [
      'You are a careful career analyst. Read the full resume and identify specific roles this person has evidence to pursue now, plus realistic adjacent options.',
      'Use role titles and industries grounded in the resume, not generic aspirational suggestions. Do not recommend AI/ML Engineer, data scientist, software developer, or another technical title based only on a course, tool mention, or passing reference; require substantial relevant project and hands-on evidence.',
      'Distinguish strong fit (clear direct evidence), adjacent (transferable experience with a small gap), and stretch (material skills or scope gap). Never claim the person is qualified for a regulated or licensed role without explicit evidence.',
      'Cite concrete resume phrases in evidence. Never invent years, outcomes, credentials, employers, tools, seniority, or metrics. If evidence is insufficient, say so and return fewer matches rather than filling the list.',
      'Return at most 6 qualifying titles, at most 5 industries, and at most 4 practical next steps. Describe industries by specific sectors supported by employers, products, customers, or work context. Avoid inferring protected traits or personal circumstances.',
      'Do not estimate salary, claim there is a current vacancy, or guarantee hiring. Keep language direct and respectful. Return only the required structured data.'
    ].join(' ');

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + OPENAI_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        store: false,
        instructions,
        input: 'Analyze this resume for role and industry fit. Resume text follows:\n\n' + resumeText,
        max_output_tokens: 2200,
        text: {
          format: {
            type: 'json_schema',
            name: 'resume_role_industry_analysis',
            strict: true,
            schema
          }
        }
      }),
      signal: AbortSignal.timeout(45000)
    });

    if (!response.ok) {
      console.error('Resume analysis provider returned HTTP', response.status);
      return json(res, 502, { error: 'The analysis service could not complete this request. Please try again.' }, origin);
    }
    const result = await response.json();
    const output = (result.output || []).flatMap(item => item.content || []).find(item => item.type === 'output_text')?.text;
    if (!output) return json(res, 502, { error: 'The analysis service returned no usable profile. Please try again.' }, origin);
    const analysis = JSON.parse(output);
    return json(res, 200, { analysis }, origin);
  } catch (error) {
    if (error.status) return json(res, error.status, { error: error.message }, origin);
    console.error('Resume analysis request failed:', error.name || 'Error');
    return json(res, 502, { error: 'The analysis service is temporarily unavailable. Please try again.' }, origin);
  }
});

server.listen(PORT, '0.0.0.0', () => console.log('REsume360 analysis service listening on', PORT));
