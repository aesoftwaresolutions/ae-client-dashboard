'use strict';
// Entry point: `node server.js`. Plain Node http server, no framework.
const http = require('node:http');
const config = require('./src/config');
const h = require('./src/http');
const { handleWeb } = require('./src/web');
const { handleApi } = require('./src/api');
const views = require('./src/views');

const server = http.createServer(async (req, res) => {
  h.securityHeaders(res);
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/static/')) {
      if (h.serveStatic(res, url.pathname)) return;
      return h.send(res, 404, 'Not found', 'text/plain');
    }
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if ((await handleWeb(req, res, url)) === false) {
      h.html(res, 404, views.messagePage('Page not found', 'That page does not exist.'));
    }
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error('[server] error:', err);
    if (!res.headersSent) h.send(res, status, status === 500 ? 'Server error' : err.message, 'text/plain');
  }
});

server.listen(config.port, () => console.log(`AE Client Dashboard listening on port ${config.port}`));
