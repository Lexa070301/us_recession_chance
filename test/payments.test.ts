import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, getDb, setDb } from "../src/data/db.js";
import {
  activateSubscription,
  applyRefund,
  getSubscription,
  listRefundablePayments,
  recordPayment,
} from "../src/data/repositories/subscriptions.js";
import { getUser, upsertUser } from "../src/data/repositories/users.js";
import { findTier, parseInvoicePayload } from "../src/bot/payments.js";

const pay = (userId: number, chargeId: string) => {
  recordPayment(chargeId, userId, 150, 30);
  activateSubscription(userId, 30, chargeId);
};

const daysAhead = (iso: string) =>
  (new Date(iso.replace(" ", "T") + "Z").getTime() - Date.now()) / 86_400_000;

describe("refunds", () => {
  beforeEach(() => {
    setDb(createTestDb());
  });

  it("lists only non-refunded payments inside the window", () => {
    upsertUser(1, null, "en");
    pay(1, "fresh");
    getDb()
      .prepare(
        `INSERT INTO payments (charge_id, user_id, stars_amount, period_days, paid_at)
         VALUES ('stale', 1, 150, 30, datetime('now', '-30 days'))`,
      )
      .run();

    const list = listRefundablePayments(1, 7);
    expect(list.map((p) => p.charge_id)).toEqual(["fresh"]);
    expect(listRefundablePayments(1, 31)).toHaveLength(2);
  });

  it("refund shortens an active subscription by the payment period", () => {
    upsertUser(1, null, "en");
    pay(1, "c1");
    pay(1, "c2"); // two periods → ~60 days
    const res = applyRefund("c1");
    expect(res).not.toBe("unknown");
    expect(res).not.toBe("already_refunded");
    const { expiresAt } = res as { expiresAt: string };
    expect(daysAhead(expiresAt)).toBeGreaterThan(28);
    expect(daysAhead(expiresAt)).toBeLessThan(32);
    expect(getUser(1)?.plan).toBe("plus");
  });

  it("refund cancels the plan when no paid time remains", () => {
    upsertUser(1, null, "en");
    pay(1, "c1");
    const res = applyRefund("c1") as { expiresAt: string | null };
    expect(res.expiresAt).toBeNull();
    expect(getUser(1)?.plan).toBe("free");
    expect(getSubscription(1)?.status).toBe("canceled");
  });

  it("is idempotent and rejects unknown charges", () => {
    upsertUser(1, null, "en");
    pay(1, "c1");
    applyRefund("c1");
    expect(applyRefund("c1")).toBe("already_refunded");
    expect(applyRefund("nope")).toBe("unknown");
    expect(listRefundablePayments(1, 7)).toHaveLength(0);
  });
});

describe("invoice payload & tiers", () => {
  it("parses plus:<days>:<uid>:<ts>", () => {
    expect(parseInvoicePayload("plus:90:12345:1699999999999")).toEqual({
      days: 90,
      userId: 12345,
    });
    expect(parseInvoicePayload("plus_12345_1699999999999")).toBeNull(); // legacy fmt
    expect(parseInvoicePayload("plus:abc:1:2")).toBeNull();
    expect(parseInvoicePayload("garbage")).toBeNull();
  });

  it("resolves configured tiers only", () => {
    expect(findTier(30)?.stars).toBe(250);
    expect(findTier(90)?.stars).toBe(500);
    expect(findTier(365)?.stars).toBe(1000);
    expect(findTier(31)).toBeUndefined(); // unlisted period → reject
  });
});
