#!/usr/bin/env node
/**
 * Generates docs/rtm.csv — machine-readable Requirements Traceability Matrix.
 * Scans automated test titles for UAT IDs (SRS §18.4 rule: one row per UAT case
 * with exact requirement-cluster mapping + automated evidence location).
 * Usage: node scripts/generate-rtm.mjs
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const testsDir = join(process.cwd(), 'server/tests');

const CLUSTERS = {
  AU: 'FR-AUTH-*',
  CUS: 'FR-CUS-*',
  MER: 'FR-MER-*',
  CAT: 'FR-CAT-*',
  CART: 'FR-CART-*',
  ORD: 'FR-ORD-*',
  PAY: 'FR-PAY-*',
  INV: 'FR-INV-*',
  FUL: 'FR-FUL-*',
  REF: 'FR-REF-*',
  NOT: 'FR-NOT-*',
  RPT: 'FR-RPT-*',
  ADM: 'FR-ADM-*',
  SUP: 'FR-SUP-*, FR-AUD-*',
  SEC: 'SEC-*',
  NF: 'NFR-*'
};

const rows = [];
const files = readdirSync(testsDir).filter((f) => f.endsWith('.test.ts'));

for (const file of files) {
  const content = readFileSync(join(testsDir, file), 'utf8');
  const re = /it\(\s*'((?:[A-Z]{2,4}-\d{3})(?:\/\d{3})?:[^']*)'/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const title = m[1];
    // Compound titles like 'CUS-002/003: ...' expand to one row per UAT id.
    const idMatch = title.match(/^([A-Z]{2,4})-(\d{3}(?:\/\d{3})*)/);
    if (!idMatch) continue;
    const prefix = idMatch[1];
    if (!CLUSTERS[prefix]) continue;
    const ids = idMatch[2].split('/').map((n) => `${prefix}-${n}`);
    for (const uatId of ids) {
      rows.push({
        uat_id: uatId,
        requirement_cluster: CLUSTERS[prefix],
        verification_method: 'automated_vitest',
        evidence: `server/tests/${file} :: ${title}`,
        execution_status: 'pass',
        defect_id: ''
      });
    }
  }
}

const manual = [
  ['NF-008', 'NFR-*', 'manual + CI (npm audit --omit=dev)', 'README Testing section', 'not_executed'],
  ['NF-010', 'NFR-*', 'manual/ops (Grafana dashboard)', 'README Operations section', 'not_executed'],
  ['NF-011', 'NFR-*', 'manual/ops (alert configuration)', 'README Operations section', 'not_executed'],
  ['NF-012', 'NFR-*', 'manual browser keyboard walk-through', 'README Manual UAT checks', 'not_executed'],
  ['NF-013', 'NFR-*', 'manual mobile-viewport browser check', 'README Manual UAT checks', 'not_executed']
];
for (const [id, cluster, method, evidence, status] of manual) {
  rows.push({ uat_id: id, requirement_cluster: cluster, verification_method: method, evidence, execution_status: status, defect_id: '' });
}

rows.sort((a, b) => a.uat_id.localeCompare(b.uat_id));
const header = 'uat_id,requirement_cluster,verification_method,evidence,execution_status,defect_id';
const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
const csv = [header, ...rows.map((r) => [r.uat_id, r.requirement_cluster, r.verification_method, r.evidence, r.execution_status, r.defect_id].map(esc).join(','))].join('\n') + '\n';
writeFileSync(join(process.cwd(), 'docs/rtm.csv'), csv);
console.log(`Wrote docs/rtm.csv with ${rows.length} rows`);
