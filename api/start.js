#!/usr/bin/env node
/**
 * Точка входа сервера.
 *
 * Вся возня с сертификатом Минцифры вынесена в api/ca.js — там же
 * объяснено, зачем процессу перезапускать самого себя.
 */

const path = require('path');
const { relaunchWithCA } = require('./ca.js');

if (!relaunchWithCA(path.join(__dirname, 'server.js'))) {
  require('./server.js');
}
