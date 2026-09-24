'use strict';
// Small-team login: a handful of accounts in a local JSON file, no DB. Passwords are
// scrypt-hashed (stdlib, no new dependency); sessions are a signed cookie (HMAC),
// not a store — nothing to clean up, verification is just recomputing the signature.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const USERS_PATH = path.join(__dirname, '..', 'auth', 'users.json');
const SCRYPT_KEYLEN = 64;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// A fresh random secret each boot means restarting the server logs everyone out.
// Acceptable for a small internal tool; set SESSION_SECRET to survive restarts.
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
  console.warn('SESSION_SECRET not set — sessions will not survive a server restart. Set SESSION_SECRET to persist logins.');
}

function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveUsers(users) {
  fs.mkdirSync(path.dirname(USERS_PATH), { recursive: true });
  fs.writeFileSync(USERS_PATH, JSON.stringify(users, null, 2));
}

// Empty/missing users file means "not set up yet" — callers use this to force the
// first visitor through the create-admin-account flow (see server.js's setup gate)
// instead of leaving the app open.
function hasUsers() {
  return Object.keys(loadUsers()).length > 0;
}

function listUsers() {
  const users = loadUsers();
  return Object.keys(users).map((username) => ({ username, role: users[username].role }));
}

function addUser(username, password, role) {
  if (!username || !password) throw new Error('username and password are required');
  if (role !== 'admin' && role !== 'user') throw new Error('role must be "admin" or "user"');
  const users = loadUsers();
  users[username] = { hash: hashPassword(password), role };
  saveUsers(users);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hashHex] = (stored || '').split(':');
  if (!salt || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  // A malformed (non-hex) stored hash parses to a 0-length buffer — without this
  // check, scryptSync(..., 0) also returns 0 bytes and timingSafeEqual treats two
  // empty buffers as equal, so any password would "verify" against a corrupt hash.
  if (expected.length === 0) return false;
  const actual = crypto.scryptSync(password, salt, expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// Returns { username, role } on success, null on failure — the caller embeds the
// role in the session token so later requests don't need to re-read the users file.
function verifyLogin(username, password) {
  const user = loadUsers()[username];
  if (!user || !verifyPassword(password, user.hash)) return null;
  return { username, role: user.role };
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

// Returns the session payload ({ u, exp }) if the token is validly signed and
// unexpired, otherwise null — callers treat null as "not logged in", no exceptions.
function verifySession(token) {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function createSessionToken(username, role) {
  return sign({ u: username, role, exp: Date.now() + SESSION_TTL_MS });
}

module.exports = {
  hashPassword, verifyPassword, verifyLogin, createSessionToken, verifySession,
  hasUsers, listUsers, addUser, SESSION_TTL_MS,
};
