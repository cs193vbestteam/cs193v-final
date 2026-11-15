import { describe, expect, it } from "vitest";
import {
  blindIndex,
  decrypt,
  decryptJson,
  decryptOrPlain,
  encrypt,
  encryptJson,
  legacyBlindIndex,
  legacyEncrypt,
  randomToken,
  scope,
  sha256,
} from "@/lib/crypto";

const alice = scope.email("alice-id");

describe("encrypt/decrypt", () => {
  it("round-trips text, including unicode", () => {
    const msg = "budget 40, no spicy 🌶️ café";
    expect(decrypt(encrypt(msg, alice), alice)).toBe(msg);
  });

  it("does not contain the plaintext", () => {
    const ct = encrypt("my budget is 40", alice);
    expect(ct).not.toContain("budget");
    expect(Buffer.from(ct.slice(3), "base64").toString("utf8")).not.toContain("budget");
  });

  it("uses a fresh IV every time", () => {
    expect(encrypt("same", alice)).not.toBe(encrypt("same", alice));
  });

  it("rejects tampered ciphertext", () => {
    const buf = Buffer.from(encrypt("hello", alice).slice(3), "base64");
    buf[buf.length - 1] ^= 0xff;
    expect(() => decrypt("v2." + buf.toString("base64"), alice)).toThrow();
  });

  it("rejects truncated ciphertext", () => {
    expect(() => decrypt("v2.AAAA", alice)).toThrow();
    expect(() => decrypt("AAAA", alice)).toThrow();
  });

  it("round-trips JSON", () => {
    const value = { budgetMax: 40, dietary: ["no_spicy"] };
    const s = scope.constraints("plan-1", "alice-id");
    expect(decryptJson(encryptJson(value, s), s)).toEqual(value);
  });

  it("fails loudly with a bad key", () => {
    const old = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = Buffer.from("short").toString("base64");
    try {
      expect(() => encrypt("x", alice)).toThrow(/32 bytes/);
    } finally {
      process.env.ENCRYPTION_KEY = old;
    }
  });
});

describe("per-user, per-field keys", () => {
  it("a value only opens with its own user's key", () => {
    const ct = encrypt("alice@stanford.edu", scope.email("alice-id"));
    expect(() => decrypt(ct, scope.email("bob-id"))).toThrow();
  });

  it("a value only opens as the field it was written as", () => {
    const ct = encrypt("my private chat", scope.chat("plan-1", "alice-id"));
    expect(() => decrypt(ct, scope.constraints("plan-1", "alice-id"))).toThrow();
    expect(() => decrypt(ct, scope.email("alice-id"))).toThrow();
    expect(() => decrypt(ct, scope.displayName("alice-id"))).toThrow();
  });

  it("a member's data in one plan does not open in another plan", () => {
    const ct = encrypt("budget 30", scope.constraints("plan-1", "alice-id"));
    expect(() => decrypt(ct, scope.constraints("plan-2", "alice-id"))).toThrow();
  });

  it("a plan's fields do not open as another plan's", () => {
    const ct = encrypt("Friday dinner", scope.plan("plan-1", "title"));
    expect(decrypt(ct, scope.plan("plan-1", "title"))).toBe("Friday dinner");
    expect(() => decrypt(ct, scope.plan("plan-2", "title"))).toThrow();
    expect(() => decrypt(ct, scope.plan("plan-1", "location"))).toThrow();
  });

  it("rejects scope parts that could collide", () => {
    expect(() => scope.email("a/b")).toThrow();
    expect(() => scope.email("")).toThrow();
  });
});

describe("values stored before per-scope keys", () => {
  it("still decrypt with the master key", () => {
    expect(decrypt(legacyEncrypt("old chat"), scope.chat("p", "u"))).toBe("old chat");
  });

  it("formerly plaintext columns read as they are", () => {
    expect(decryptOrPlain("Sam", scope.displayName("u"))).toBe("Sam");
    const s = scope.displayName("u");
    expect(decryptOrPlain(encrypt("Sam", s), s)).toBe("Sam");
  });
});

describe("blindIndex", () => {
  it("is deterministic and case/whitespace-insensitive", () => {
    expect(blindIndex(" Alice@Stanford.edu ", "email")).toBe(blindIndex("alice@stanford.edu", "email"));
  });
  it("differs for different inputs and hides the input", () => {
    const a = blindIndex("alice@stanford.edu", "email");
    expect(a).not.toBe(blindIndex("bob@stanford.edu", "email"));
    expect(a).not.toContain("alice");
  });
  it("uses a different key for each purpose, and not the master key", () => {
    const e = blindIndex("alice@stanford.edu", "email");
    expect(e).not.toBe(blindIndex("alice@stanford.edu", "ratelimit"));
    expect(e).not.toBe(legacyBlindIndex("alice@stanford.edu"));
  });
});

describe("tokens", () => {
  it("generates unique random tokens", () => {
    const set = new Set(Array.from({ length: 100 }, () => randomToken()));
    expect(set.size).toBe(100);
  });
  it("sha256 is stable", () => {
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
