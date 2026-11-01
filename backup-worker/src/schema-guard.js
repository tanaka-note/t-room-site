// Generated from checked-in migrations using Node SQLite; review alongside schema changes.
import { digest } from './integrity.js';
const EXPECTED = {
  "household": "87c3caeb5b1bd4363759e93de4fe377f03064dc96e226fc531546a16146a2ede",
  "cloud": "c319c54132d640262b215ffdac570407df82f54e07a1f2395ea3b68291a7625c",
  "security": "31794c37dea9a1bdcb6139ba19f7845253671fcfd3def4e72813cd939d5e6ce4",
  "billing": "e3d7d3288312675f4635221c89d6dde4a9a5cdccd4d53848feaa308b1b7c725f",
  "payments": "a74f9ffcabf4a59f3ae58f552de94adc14738883ea1f07baf670c9c6fc3c740f",
  "health": "5d74bfd7ac54779545e86f1e0bd948b29ce3f578c68c309e445f1542d47f98ac",
  "inventory": "ed4811be91f73a7a58cdf29e0c6aade079b4f74529e9042b82399fa8aa13e6f3",
  "ai": "d7e265eac65afddd4301e02adb081123c3ab7d1d0444f427cf8cec3d57b9ca0c",
  "downloader": "b367e88bee856222f72cfdf97a35794d381a13a3a7126c07ab50a3c43e6fe6a9",
  "calendar": "cdae4a460294b4cefb9b9392b5ea2214fc335124315ad420ccf9644b88611d4c",
  "diary": "6b8f6ae0973caf134513739e7f30efdf7a2dd5f0886a1ec4f85cb725f34cfb70"
};
// Exact DDL metadata reviewed read-only on 2026-10-26. No database/auth
// settings are changed: Billing already uses DEFAULT 210000; the other
// differences are SQL formatting. Pin variants to their migration baseline,
// so a future migration requires a fresh review rather than a broad bypass.
const REVIEWED = {
  billing: ['e3d7d3288312675f4635221c89d6dde4a9a5cdccd4d53848feaa308b1b7c725f', '0caa9787a64446caa2e5062638713c9d9978f884d2e0215dc9c7802a152af42e'],
  inventory: ['ed4811be91f73a7a58cdf29e0c6aade079b4f74529e9042b82399fa8aa13e6f3', 'd583deb887f1a14e802b50a550dca0e54e41dfeb5fadeca9a2cc6c9f3bbe10bd'],
  // Reviewed Diary DDL plus additive migration 0022 (not a new production audit).
  diary: ['6b8f6ae0973caf134513739e7f30efdf7a2dd5f0886a1ec4f85cb725f34cfb70', 'ac391629ad0de78bd2ac2390429c5021722528ae129a27f1043dfef5b2de014e']
};
export function reviewedSchemaMatches(service, baseline, actual) {
  return typeof baseline === 'string' && (actual === baseline ||
    (REVIEWED[service]?.[0] === baseline && REVIEWED[service][1] === actual));
}
export async function assertSchema(service, rows) {
  const schema=rows.filter(r=>r.tbl_name!=='d1_migrations').map(r=>[r.type,r.name,r.tbl_name,r.sql.replace(/\r\n?/g,'\n')]);
  if(!reviewedSchemaMatches(service, EXPECTED[service], await digest(new TextEncoder().encode(JSON.stringify(schema))))) throw new Error('SchemaReviewRequired');
}
