const BOUNDARY_PREFIX_RE = /^[A-Za-z0-9]/;
const BOUNDARY_SUFFIX_RE = /[A-Za-z0-9]$/;

export const BANNED_VOCAB: readonly string[] = [
  "delve",
  "leverage",
  "harness",
  "robust",
  "comprehensive",
  "cutting-edge",
  "seamless",
  "seamlessly",
  "meticulous",
  "meticulously",
  "pivotal",
  "underscores",
  "testament to",
  "game-changer",
  "utilize",
  "landscape",
  "tapestry",
  "realm",
  "paradigm",
  "embark",
  "beacon",
  "vibrant",
  "thriving",
  "nestled",
  "showcasing",
  "deep dive",
  "dive into",
  "unpack",
  "unpacking",
  "intricate",
  "intricacies",
  "ever-evolving",
  "daunting",
  "holistic",
  "actionable",
  "impactful",
  "learnings",
  "thought leader",
  "best practices",
  "at its core",
  "synergy",
  "interplay",
  "in order to",
  "due to the fact that",
  "serves as",
  "boasts",
  "presents",
  "commence",
  "ascertain",
  "endeavor",
  "symphony",
  "embrace",
  "foster",
  "elevate",
  "unleash",
  "streamline",
  "empower",
  "bolster",
  "navigate",
  "resonate",
  "revolutionize",
  "facilitate",
  "underpin",
  "nuanced",
  "crucial",
  "multifaceted",
  "ecosystem",
  "myriad",
  "plethora",
  "catalyze",
  "reimagine",
  "galvanize",
  "cultivate",
  "illuminate",
  "elucidate",
  "cornerstone",
  "paramount",
  "poised to",
  "burgeoning",
  "nascent",
  "quintessential",
  "overarching",
  "phenomenal",
  "phenomenality",
  "qualia",
  "constitutively",
  "constitutive",
  "ontological",
  "ontology",
  "ontologically",
  "asymmetry",
  "asymmetric",
  "presupposes",
  "presupposition",
  "supervenes",
  "supervenience",
  "instantiation",
  "instantiate",
  "reify",
  "reification",
  "explanandum",
  "explanans",
  "modulable",
  "epistemic",
  "metaphysical",
  "substrate",
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\ /g, "\\s+");
}

function boundedTerm(value: string): string {
  const escaped = escapeRegExp(value);
  const prefix = BOUNDARY_PREFIX_RE.test(value) ? "\\b" : "";
  const suffix = BOUNDARY_SUFFIX_RE.test(value) ? "\\b" : "";
  return `${prefix}${escaped}${suffix}`;
}

export const BANNED_VOCAB_RE: RegExp = new RegExp(
  BANNED_VOCAB.map(boundedTerm).join("|"),
  "giu",
);

export function firstBannedHit(text: string): string | null {
  BANNED_VOCAB_RE.lastIndex = 0;
  const hit = BANNED_VOCAB_RE.exec(text);
  BANNED_VOCAB_RE.lastIndex = 0;
  return hit?.[0].toLowerCase() ?? null;
}
