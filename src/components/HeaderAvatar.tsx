"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { AvatarName } from "@/lib/avatar";
import { Avatar } from "./Avatar";

/**
 * The header shows a person's own animal. Inside a plan two people can land on the same one, and
 * the later one is given the next free animal there (`groupAvatars`). A person then saw one animal
 * beside "Account" and another beside their name in the group. So while a plan is open, the plan
 * says which animal the header shows.
 */
let inPlan: AvatarName | null = null;
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
const set = (name: AvatarName | null) => {
  inPlan = name;
  listeners.forEach((fn) => fn());
};

export function HeaderAvatar({ name }: { name: AvatarName }) {
  const shown = useSyncExternalStore(
    subscribe,
    () => inPlan,
    () => null,
  );
  return <Avatar name={shown ?? name} size={24} />;
}

/** Rendered by the plan page with the viewer's animal in that plan; puts the header back on leaving. */
export function PlanAvatar({ name }: { name: AvatarName }) {
  useEffect(() => {
    set(name);
    return () => set(null);
  }, [name]);
  return null;
}
