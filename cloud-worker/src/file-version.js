// The opaque immutable body reference identifies a content version. This does
// not expose an R2 key, plaintext content, or an encryption/decryption key.
export async function fileContentVersion(file) {
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode('T-Cloud original content v1\n'+file.object_key));
  return [...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join('');
}
