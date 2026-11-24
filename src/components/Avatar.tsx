import Image from "next/image";
import { avatarSrc, type AvatarName } from "@/lib/avatar";

/**
 * A person's animal, in a circle. It always sits beside their name, so it carries no text of its
 * own: a screen reader hears the name once, not "fox" and then the name.
 */
export function Avatar({
  name,
  size = 28,
  ready,
  className = "",
}: {
  name: AvatarName;
  /** Width and height in CSS pixels. */
  size?: number;
  /** In a plan: ringed in green once the person is done. */
  ready?: boolean;
  className?: string;
}) {
  return (
    <Image
      src={avatarSrc(name)}
      alt=""
      aria-hidden
      width={size}
      height={size}
      // Drawn at up to twice the size on a dense screen; the files are 512px.
      sizes={`${size}px`}
      className={`avatar ${className}`}
      data-avatar={name}
      data-ready={ready || undefined}
      style={{ width: size, height: size }}
    />
  );
}
