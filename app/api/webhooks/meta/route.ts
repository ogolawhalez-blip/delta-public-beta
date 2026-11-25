import crypto from "node:crypto"
import { buildRelayEvent, relayEvent, verifyMetaWebhook } from "@/lib/integration-relay"

export const runtime = "nodejs"

const MAX_BODY_BYTES = 256 * 1024
const kinds = new Set(["whatsapp_business_account", "page", "instagram", "webhook"])

export function GET(request: Request) {
  const url = new URL(request.url)
  const mode = url.searchParams.get("hub.mode")
  const token = url.searchParams.get("hub.verify_token")
  const challenge = url.searchParams.get("hub.challenge")
  const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN?.trim() || ""
  if (mode === "subscribe" && challenge && verifyToken && token === verifyToken) {
    return new Response(challenge, {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    })
  }
  return Response.json({ verified: false, error: "verification_failed" }, { status: 403 })
}

export async function POST(request: Request) {
  const appSecret = process.env.META_APP_SECRET?.trim() || ""
  if (!appSecret) {
    return Response.json({ accepted: false, error: "provider_verification_unavailable" }, { status: 503 })
  }
  const declared = request.headers.get("content-length")
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    return Response.json({ accepted: false, error: "payload_too_large" }, { status: 413 })
  }
  const reader = request.body?.getReader()
  if (!reader) return Response.json({ accepted: false, error: "invalid_json" }, { status: 400 })
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > MAX_BODY_BYTES) {
        await reader.cancel()
        return Response.json({ accepted: false, error: "payload_too_large" }, { status: 413 })
      }
      chunks.push(part.value)
    }
  } catch {
    return Response.json({ accepted: false, error: "invalid_body" }, { status: 400 })
  }
  const raw = Buffer.concat(chunks)
  let rawBody: string
  try {
    rawBody = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw)
  } catch {
    return Response.json({ accepted: false, error: "invalid_body" }, { status: 400 })
  }
  const verification = verifyMetaWebhook(rawBody, request.headers.get("x-hub-signature-256"), appSecret)
  if (!verification.verified) {
    return Response.json({ accepted: false, error: verification.reason }, { status: 401 })
  }
  let payload: Record<string, unknown>
  try {
    const value: unknown = JSON.parse(rawBody)
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_json")
    payload = value as Record<string, unknown>
  } catch {
    return Response.json({ accepted: false, error: "invalid_json" }, { status: 400 })
  }
  const kind = typeof payload.object === "string" ? payload.object : "webhook"
  if (!kinds.has(kind)) return Response.json({ accepted: false, error: "unsupported_event" }, { status: 422 })
  // A keyed digest of the exact delivery bytes is stable for identical retries
  // without exposing provider identifiers or message text in the support journal.
  const externalId = crypto.createHmac("sha256", appSecret).update("support-meta:v1\0").update(raw).digest("hex")
  const relay = await relayEvent(buildRelayEvent({
    source: "meta", event: kind, externalId, verified: true, payload: { kind }, meta: {},
  }))
  if (!relay.forwarded) {
    return Response.json({ accepted: false, error: "support_not_durably_stored" }, { status: 503 })
  }
  return Response.json({ accepted: true, stored: true, duplicate: "duplicate" in relay && relay.duplicate === true, source: "meta" })
}
