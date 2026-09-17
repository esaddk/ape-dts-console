'use strict';
const SECTION_ORDER = ['extractor', 'filter', 'sinker', 'parallelizer', 'pipeline', 'metrics'];

function fieldsByKey(schema, section) {
  const map = {};
  for (const f of (schema.sections[section] && schema.sections[section].fields) || []) map[f.key] = f;
  return map;
}

function formatValue(field, value) {
  if (field.type === 'multiselect' && Array.isArray(value)) return value.join(',');
  if (field.type === 'checkbox') return value ? 'true' : 'false';
  return String(value);
}

// formData: { extractor: {...}, filter: {...}, sinker: {...}, parallelizer: {...}, pipeline: {...}, metrics?: {...} }
function toIni(formData, schema) {
  const lines = [];
  for (const section of SECTION_ORDER) {
    const values = formData[section];
    if (!values) continue;
    if (section === 'metrics' && !formData.metrics_enabled) continue;
    const fields = fieldsByKey(schema, section);
    const body = [];
    for (const [key, value] of Object.entries(values)) {
      if (value === '' || value === null || value === undefined) continue;
      const field = fields[key];
      if (Array.isArray(value) && value.length === 0) continue;
      body.push(`${key}=${field ? formatValue(field, value) : value}`);
    }
    if (body.length === 0) continue;
    lines.push(`[${section}]`);
    lines.push(...body);
    lines.push('');
  }
  return lines.join('\n').replace(/\n+$/, '\n');
}

function parseIni(text) {
  const result = {};
  let section = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      result[section] = result[section] || {};
      continue;
    }
    if (!section) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    result[section][key] = value;
  }
  return result;
}

// Returns array of human-readable error strings; empty array means valid.
function validate(formData, schema) {
  const errors = [];
  const extractType = formData.extractor && formData.extractor.extract_type;

  for (const section of ['extractor', 'sinker', 'parallelizer']) {
    const fields = (schema.sections[section] && schema.sections[section].fields) || [];
    const values = formData[section] || {};
    for (const field of fields) {
      const value = values[field.key];
      const missing = value === undefined || value === null || value === '';

      if (field.required && missing) {
        errors.push(`[${section}] ${field.key} is required`);
        continue;
      }
      if (field.requiredIf && missing) {
        const matches = Object.entries(field.requiredIf).every(([k, v]) => values[k] === v);
        if (matches) errors.push(`[${section}] ${field.key} is required when ${Object.entries(field.requiredIf).map(([k, v]) => `${k}=${v}`).join(' and ')}`);
      }
    }
  }

  const shapeReqs = schema.requiredByShape && schema.requiredByShape[extractType];
  if (shapeReqs) {
    for (const [section, keys] of Object.entries(shapeReqs)) {
      const values = formData[section] || {};
      for (const key of keys) {
        if (values[key] === undefined || values[key] === null || values[key] === '') {
          errors.push(`[${section}] ${key} is required for extract_type=${extractType}`);
        }
      }
    }
  }

  const enums = schema.enums || {};
  for (const section of ['extractor', 'sinker', 'parallelizer']) {
    const fields = (schema.sections[section] && schema.sections[section].fields) || [];
    const values = formData[section] || {};
    for (const field of fields) {
      if (!field.enum) continue;
      const value = values[field.key];
      if (value === undefined || value === null || value === '') continue;
      const allowed = enums[field.enum] || [];
      if (!allowed.includes(value)) {
        errors.push(`[${section}] ${field.key}="${value}" is not one of: ${allowed.join(', ')}`);
      }
    }
  }

  return errors;
}

module.exports = { toIni, parseIni, validate };
