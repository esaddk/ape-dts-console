'use strict';
// Live schema browsing for the Build form's Connect step. Each call opens a
// short-lived connection, runs one lookup, and closes it — no pooling, no
// caching; a click is a fresh probe.

const TIMEOUT_MS = 5000;
const SYSTEM_DBS = { mysql: new Set(['information_schema', 'mysql', 'performance_schema', 'sys']) };

async function listDatabases({ db_type, host, port, username, password }) {
  if (db_type === 'pg') {
    const { Client } = require('pg');
    const client = new Client({ host, port, user: username || undefined, password: password || undefined, database: 'postgres', connectionTimeoutMillis: TIMEOUT_MS });
    await client.connect();
    try {
      const { rows } = await client.query('SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname');
      return rows.map((r) => r.datname);
    } finally {
      await client.end();
    }
  }
  if (db_type === 'mysql') {
    const mysql = require('mysql2/promise');
    const conn = await mysql.createConnection({ host, port, user: username || undefined, password: password || undefined, connectTimeout: TIMEOUT_MS });
    try {
      const [rows] = await conn.query('SHOW DATABASES');
      return rows.map((r) => r.Database).filter((d) => !SYSTEM_DBS.mysql.has(d));
    } finally {
      await conn.end();
    }
  }
  if (db_type === 'mongo') {
    const { MongoClient } = require('mongodb');
    const client = new MongoClient(`mongodb://${host}:${port}`, {
      auth: username ? { username, password: password || '' } : undefined,
      serverSelectionTimeoutMS: TIMEOUT_MS,
    });
    await client.connect();
    try {
      const { databases } = await client.db().admin().listDatabases();
      return databases.map((d) => d.name).filter((d) => !['admin', 'local', 'config'].includes(d));
    } finally {
      await client.close();
    }
  }
  throw new Error(`listDatabases: unsupported db_type "${db_type}"`);
}

// pg only — mysql/mongo have no separate schema layer in ape-dts's filter model.
async function listSchemas({ host, port, username, password, database }) {
  const { Client } = require('pg');
  const client = new Client({ host, port, user: username || undefined, password: password || undefined, database, connectionTimeoutMillis: TIMEOUT_MS });
  await client.connect();
  try {
    const { rows } = await client.query(
      "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('pg_catalog','information_schema') AND schema_name NOT LIKE 'pg_toast%' ORDER BY schema_name"
    );
    return rows.map((r) => r.schema_name);
  } finally {
    await client.end();
  }
}

async function listTables({ db_type, host, port, username, password, database, schema }) {
  if (db_type === 'pg') {
    const { Client } = require('pg');
    const client = new Client({ host, port, user: username || undefined, password: password || undefined, database, connectionTimeoutMillis: TIMEOUT_MS });
    await client.connect();
    try {
      const { rows } = await client.query('SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name', [schema || 'public']);
      return rows.map((r) => r.table_name);
    } finally {
      await client.end();
    }
  }
  if (db_type === 'mysql') {
    const mysql = require('mysql2/promise');
    const conn = await mysql.createConnection({ host, port, user: username || undefined, password: password || undefined, connectTimeout: TIMEOUT_MS });
    try {
      const [rows] = await conn.query('SELECT table_name FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name', [database]);
      return rows.map((r) => r.table_name || r.TABLE_NAME);
    } finally {
      await conn.end();
    }
  }
  if (db_type === 'mongo') {
    const { MongoClient } = require('mongodb');
    const client = new MongoClient(`mongodb://${host}:${port}`, {
      auth: username ? { username, password: password || '' } : undefined,
      serverSelectionTimeoutMS: TIMEOUT_MS,
    });
    await client.connect();
    try {
      const cols = await client.db(database).listCollections().toArray();
      return cols.map((c) => c.name).sort();
    } finally {
      await client.close();
    }
  }
  throw new Error(`listTables: unsupported db_type "${db_type}"`);
}

module.exports = { listDatabases, listSchemas, listTables };
