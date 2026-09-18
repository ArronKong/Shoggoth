import type { CSSProperties } from "react";
import background01 from "../assets/avatar-backgrounds/texture-01.webp";
import background02 from "../assets/avatar-backgrounds/texture-02.webp";
import background03 from "../assets/avatar-backgrounds/texture-03.webp";
import background04 from "../assets/avatar-backgrounds/texture-04.webp";
import background05 from "../assets/avatar-backgrounds/texture-05.webp";
import background06 from "../assets/avatar-backgrounds/texture-06.webp";
import background07 from "../assets/avatar-backgrounds/texture-07.webp";
import background08 from "../assets/avatar-backgrounds/texture-08.webp";
import background09 from "../assets/avatar-backgrounds/texture-09.webp";
import background10 from "../assets/avatar-backgrounds/texture-10.webp";
import background11 from "../assets/avatar-backgrounds/texture-11.webp";
import background12 from "../assets/avatar-backgrounds/texture-12.webp";
import background13 from "../assets/avatar-backgrounds/texture-13.webp";
import background14 from "../assets/avatar-backgrounds/texture-14.webp";
import background15 from "../assets/avatar-backgrounds/texture-15.webp";
import background16 from "../assets/avatar-backgrounds/texture-16.webp";
import background17 from "../assets/avatar-backgrounds/texture-17.webp";

const BACKGROUNDS = [
  background01,
  background02,
  background03,
  background04,
  background05,
  background06,
  background07,
  background08,
  background09,
  background10,
  background11,
  background12,
  background13,
  background14,
  background15,
  background16,
  background17,
];

// A stable pseudo-random choice keeps one agent's texture identical across
// pages, renames and reloads, without storing another preference per agent.
export function agentAvatarStyle(agentId: string | null | undefined): CSSProperties {
  let hash = 2166136261;
  for (const char of agentId || "?") {
    hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619) >>> 0;
  }
  const image = BACKGROUNDS[hash % BACKGROUNDS.length];
  return { "--ui-agent-avatar-bg": `#000 url("${image}") center / cover no-repeat` } as CSSProperties;
}
