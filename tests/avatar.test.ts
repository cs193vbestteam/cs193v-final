import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AVATARS, avatarFor, avatarSrc, groupAvatars } from "@/lib/avatar";

/**
 * Everyone, guest or account, has an animal worked out from their id. Nothing is stored, so the
 * only way it stays theirs is that the same id always gives the same one.
 */

const ids = (n: number) => Array.from({ length: n }, (_, i) => `user-${i}-${(i * 7919).toString(36)}`);

describe("a person's avatar", () => {
  it("is the same every time for the same id, and one of the set", () => {
    for (const id of ids(200)) {
      expect(avatarFor(id)).toBe(avatarFor(id));
      expect(AVATARS).toContain(avatarFor(id));
    }
  });

  it("uses the whole set, not a few of them", () => {
    expect(new Set(ids(2000).map(avatarFor)).size).toBe(AVATARS.length);
  });

  it("has a picture on disk for every name, and no name twice", () => {
    expect(new Set(AVATARS).size).toBe(AVATARS.length);
    for (const name of AVATARS) {
      expect(existsSync(join(process.cwd(), "public", avatarSrc(name))), name).toBe(true);
    }
  });
});

describe("the avatars in one plan", () => {
  it("gives no two people the same animal while there are animals left", () => {
    for (let n = 2; n <= AVATARS.length; n++) {
      const group = ids(n);
      expect(new Set(groupAvatars(group).values()).size).toBe(n);
    }
  });

  it("lets whoever joined first keep their own, and moves only the later person", () => {
    const all = ids(500);
    const first = all[0];
    const twin = all.slice(1).find((id) => avatarFor(id) === avatarFor(first))!;
    const group = groupAvatars([first, twin]);
    expect(group.get(first)).toBe(avatarFor(first));
    expect(group.get(twin)).not.toBe(avatarFor(first));
    // Someone joining afterwards changes nobody who was already there.
    const later = groupAvatars([first, twin, all[400]]);
    expect(later.get(first)).toBe(group.get(first));
    expect(later.get(twin)).toBe(group.get(twin));
  });

  it("still gives everyone one when the plan is bigger than the set", () => {
    const group = groupAvatars(ids(AVATARS.length + 6));
    expect(group.size).toBe(AVATARS.length + 6);
    for (const name of group.values()) expect(AVATARS).toContain(name);
  });
});
