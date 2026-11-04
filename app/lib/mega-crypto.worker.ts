import { cbcDecryptZeroIv, ctrCrypt, metaMac } from './mega-crypto'

type DecryptRequest =
  | { id: number; kind: 'ctr'; key: Uint8Array; nonce: Uint8Array; bytes: Uint8Array; offset: number }
  | { id: number; kind: 'ctrmac'; key: Uint8Array; nonce: Uint8Array; bytes: Uint8Array }
  | { id: number; kind: 'cbc'; key: Uint8Array; bytes: Uint8Array }

/** Post the real buffers, not copies: anything else pays a slice copy on
 *  top of the structured-clone copy for every whole-file decrypt. A view
 *  onto a larger buffer cannot be transferred alone, so it is cloned. */
const transferables = (...arrays: Uint8Array[]): ArrayBuffer[] =>
  arrays.flatMap((a) => (a.byteOffset === 0 && a.byteLength === a.buffer.byteLength ? [a.buffer as ArrayBuffer] : []))

self.onmessage = (event: MessageEvent<DecryptRequest>) => {
  const request = event.data
  try {
    if (request.kind === 'ctrmac') {
      // Integrity must be checked on the same pass as decryption —
      // splitting them would drag the AES loop back onto the main thread.
      const plain = ctrCrypt(request.key, request.nonce, request.bytes, 0)
      const mac = metaMac(request.key, request.nonce, plain)
      ;(self as unknown as Worker).postMessage({ id: request.id, plain, mac }, transferables(plain, mac))
      return
    }
    const plain = request.kind === 'ctr'
      ? ctrCrypt(request.key, request.nonce, request.bytes, request.offset)
      : cbcDecryptZeroIv(request.key, request.bytes)
    ;(self as unknown as Worker).postMessage({ id: request.id, plain }, transferables(plain))
  } catch (error) {
    self.postMessage({ id: request.id, error: error instanceof Error ? error.message : 'Decrypt failed' })
  }
}
