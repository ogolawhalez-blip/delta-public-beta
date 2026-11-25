import test from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import { POST, GET } from "../../app/api/webhooks/meta/route"
import { POST as whatsapp } from "../../app/api/webhooks/whatsapp/route"
import { buildRelayEvent, relayEvent } from "../../lib/integration-relay"

const origin = "https://gateway.example.invalid"
const target = "https://mail.example.invalid/api/integrations/meta"
const secret = crypto.randomBytes(32).toString("hex")
const relayKey = crypto.randomBytes(32).toString("hex")
const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "synthetic-account", text: "synthetic-private-text" }] })
const sign = (body: string) => "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex")
const req = (body = raw, signature = sign(body)) => new Request(origin + "/api/webhooks/meta", { method: "POST", headers: { "x-hub-signature-256": signature }, body })
async function setup(run: () => Promise<void>) {
  const keys = ["META_APP_SECRET", "WHALEZ_META_SUPPORT_INGEST_URL", "WHALEZ_META_SUPPORT_RELAY_TOKEN"]
  const previous = keys.map(k => process.env[k])
  const original = globalThis.fetch
  process.env[keys[0]] = secret
  process.env[keys[1]] = target
  process.env[keys[2]] = relayKey
  globalThis.fetch = async () => { throw new Error("Unexpected fetch") }
  try { await run() } finally {
    globalThis.fetch = original
    keys.forEach((k, i) => { if (previous[i] === undefined) delete process.env[k]; else process.env[k] = previous[i] })
  }
}
test("Meta rejects unsigned, oversized and unconfigured events", async () => setup(async () => {
  assert.equal((await POST(req(raw, ""))).status, 401)
  assert.equal((await POST(req("x".repeat(262145)))).status, 413)
  delete process.env.META_APP_SECRET
  assert.equal((await POST(req())).status, 503)
}))
test("Meta and WhatsApp relay only metadata and require a durable receipt", async () => setup(async () => {
  let first = ""
  let calls = 0
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), target)
    const body = JSON.parse(String(init?.body))
    assert.deepEqual(body.payload, { kind: "whatsapp_business_account" })
    assert.deepEqual(body.meta, {})
    assert.match(body.externalId, /^[a-f0-9]{64}$/)
    assert.equal(String(init?.body).includes("synthetic-private-text"), false)
    assert.equal(String(init?.body).includes("synthetic-account"), false)
    if (calls++) assert.equal(body.externalId, first); else first = body.externalId
    return Response.json({ accepted: true, stored: true, source: "meta", externalId: body.externalId, duplicate: calls > 1 })
  }
  const a = await POST(req())
  assert.equal(a.status, 200)
  assert.equal((await a.json()).stored, true)
  const b = await whatsapp(req())
  assert.equal(b.status, 200)
  assert.equal((await b.json()).duplicate, true)
}))
test("Meta refuses non-durable or mismatched downstream acknowledgements", async () => setup(async () => {
  globalThis.fetch = async () => Response.json({ accepted: true, stored: false })
  assert.equal((await POST(req())).status, 503)
  globalThis.fetch = async () => Response.json({ accepted: true, stored: true, source: "meta", externalId: "0".repeat(64) })
  assert.equal((await POST(req())).status, 503)
}))
test("Meta relay rejects non-routing content without calling the backend", async () => setup(async () => {
  let calls = 0
  globalThis.fetch = async () => { calls++; return Response.json({}) }
  const result = await relayEvent(buildRelayEvent({
    source: "meta", verified: true, event: "page", externalId: "a".repeat(64), payload: { kind: "page", text: "synthetic" },
  }))
  assert.equal(result.forwarded, false)
  assert.equal(calls, 0)
}))
test("Meta rejects invalid signed JSON and unsupported event type", async () => setup(async () => {
  assert.equal((await POST(req("null"))).status, 400)
  assert.equal((await POST(req(JSON.stringify({object: "unsupported"})))).status, 422)
}))
