/**
 * Everyone gets a small animal beside their name: a guest as much as someone with an account.
 *
 * It is worked out from the user's id, so nothing is stored and nobody picks one. The pictures are
 * a fixed set in `public/avatars`, drawn with the ip-as-logo skill (see the README beside them).
 * The id is random and says nothing about the person, and neither does the animal.
 */

export const AVATARS = [
  "fox",
  "cat",
  "bear",
  "rabbit",
  "owl",
  "penguin",
  "frog",
  "panda",
  "duckling",
  "whale",
  "deer",
  "pig",
  "sheep",
  "squirrel",
  "turtle",
  "lion",
  "tiger",
  "elephant",
  "mouse",
  "raccoon",
  "chick",
  "bee",
  "octopus",
  "sloth",
] as const;

export type AvatarName = (typeof AVATARS)[number];

/** FNV-1a: the same id always lands on the same animal, and ids spread evenly over the set. */
function slot(userId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < userId.length; i++) {
    h ^= userId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % AVATARS.length;
}

/** A person's own animal: what the header and the account page show. */
export function avatarFor(userId: string): AvatarName {
  return AVATARS[slot(userId)];
}

export const avatarSrc = (name: AvatarName) => `/avatars/${name}.webp`;

/**
 * The animals for one plan's members, given in the order they joined.
 *
 * Two people in a plan can land on the same animal, and two foxes side by side read as a mistake.
 * So whoever joined first keeps theirs and a later person with the same one takes the next free
 * animal. Past the size of the set there is nothing free and repeats are allowed.
 */
export function groupAvatars(userIds: string[]): Map<string, AvatarName> {
  const taken = new Set<number>();
  const out = new Map<string, AvatarName>();
  for (const id of userIds) {
    let at = slot(id);
    if (taken.size < AVATARS.length) while (taken.has(at)) at = (at + 1) % AVATARS.length;
    taken.add(at);
    out.set(id, AVATARS[at]);
  }
  return out;
}
