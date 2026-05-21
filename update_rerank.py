"""
Merge new domains from goggles_boost.txt and goggles_discard.txt into
my_rerank.goggle. Each .txt file contains a single URL-encoded,
pipe-delimited value field (the raw cookie value). New domains are added
to the existing lists; nothing is removed.
"""

from pathlib import Path
from urllib.parse import unquote

GOGGLE = Path(__file__).parent / "my_rerank.goggle"
BOOST_TXT = Path(__file__).parent / "goggles_boost.txt"
DISCARD_TXT = Path(__file__).parent / "goggles_discard.txt"

# Lines that count as metadata (kept verbatim at the top of the file).
METADATA_KEYS = {"name", "description", "public", "author", "avatar",
                 "homepage", "issues", "transferred_to", "license"}


def parse_cookie_file(path: Path) -> set[str]:
    """Read a single-value cookie file and return the set of domains."""
    if not path.exists():
        return set()
    raw = path.read_text(encoding="utf-8").strip()
    if not raw:
        return set()
    decoded = unquote(raw)
    return {d.strip() for d in decoded.split("|") if d.strip()}


def parse_goggle(path: Path) -> tuple[list[str], set[str], set[str]]:
    """
    Parse the goggle file. Returns:
      - metadata lines (the '! key: value' block at the top)
      - set of currently boosted domains
      - set of currently discarded domains
    """
    metadata: list[str] = []
    boosts: set[str] = set()
    discards: set[str] = set()

    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()

        # Metadata: '! key: value' lines at the very top.
        if stripped.startswith("! ") and ":" in stripped:
            key = stripped[2:].split(":", 1)[0].strip()
            if key in METADATA_KEYS:
                metadata.append(line)
                continue

        if stripped.startswith("$boost,site="):
            boosts.add(stripped.removeprefix("$boost,site="))
        elif stripped.startswith("$discard,site="):
            discards.add(stripped.removeprefix("$discard,site="))

    return metadata, boosts, discards


def write_goggle(
    path: Path,
    metadata: list[str],
    boosts: set[str],
    discards: set[str],
) -> None:
    lines = list(metadata)

    lines.append("")
    lines.append(f"! {'=' * 74}")
    lines.append(f"! Raised domains ({len(boosts)})")
    lines.append("! Domains that appear higher in search results.")
    lines.append(f"! {'=' * 74}")
    lines.append("")
    for domain in sorted(boosts):
        lines.append(f"$boost,site={domain}")

    lines.append("")
    lines.append(f"! {'=' * 74}")
    lines.append(f"! Discarded domains ({len(discards)})")
    lines.append("! Domains that never appear in search results.")
    lines.append(f"! {'=' * 74}")
    lines.append("")
    for domain in sorted(discards):
        lines.append(f"$discard,site={domain}")

    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    metadata, existing_boosts, existing_discards = parse_goggle(GOGGLE)

    new_boosts = parse_cookie_file(BOOST_TXT)
    new_discards = parse_cookie_file(DISCARD_TXT)

    added_boosts = new_boosts - existing_boosts
    added_discards = new_discards - existing_discards

    merged_boosts = existing_boosts | new_boosts
    merged_discards = existing_discards | new_discards

    write_goggle(GOGGLE, metadata, merged_boosts, merged_discards)

    print(f"Boost:   {len(existing_boosts)} existing + {len(added_boosts)} new = {len(merged_boosts)}")
    if added_boosts:
        for d in sorted(added_boosts):
            print(f"  + {d}")

    print(f"Discard: {len(existing_discards)} existing + {len(added_discards)} new = {len(merged_discards)}")
    if added_discards:
        for d in sorted(added_discards):
            print(f"  + {d}")

    if not added_boosts and not added_discards:
        print("Nothing new to add.")


if __name__ == "__main__":
    main()
