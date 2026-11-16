'use strict';

// Agentation in local development: its toolbar on every page this server
// renders (Deal Studio, the contract signing page, the offer page, …), so notes
// left on the UI reach the coding agent through the agentation MCP server
// (`npx agentation-mcp server`, default http://localhost:4747).
//
// Agentation is a React component and these pages are plain HTML, so at boot
// the toolbar (with React) is bundled once by esbuild into an in-memory script,
// served at /__dev/agentation.js, and a <script> tag for it is added to each
// HTML response. Nothing here runs unless AGENTATION=1, never in production,
// and agentation / react / react-dom / esbuild are devDependencies only.
//   npm run dev:agentation

const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT_PATH = '/__dev/agentation.js';
const STYLE_PATH = '/__dev/agentation.css';

function entrySource({ endpoint, appName }) {
  return `
    import { createElement } from 'react';
    import { createRoot } from 'react-dom/client';
    import { Agentation } from 'agentation';
    const mount = () => {
      if (document.getElementById('agentation-root')) return;
      const el = document.createElement('div');
      el.id = 'agentation-root';
      document.body.appendChild(el);
      createRoot(el).render(createElement(Agentation, { endpoint: ${JSON.stringify(endpoint)}, appName: ${JSON.stringify(appName)} }));
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
    else mount();
  `;
}

async function buildBundle(opts) {
  const esbuild = require('esbuild');
  const result = await esbuild.build({
    stdin: { contents: entrySource(opts), resolveDir: ROOT, loader: 'js', sourcefile: 'agentation-entry.js' },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    write: false,
    outdir: path.join(ROOT, '.agentation-build'),
    define: { 'process.env.NODE_ENV': '"development"' },
    logLevel: 'silent',
  });
  const js = result.outputFiles.find((f) => f.path.endsWith('.js'));
  const css = result.outputFiles.find((f) => f.path.endsWith('.css'));
  return { js: js ? js.text : '', css: css ? css.text : '' };
}

function tagsFor(bundle) {
  return (bundle.css ? `<link rel="stylesheet" href="${STYLE_PATH}">` : '') + `<script src="${SCRIPT_PATH}" defer></script>`;
}

// Add the toolbar's tags to an HTML response, whichever way it is sent
// (express.static, res.sendFile, res.send). The body is buffered so its
// Content-Length can be dropped; only text/html responses are touched.
function injectHtml(getTags) {
  return (req, res, next) => {
    if (req.method !== 'GET' || /^\/(api|webhook|__dev)\//.test(req.path)) return next();
    // Always send a full page (a 304 would replay the cached page without the tag).
    delete req.headers['if-none-match'];
    delete req.headers['if-modified-since'];

    const write = res.write;
    const end = res.end;
    const chunks = [];
    let html = null;
    const isHtml = () => {
      if (html === null) html = /text\/html/i.test(String(res.getHeader('content-type') || ''));
      return html;
    };
    const toBuf = (chunk, enc) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof enc === 'string' ? enc : 'utf8'));

    res.write = function (chunk, enc, cb) {
      if (!isHtml()) return write.call(res, chunk, enc, cb);
      if (chunk != null) chunks.push(toBuf(chunk, enc));
      if (typeof enc === 'function') enc();
      else if (typeof cb === 'function') cb();
      return true;
    };
    res.end = function (chunk, enc, cb) {
      if (typeof chunk === 'function') { cb = chunk; chunk = null; }
      if (typeof enc === 'function') { cb = enc; enc = undefined; }
      if (!isHtml()) return end.call(res, chunk, enc, cb);
      if (chunk != null) chunks.push(toBuf(chunk, enc));
      let body = Buffer.concat(chunks).toString('utf8');
      if (!body.includes(SCRIPT_PATH)) {
        const tags = getTags();
        body = /<\/body>/i.test(body) ? body.replace(/<\/body>/i, `${tags}</body>`) : body + tags;
      }
      if (!res.headersSent) res.removeHeader('content-length');
      return end.call(res, body, 'utf8', cb);
    };
    next();
  };
}

function install(app, { endpoint = process.env.AGENTATION_ENDPOINT || 'http://localhost:4747', appName = 'Deal Studio' } = {}) {
  if (process.env.NODE_ENV === 'production') {
    console.warn('[agentation] AGENTATION is set but NODE_ENV=production — not installing the toolbar.');
    return;
  }
  let bundle = null;
  const ready = buildBundle({ endpoint, appName })
    .then((b) => {
      bundle = b;
      console.log(`[agentation] toolbar on every page → notes go to ${endpoint}`);
    })
    .catch((err) => {
      console.warn(`[agentation] could not build the toolbar (${err.message}) — run npm install in backend/ for the dev dependencies.`);
    });

  app.get(SCRIPT_PATH, async (_req, res) => {
    await ready;
    res.type('application/javascript').set('Cache-Control', 'no-store').send(bundle ? bundle.js : '/* agentation unavailable */');
  });
  app.get(STYLE_PATH, async (_req, res) => {
    await ready;
    res.type('text/css').set('Cache-Control', 'no-store').send(bundle ? bundle.css : '');
  });
  app.use(injectHtml(() => (bundle ? tagsFor(bundle) : `<script src="${SCRIPT_PATH}" defer></script>`)));
}

module.exports = { install, injectHtml, entrySource };
