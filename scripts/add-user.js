#!/usr/bin/env node
'use strict';
// Adds or updates one account in auth/users.json. Usage:
//   node scripts/add-user.js <username> <password>
const fs = require('fs');
const path = require('path');
const { hashPassword } = require('../lib/auth.js');

const [username, password] = process.argv.slice(2);
if (!username || !password) {
  console.error('Usage: node scripts/add-user.js <username> <password>');
  process.exit(1);
}

const usersPath = path.join(__dirname, '..', 'auth', 'users.json');
fs.mkdirSync(path.dirname(usersPath), { recursive: true });
let users = {};
try {
  users = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
} catch {
  /* no file yet */
}

const isUpdate = Object.prototype.hasOwnProperty.call(users, username);
users[username] = hashPassword(password);
fs.writeFileSync(usersPath, JSON.stringify(users, null, 2));
console.log(`${isUpdate ? 'Updated' : 'Added'} user "${username}" in ${usersPath}`);
