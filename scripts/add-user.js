#!/usr/bin/env node
'use strict';
// Rescue tool: add/update an account straight in auth/users.json, bypassing the
// web UI's setup/admin-panel flow (e.g. to regain access if locked out). Usage:
//   node scripts/add-user.js <username> <password> [admin|user]
const { addUser, listUsers } = require('../lib/auth.js');

const [username, password, role = 'admin'] = process.argv.slice(2);
if (!username || !password) {
  console.error('Usage: node scripts/add-user.js <username> <password> [admin|user]');
  process.exit(1);
}
if (role !== 'admin' && role !== 'user') {
  console.error('Role must be "admin" or "user"');
  process.exit(1);
}

const existed = listUsers().some((u) => u.username === username);
addUser(username, password, role);
console.log(`${existed ? 'Updated' : 'Added'} user "${username}" (${role})`);
