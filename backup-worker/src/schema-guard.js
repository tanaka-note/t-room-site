// Generated from checked-in migrations using Node SQLite; review alongside schema changes.
import { digest } from './integrity.js';
const EXPECTED = {
  "cloud": "4161f3c49308c352bf4e6fcfb753d026ad56dea797bc5b03d8fc72d163082ce8",
  "security": "280383d59ff66b5a65d413e50628be2738107d69c56baff8a2a489f7be588a0c",
  "billing": "3761a6ba771fe46bf365ecc12cab129f0ec9dce898d7c1e3f6392f98c27a93c2",
  "payments": "c009c7c4d52d7efb93062e05aec314478f59787a9c3a2c53051cda3220f5608d",
  "health": "5309173146ab9ce33e7e65c074c9fdf30cfc8474d8668f30432641aaaf763a58",
  "inventory": "ed4811be91f73a7a58cdf29e0c6aade079b4f74529e9042b82399fa8aa13e6f3",
  "ai": "6ab904f64896f5bdc27c1319059ce96f2d1dcab4115c0ea8dbf7a6e0e1ff5f71",
  "downloader": "8391bafe4d2f422c0964488622b8ae93f205df4b030dd78b78c5ebbfe31d0d72",
  "diary": "1396152a54085ef22e7e1e5b5e8c3d590056cd14dc2c14822fbc6411702a1852"
};
export async function assertSchema(service, rows) {
  const schema=rows.filter(r=>r.tbl_name!=='d1_migrations').map(r=>[r.type,r.name,r.tbl_name,r.sql]);
  if(await digest(new TextEncoder().encode(JSON.stringify(schema)))!==EXPECTED[service]) throw new Error('SchemaReviewRequired');
}
