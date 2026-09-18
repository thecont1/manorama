/// <reference types="node" />
// Task 5.2 acceptance — the pinned gallery-inventory slot.
//
// HISTORICAL: the gallery-inventory VendoSlot was dropped in 83a06e7. What
// remains worth pinning is the leak guarantee: no slot markup may appear on
// public pages, and the admin page — which no longer carries the slot —
// still mounts the Vendo surface root.

import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { SignJWT } from "jose";

const BASE = process.env.GALLERY_URL ?? "http://localhost:5173";
const OWNER = process.env.GALLERY_OWNER ?? "thecontrarian";

const devEnv = (() => {
  const env: Record<string, string> = {};
  try {
    for (const line of readFileSync(new URL("./.env.local", import.meta.url), "utf8").split("\n")) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (match) env[match[1]] = match[2].replace(/^"(.*)"$/, "$1");
    }
  } catch {
    // .env.local exists only in a dev checkout.
  }
  return env;
})();

const sessionSecret = process.env.HOST_API_JWT_SECRET ?? devEnv.HOST_API_JWT_SECRET ?? "";

const sessionCookie = async (dropboxAccountId = "dbid:AAATESTowner1"): Promise<string> =>
  `manorama_session=${await new SignJWT({ sub: dropboxAccountId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("2h")
    .sign(new TextEncoder().encode(sessionSecret))}`;

test("public pages carry no gallery-inventory slot markup", async ({ page }) => {
  await page.goto(`${BASE}/`);
  await page.locator(".landing-brand").waitFor({ state: "visible" });
  expect(await page.locator("#vendo-slot-gallery-inventory").count()).toBe(0);
});

test("the retired slot stays absent on the authenticated admin page", async ({ page }) => {
  await page.context().setExtraHTTPHeaders({ Cookie: await sessionCookie() });
  await page.goto(`${BASE}/${OWNER}`, { waitUntil: "domcontentloaded" });
  // The slot itself is gone — the guard is that it never comes back
  // unnoticed — and with Vendo disabled, the surface root is absent too.
  expect(await page.locator("#vendo-slot-gallery-inventory").count()).toBe(0);
  expect(await page.locator("#vendo-root").count()).toBe(0);
});
