export const MAX_DOCUMENT_BYTES=2_000_000;
async function transform(bytes,stream) {
  const reader=new Blob([bytes]).stream().pipeThrough(stream).getReader();
  const chunks=[];let length=0;
  try {
    for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>MAX_DOCUMENT_BYTES)throw new Error('DocumentTooLarge');chunks.push(value);}
    const result=new Uint8Array(length);let offset=0;
    for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.length;}
    return result;
  } finally {await reader.cancel().catch(()=>{});for(const chunk of chunks)chunk.fill(0);}
}
export async function compressDocument(bytes) {
  if(bytes.length>MAX_DOCUMENT_BYTES)throw new Error('DocumentTooLarge');
  if(typeof CompressionStream!=='function')throw new Error('CompressionUnsupported');
  return transform(bytes,new CompressionStream('gzip'));
}
export async function decompressDocument(bytes) {
  if(typeof DecompressionStream!=='function')throw new Error('CompressionUnsupported');
  return transform(bytes,new DecompressionStream('gzip'));
}
