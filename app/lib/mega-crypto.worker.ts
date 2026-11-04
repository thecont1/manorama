import { cbcDecryptZeroIv, ctrCrypt } from './mega-crypto'

type DecryptRequest =
  | { id: number; kind: 'ctr'; key: Uint8Array; nonce: Uint8Array; bytes: Uint8Array; offset: number }
  | { id: number; kind: 'cbc'; key: Uint8Array; bytes: Uint8Array }

self.onmessage = (event: MessageEvent<DecryptRequest>) => {
  const request = event.data
  try {
    const plain = request.kind === 'ctr'
      ? ctrCrypt(request.key, request.nonce, request.bytes, request.offset)
      : cbcDecryptZeroIv(request.key, request.bytes)
    const transferable: ArrayBuffer = plain.slice().buffer as ArrayBuffer
    (self as unknown as Worker).postMessage({ id: request.id, plain }, [transferable])
  } catch (error) {
    self.postMessage({ id: request.id, error: error instanceof Error ? error.message : 'Decrypt failed' })
  }
}
