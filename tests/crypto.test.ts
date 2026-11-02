import { describe, expect, it } from "vitest";
import { blindIndex, decrypt, decryptJson, encrypt, encryptJson, randomToken, sha256 } from "@/lib/crypto";

describe("encrypt/decrypt", () => {
  it("round-trips text, including unicode", () => {
    const msg = "budget 40, no spicy 🌶️ café";
    expect(decrypt(encrypt(msg))).toBe(msg);
  });

  it("does not contain the plaintext", () => {
    const ct = encrypt("my budget is 40");
    expect(ct).not.toContain("budget");
    expect(Buffer.from(ct, "base64").toString("utf8")).not.toContain("budget");
  });

  it("uses a fresh IV every time", () => {
    expect(encrypt("same")).not.toBe(encrypt("same"));
  });

  it("rejects tampered ciphertext", () => {
    const buf = Buffer.from(encrypt("hello"), "base64");
    buf[buf.length - 1] ^= 0xff;
    expect(() => decrypt(buf.toString("base64"))).toThrow();
  });

  it("rejects truncated ciphertext", () => {
    expect(() => decrypt("AAAA")).toThrow();
  });

  it("round-trips JSON", () => {
    const value = { budgetMax: 40, dietary: ["no_spicy"] };
    expect(decryptJson(encryptJson(value))).toEqual(value);
  });

  it("fails loudly with a bad key", () => {
    const old = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = Buffer.from("short").toString("base64");
    try {
      expect(() => encrypt("x")).toThrow(/32 bytes/);
    } finally {
      process.env.ENCRYPTION_KEY = old;
    }
  });
});

describe("blindIndex", () => {
  it("is deterministic and case/whitespace-insensitive", () => {
    expect(blindIndex(" Alice@Stanford.edu ")).toBe(blindIndex("alice@stanford.edu"));
  });
  it("differs for different inputs and hides the input", () => {
    const a = blindIndex("alice@stanford.edu");
    expect(a).not.toBe(blindIndex("bob@stanford.edu"));
    expect(a).not.toContain("alice");
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
