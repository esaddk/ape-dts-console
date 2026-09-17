'use strict';
// Pure classification for CDC auto-retry-on-disconnect. Kept separate from server.js
// so it's testable without Docker or real container logs — see
// memory/ape_dts_pg_cdc_panic.md for why PG CDC panics instead of failing cleanly.

const MAX_RETRIES = 5;

// Matches the actual panic/error text ape-dts (2.0.22, pinned in lib/docker.js) emits
// for a dropped source connection — NOT a generic "any failure" list. Unmatched text
// (auth failure, missing table, bad host, ...) is deliberately NOT retried: retrying a
// permanent misconfiguration just crash-loops and hides the real error.
const TRANSIENT_PATTERNS = [
  /replication stream error/i,
  /connection reset/i,
  /connection closed/i,
  /broken pipe/i,
  /server closed the connection unexpectedly/i,
  /unexpected eof/i,
];

function isTransient(logText) {
  return TRANSIENT_PATTERNS.some((re) => re.test(logText || ''));
}

function shouldRetry({ retryCount, logText }) {
  return (retryCount || 0) < MAX_RETRIES && isTransient(logText);
}

module.exports = { isTransient, shouldRetry, MAX_RETRIES };
