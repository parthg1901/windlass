const GATEWAY = process.env.SMS_GATEWAY_URL ?? "http://localhost:9090"

/** Builds the gateway request for an urgent alert; sending it is the caller's job. */
export function smsRequest(phone: string, text: string) {
  if (!/^\+\d{8,15}$/.test(phone)) throw new Error(`not a phone number: ${phone}`)
  return { url: `${GATEWAY}/send`, body: { to: phone, text: text.slice(0, 160) } }
}
