'use strict';

const crypto = require('crypto');

function requestId(req, res, next) {
  const incoming = req.get('x-request-id');
  req.id = typeof incoming === 'string' && /^[A-Za-z0-9._-]{8,128}$/.test(incoming)
    ? incoming
    : crypto.randomUUID();
  res.setHeader('x-request-id', req.id);
  next();
}

module.exports = requestId;
