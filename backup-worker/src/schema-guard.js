// Generated from checked-in migrations using Node SQLite; review alongside schema changes.
import { digest } from './integrity.js';
const EXPECTED = {
  "cloud": "c319c54132d640262b215ffdac570407df82f54e07a1f2395ea3b68291a7625c",
  "security": "a6baaaa5981cb3840795c648b61c31a85039ccf04423233cdf3ad64bb847aeec",
  "billing": "e3d7d3288312675f4635221c89d6dde4a9a5cdccd4d53848feaa308b1b7c725f",
  "payments": "a74f9ffcabf4a59f3ae58f552de94adc14738883ea1f07baf670c9c6fc3c740f",
  "health": "5d74bfd7ac54779545e86f1e0bd948b29ce3f578c68c309e445f1542d47f98ac",
  "inventory": "ed4811be91f73a7a58cdf29e0c6aade079b4f74529e9042b82399fa8aa13e6f3",
  "ai": "d7e265eac65afddd4301e02adb081123c3ab7d1d0444f427cf8cec3d57b9ca0c",
  "downloader": "b367e88bee856222f72cfdf97a35794d381a13a3a7126c07ab50a3c43e6fe6a9",
  "diary": "d79a6daee8a70c7df4ba2148f01d45b00884f800afd8b78e801fbde548ef1a4c"
};
export async function assertSchema(service, rows) {
  const schema=rows.filter(r=>r.tbl_name!=='d1_migrations').map(r=>[r.type,r.name,r.tbl_name,r.sql.replace(/\r\n?/g,'\n')]);
  if(await digest(new TextEncoder().encode(JSON.stringify(schema)))!==EXPECTED[service]) throw new Error('SchemaReviewRequired');
}
