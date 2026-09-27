/**
 * Stripe Payment Links accept only letters, digits, dashes and underscores
 * in `client_reference_id` — anything else is silently dropped, which would
 * leave the webhook with no account to promote. Hex keeps the Dropbox id
 * (`dbid:…`, colon and all) reversible inside that charset and comfortably
 * under Stripe's 200-character cap.
 */
export const encodeStripeAccountRef = (accountId: string): string =>
  Array.from(new TextEncoder().encode(accountId), (byte) => byte.toString(16).padStart(2, '0')).join('')

/** Returns null for anything that is not hex — callers fall back to the
 *  raw value, so a reference that arrived unencoded still resolves. */
export const decodeStripeAccountRef = (ref: string): string | null => {
  if (!ref.length || ref.length % 2 || !/^[0-9a-fA-F]+$/.test(ref)) return null
  const bytes = new Uint8Array(ref.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = parseInt(ref.slice(index * 2, index * 2 + 2), 16)
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}
