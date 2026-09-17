'use strict';
// Pre-creates a PG logical replication slot (+ its publication) before a migrate
// task's snapshot phase starts, so the slot's LSN becomes the CDC phase's start_lsn
// and no writes between "snapshot finished" and "CDC slot created" are lost. Same pg
// Client pattern as lib/introspect.js — short-lived connection, one job, close it.
//
// The publication is created HERE, not left to the CDC container's own auto-create
// (schema.json:25's default behavior), because of an engine race: when a CDC task
// starts against a slot that already exists (our recreate_slot_if_exists=false path),
// its replication-protocol connection opens first and then runs CREATE PUBLICATION
// over that same connection — but a replication-mode connection doesn't see catalog
// changes committed after it connected, so the immediately-following START_REPLICATION
// fails with "publication ... does not exist" (panics dt-connector's pg_cdc_extractor.rs
// around the START_REPLICATION call). Creating the publication on a plain connection
// well before the CDC container even starts avoids the race entirely.

const TIMEOUT_MS = 5000;

function publicationName(slotName) {
  return `${slotName}_publication_for_all_tables`;
}

async function createSlot({ host, port, username, password, database, slotName }) {
  const { Client } = require('pg');
  const client = new Client({ host, port, user: username || undefined, password: password || undefined, database, connectionTimeoutMillis: TIMEOUT_MS });
  await client.connect();
  try {
    const existing = await client.query('SELECT slot_name FROM pg_catalog.pg_replication_slots WHERE slot_name = $1', [slotName]);
    if (existing.rows.length > 0) {
      throw new Error(
        `Replication slot "${slotName}" already exists — its LSN is unknown, so it can't be reused safely. ` +
        `Drop it manually first: SELECT pg_drop_replication_slot('${slotName}');`
      );
    }
    const pubName = publicationName(slotName);
    const pubExists = await client.query('SELECT 1 FROM pg_catalog.pg_publication WHERE pubname = $1', [pubName]);
    if (pubExists.rows.length === 0) {
      await client.query(`CREATE PUBLICATION ${pubName} FOR ALL TABLES`);
    }
    const { rows } = await client.query("SELECT * FROM pg_create_logical_replication_slot($1, 'pgoutput')", [slotName]);
    return { slotName: rows[0].slot_name, lsn: rows[0].lsn, pubName };
  } finally {
    await client.end();
  }
}

module.exports = { createSlot, publicationName };
