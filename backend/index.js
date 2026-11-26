'use strict';

/**
 * API sözleşmesini test edilebilir hâle getiren giriş noktası.
 * `server.js` bunu kullanır; testler doğrudan `createApp()` çağırır.
 */

const config = require('./config');
const { createApp } = require('./app');

module.exports = { createApp, config };
