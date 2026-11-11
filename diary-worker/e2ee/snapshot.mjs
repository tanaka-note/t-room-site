import { encode } from "./crypto.mjs";
import { validateSnapshot } from "./record.mjs";

// Each server page is a consistent D1 read. A concurrent write invalidates the
// cursor and restarts a bounded number of times; no mixed-version index opens.
export async function readSnapshotPages(fetchPage,household,since=-1,{fetchHead}={}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let after = null,
      at = null,
      bytes = 0;
    const records = [],
      removed = [];
    try {
      if(since<0&&fetchHead) {
        const head=await fetchHead(household);
        if(head.version!==1||head.household!==household||!Number.isSafeInteger(head.sequence)||head.sequence<0||!Number.isSafeInteger(head.total)||head.total<0||head.total>5000||!Array.isArray(head.pages)||head.pages.length>5000||head.pages.reduce((n,p)=>n+p.limit,0)!==head.total)throw new Error('InvalidSnapshotHead');
        const pages=new Array(head.pages.length);let index=0,failed=false;
        const jobs=await Promise.allSettled(Array.from({length:Math.min(4,head.pages.length)},async()=>{try{while(!failed&&index<head.pages.length){const position=index++,options=head.pages[position];if(!Number.isInteger(options.limit)||options.limit<1||options.limit>50||options.after!==null&&(typeof options.after!=='string'||!/^[\w:-]{1,160}$/.test(options.after)))throw new Error('InvalidSnapshotHead');const {nextCursor,...page}=await fetchPage({household,since,after:options.after,at:head.sequence,limit:options.limit});validateSnapshot(page);if(page.sequence!==head.sequence||page.household!==household||page.delta||page.records.length!==options.limit)throw new Error('SnapshotChanged');pages[position]=page.records;}}catch(error){failed=true;throw error;}}));const rejected=jobs.find(job=>job.status==='rejected');if(rejected)throw rejected.reason;
        const records=pages.flat();const result={version:1,household,sequence:head.sequence,unchanged:false,baseSequence:-1,delta:false,records,removed:[]};if(encode(result).length>50_000_000)throw new Error('SnapshotLimit');return validateSnapshot(result);
      }
      do {
        const page = await fetchPage({
          household,
          since,
          after,
          at,
          limit: 50,
        });
        const { nextCursor, ...snapshot } = page;
        validateSnapshot(snapshot);
        if (
          snapshot.household !== household ||
          snapshot.baseSequence !== since ||
          (at !== null && snapshot.sequence !== at) ||
          (nextCursor !== null &&
            (typeof nextCursor !== "string" ||
              nextCursor <= String(after || "")))
        )
          throw new Error("InvalidSnapshotPage");
        bytes += encode(page).length;
        if (
          bytes > 50_000_000 ||
          records.length +
            snapshot.records.length +
            removed.length +
            snapshot.removed.length >
            5000
        )
          throw new Error("SnapshotLimit");
        records.push(...snapshot.records);
        removed.push(...snapshot.removed);
        after = nextCursor;
        at = snapshot.sequence;
        if (snapshot.unchanged && after !== null)
          throw new Error("InvalidSnapshotPage");
        if (after === null)
          return validateSnapshot({ ...snapshot, records, removed });
      } while (after !== null);
    } catch (error) {
      if (error.message !== "SnapshotChanged" || attempt === 2) throw error;
    }
  }
  throw new Error("SnapshotChanged");
}
