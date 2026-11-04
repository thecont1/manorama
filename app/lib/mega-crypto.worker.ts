import { cbcDecryptZeroIv, ctrCrypt, metaMac } from './mega-crypto'

type DecryptRequest =
  | { id: number; kind: 'ctr'; key: Uint8Array; nonce: Uint8Array; bytes: Uint8Array; offset: number }
  | { id: number; kind: 'ctrmac'; key: Uint8Array; nonce: Uint8Array; bytes: Uint8Array }
  | { id: number; kind: 'cbc'; key: Uint8Array; bytes: Uint8Array }

self.onmessage = (event: MessageEvent<DecryptRequest>) => {
  const request = event.data
  try {
    if (request.kind === 'ctrmac') {
      // Integrity must be checked on the same pass as decryption —
      // splitting them would drag the AES loop back onto the main thread.
      const plain = ctrCrypt(request.key, request.nonce, request.bytes, 0)
      const mac = metaMac(request.key, request.nonce, plain)
      const transferable: ArrayBuffer[] = [plain.slice().buffer as ArrayBuffer, mac.slice().buffer as ArrayBuffer]
      ;(self as unknown as Worker).postMessage({ id: request.id, plain, mac }, transferable)
      return
    }
    const plain = request.kind === 'ctr'
      ? ctrCrypt(request.key, request.nonce, request.bytes, request.offset)
      : cbcDecryptZeroIv(request.key, request.bytes)
    const transferable: ArrayBuffer = plain.slice().buffer as ArrayBuffer
    ;(self as unknown as Worker).postMessage({ id: request.id, plain }, [transferable])
  } catch (error) {
    self.postMessage({ id: request.id, error: error instanceof Error ? error.message : 'Decrypt failed' })
  }
}
