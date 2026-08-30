"""
Merge Goggle instructions into my_rerank.goggle from three possible sources:

  1. pending_instructions.txt  -- raw instruction lines exported from the
     userscript (contains full action, strength, level, and path data)
  2. goggles_boost.txt   -- legacy cookie export (domain-only, strength 1)
  3. goggles_discard.txt -- legacy cookie export (domain-only)

The goggle file organizes instructions into five sections:
  1. Metadata header
  2. Raised instructions   (boost / boost=N)
  3. Downranked instructions (downrank / downrank=N)
  4. TLD-level instructions  (|https://*.tld^ patterns)
  5. Discarded instructions  (discard)
  6. Path-specific instructions  (URL-pattern + action)
"""

from pathlib import Path
from urllib.parse import unquote
import re

GOGGLE = Path(__file__).parent / "my_rerank.goggle"
PENDING_TXT = Path(__file__).parent / "pending_instructions.txt"
BOOST_TXT = Path(__file__).parent / "goggles_boost.txt"
DISCARD_TXT = Path(__file__).parent / "goggles_discard.txt"

METADATA_KEYS = {
    "name", "description", "public", "author", "avatar",
    "homepage", "issues", "transferred_to", "license",
}

# Patterns used to classify goggle instructions.
BOOST_PATTERN = re.compile(r"^\$boost(?:=(\d+))?,site=(.+)$")
DOWNRANK_PATTERN = re.compile(r"^\$downrank(?:=(\d+))?,site=(.+)$")
DISCARD_SITE_PATTERN = re.compile(r"^\$discard,site=(.+)$")
TLD_PATTERN = re.compile(r"^\|https://\*\.(.+)\^(.+)$")
ACTION_OPTION_PATTERN = re.compile(
    r"^(?:boost|downrank)(?:=(?:[1-9]|10))?$|^discard$"
)


def parse_cookie_file(path: Path) -> set[str]:
    """Read a single-value cookie file and return the set of domains."""
    if not path.exists():
        return set()
    raw = path.read_text(encoding="utf-8").strip()
    if not raw:
        return set()
    decoded = unquote(raw)
    return {d.strip() for d in decoded.split("|") if d.strip()}


def parse_pending_file(path: Path) -> list[str]:
    """Read the pending instructions file.

    Accepts two formats:
      - A JSON array on a single line (raw localStorage dump)
      - Plain text with one instruction per line
    """
    if not path.exists():
        return []
    raw = path.read_text(encoding="utf-8").strip()
    if not raw:
        return []

    # Detect JSON array format (raw localStorage copy-paste).
    if raw.startswith("["):
        import json
        try:
            entries = json.loads(raw)
            return [e.strip() for e in entries if isinstance(e, str) and e.strip()]
        except json.JSONDecodeError:
            pass

    # Fall back to newline-separated plain text.
    return [
        line.strip()
        for line in raw.splitlines()
        if line.strip() and not line.strip().startswith("!")
    ]


def is_url_pattern_instruction(line: str) -> bool:
    """Return whether a URL pattern contains an explicit ranking action.

    Brave URL patterns may be relative or absolute and may contain anchors,
    wildcards, paths, and optional filters such as ``site=``. The text before
    the first dollar sign is the URL pattern; the comma-separated text after it
    contains the options.
    """
    url_pattern, separator, options = line.partition("$")
    if not separator or not url_pattern or not options:
        return False

    return any(
        ACTION_OPTION_PATTERN.fullmatch(option) is not None
        for option in options.split(",")
    )


def classify_instruction(line: str, data: dict) -> bool:
    """
    Classify a single instruction line and merge it into `data`.
    Returns True if the line matched a known pattern.
    """
    match_boost = BOOST_PATTERN.match(line)
    if match_boost:
        strength = int(match_boost.group(1)) if match_boost.group(1) else 1
        domain = match_boost.group(2)
        # Last-write-wins: the most recent entry overrides earlier ones.
        data["boosts"][domain] = strength
        return True

    match_downrank = DOWNRANK_PATTERN.match(line)
    if match_downrank:
        strength = int(match_downrank.group(1)) if match_downrank.group(1) else 1
        domain = match_downrank.group(2)
        data["downranks"][domain] = strength
        return True

    match_discard = DISCARD_SITE_PATTERN.match(line)
    if match_discard:
        data["discards"].add(match_discard.group(1))
        return True

    match_tld = TLD_PATTERN.match(line)
    if match_tld:
        data["tld_rules"].add(line)
        return True

    if is_url_pattern_instruction(line):
        data["path_rules"].add(line)
        return True

    return False


def parse_goggle(path: Path) -> dict:
    """Parse the goggle file into structured sections."""
    data = {
        "metadata": [],
        "boosts": {},
        "downranks": {},
        "discards": set(),
        "tld_rules": set(),
        "path_rules": set(),
    }

    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()

        if not stripped:
            continue

        # Metadata: '! key: value' lines.
        if stripped.startswith("!"):
            if ":" in stripped:
                key = stripped[2:].split(":", 1)[0].strip()
                if key in METADATA_KEYS:
                    data["metadata"].append(line)
            continue

        classify_instruction(stripped, data)

    return data


def write_goggle(path: Path, data: dict) -> None:
    lines = list(data["metadata"])

    boosts = data["boosts"]
    downranks = data["downranks"]
    discards = data["discards"]
    tld_rules = data["tld_rules"]
    path_rules = data["path_rules"]

    if boosts:
        lines.append("")
        lines.append(f"! {'=' * 74}")
        lines.append(f"! Raised domains ({len(boosts)})")
        lines.append("! Domains that appear higher in search results.")
        lines.append(f"! {'=' * 74}")
        lines.append("")
        for domain in sorted(boosts):
            strength = boosts[domain]
            if strength == 1:
                lines.append(f"$boost,site={domain}")
            else:
                lines.append(f"$boost={strength},site={domain}")

    if downranks:
        lines.append("")
        lines.append(f"! {'=' * 74}")
        lines.append(f"! Downranked domains ({len(downranks)})")
        lines.append("! Domains that appear lower in search results.")
        lines.append(f"! {'=' * 74}")
        lines.append("")
        for domain in sorted(downranks):
            strength = downranks[domain]
            if strength == 1:
                lines.append(f"$downrank,site={domain}")
            else:
                lines.append(f"$downrank={strength},site={domain}")

    if tld_rules:
        lines.append("")
        lines.append(f"! {'=' * 74}")
        lines.append(f"! TLD-level rules ({len(tld_rules)})")
        lines.append("! Blanket rules targeting entire top-level domains.")
        lines.append(f"! {'=' * 74}")
        lines.append("")
        for rule in sorted(tld_rules):
            lines.append(rule)

    if discards:
        lines.append("")
        lines.append(f"! {'=' * 74}")
        lines.append(f"! Discarded domains ({len(discards)})")
        lines.append("! Domains that never appear in search results.")
        lines.append(f"! {'=' * 74}")
        lines.append("")
        for domain in sorted(discards):
            lines.append(f"$discard,site={domain}")

    if path_rules:
        lines.append("")
        lines.append(f"! {'=' * 74}")
        lines.append(f"! Path-specific rules ({len(path_rules)})")
        lines.append("! Rules targeting specific URL paths within a domain.")
        lines.append(f"! {'=' * 74}")
        lines.append("")
        for rule in sorted(path_rules):
            lines.append(rule)

    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    data = parse_goggle(GOGGLE)

    before_boosts = dict(data["boosts"])
    before_downranks = dict(data["downranks"])
    before_discards = set(data["discards"])
    before_tld = set(data["tld_rules"])
    before_path = set(data["path_rules"])

    # --- Source 1: pending_instructions.txt (full instructions) ---
    pending_lines = parse_pending_file(PENDING_TXT)
    pending_unrecognized = []
    for line in pending_lines:
        if not classify_instruction(line, data):
            pending_unrecognized.append(line)

    # --- Source 2+3: legacy cookie files (domain-only) ---
    for domain in parse_cookie_file(BOOST_TXT):
        if domain not in data["boosts"]:
            data["boosts"][domain] = 1

    data["discards"] |= parse_cookie_file(DISCARD_TXT)

    # --- Write ---
    write_goggle(GOGGLE, data)

    # --- Report ---
    new_boosts = set(data["boosts"]) - set(before_boosts)
    changed_boosts = {
        d for d in set(data["boosts"]) & set(before_boosts)
        if data["boosts"][d] != before_boosts[d]
    }
    new_downranks = set(data["downranks"]) - set(before_downranks)
    new_discards = data["discards"] - before_discards
    new_tld = data["tld_rules"] - before_tld
    new_path = data["path_rules"] - before_path

    print(f"Boost:    {len(before_boosts)} existing + {len(new_boosts)} new = {len(data['boosts'])}")
    for domain in sorted(new_boosts):
        print(f"  + {domain} (strength {data['boosts'][domain]})")
    for domain in sorted(changed_boosts):
        print(f"  ~ {domain}: {before_boosts[domain]} -> {data['boosts'][domain]}")

    if data["downranks"] or new_downranks:
        print(f"Downrank: {len(before_downranks)} existing + {len(new_downranks)} new = {len(data['downranks'])}")
        for domain in sorted(new_downranks):
            print(f"  + {domain} (strength {data['downranks'][domain]})")

    print(f"Discard:  {len(before_discards)} existing + {len(new_discards)} new = {len(data['discards'])}")
    for domain in sorted(new_discards):
        print(f"  + {domain}")

    if new_tld:
        print(f"TLD:      {len(before_tld)} existing + {len(new_tld)} new = {len(data['tld_rules'])}")
        for rule in sorted(new_tld):
            print(f"  + {rule}")

    if new_path:
        print(f"Path:     {len(before_path)} existing + {len(new_path)} new = {len(data['path_rules'])}")
        for rule in sorted(new_path):
            print(f"  + {rule}")

    if pending_unrecognized:
        print(f"\nWarning: {len(pending_unrecognized)} unrecognized instruction(s):")
        for line in pending_unrecognized:
            print(f"  ? {line}")

    total_new = len(new_boosts) + len(new_downranks) + len(new_discards) + len(new_tld) + len(new_path) + len(changed_boosts)
    if total_new == 0:
        print("Nothing new to add.")


if __name__ == "__main__":
    main()
