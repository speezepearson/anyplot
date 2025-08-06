#!/usr/bin/env python3

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Dict, NewType, Optional, TypedDict

import anthropic

Instructions = NewType("Instructions", str)
DataRegex = NewType("DataRegex", str)
ScriptId = NewType("ScriptId", str)


class Metadata(TypedDict):
    instructions_to_regex_to_script_id: Dict[Instructions, Dict[DataRegex, ScriptId]]


parser = argparse.ArgumentParser()
parser.add_argument("instructions", type=str)
parser.add_argument("path", type=Path, nargs="?", default=None)
parser.add_argument(
    "--skip-cache", action="store_true", help="Skip cache and regenerate script"
)


def get_cache_dir() -> Path:
    cache_dir = Path.home() / ".cache" / "anyplot" / "scripts"
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir


def get_cache_metadata_file() -> Path:
    return get_cache_dir() / "metadata.json"


def load_cache_metadata() -> Metadata:
    metadata_file = get_cache_metadata_file()
    if metadata_file.exists():
        with open(metadata_file, "r") as f:
            return json.load(f)
    return {
        "instructions_to_regex_to_script_id": {},
    }


def save_cache_metadata(metadata: Metadata) -> None:
    with open(get_cache_metadata_file(), "w") as f:
        json.dump(metadata, f, indent=2)


def read_first_lines(data: str, num_lines: int = 5) -> str:
    lines = data.split("\n")
    return "\n".join(lines[: min(num_lines, len(lines))])


def create_regex_from_sample(sample: str) -> DataRegex:
    lines = sample.split("\n")
    regex_lines = []

    for line in lines:
        if not line:
            regex_lines.append(r"^\s*$")
            continue

        escaped = re.escape(line)
        escaped = re.sub(r"\\d+", r"\\d+", escaped)
        escaped = re.sub(r"\\\s+", r"\\s+", escaped)
        regex_lines.append(f"^{escaped}$")

    return DataRegex("|".join(f"({pattern})" for pattern in regex_lines))


def find_cached_script(
    instructions: Instructions, data_sample: str, metadata: Metadata
) -> Optional[Path]:
    instructions_to_regex_to_script_id = metadata["instructions_to_regex_to_script_id"]
    regex_to_script_id = instructions_to_regex_to_script_id.get(instructions, {})
    for regex, script_id in regex_to_script_id.items():
        if re.match(regex, data_sample, re.MULTILINE):
            return get_cache_dir() / f"{script_id}.py"
    return None


def synthesize_script(
    instructions: str, data_sample: str, client: anthropic.Anthropic
) -> str:
    prompt = f"""Generate a Python script that uses plotly to create a visualization based on these instructions: "{instructions}"

Here are the first few lines of the data:
```
{data_sample}
```

The script should:
1. Read data from stdin (using sys.stdin)
2. Parse the data appropriately based on the format shown
3. Create a plotly visualization according to the instructions
4. Display the plot using plotly.graph_objects or plotly.express

Return ONLY the Python script code, nothing else. The script should be complete and runnable."""

    response = client.messages.create(
        model="claude-opus-4-1-20250805",
        max_tokens=4000,
        messages=[{"role": "user", "content": prompt}],
    )

    content = response.content[0]
    if hasattr(content, "text"):
        script_text = content.text
        # Remove markdown code blocks if present
        if script_text.startswith("```"):
            lines = script_text.split("\n")
            if lines[0].startswith("```"):
                lines = lines[1:]  # Remove first line
            if lines and lines[-1].strip() == "```":
                lines = lines[:-1]  # Remove last line
            script_text = "\n".join(lines)
        return script_text
    else:
        raise ValueError("Unexpected response format from Claude")


def save_script(
    script_content: str,
    instructions: Instructions,
    data_sample: str,
    metadata: Metadata,
) -> Path:
    script_id = ScriptId(
        hashlib.sha256(f"{instructions}{script_content}".encode()).hexdigest()
    )
    script_path = get_cache_dir() / f"{script_id}.py"

    with script_path.open("w") as f:
        f.write(script_content)

    data_regex = create_regex_from_sample(data_sample)

    metadata["instructions_to_regex_to_script_id"].setdefault(instructions, {})[
        data_regex
    ] = script_id

    save_cache_metadata(metadata)
    return script_path


def main(args: argparse.Namespace) -> None:
    instructions = Instructions(args.instructions)
    path: Optional[Path] = args.path
    skip_cache: bool = args.skip_cache

    if path and not path.exists():
        print(f"Error: File {path} does not exist", file=sys.stderr)
        sys.exit(1)

    if path:
        with open(path, "r") as f:
            data = f.read()
    else:
        data = sys.stdin.read()

    data_sample = read_first_lines(data, num_lines=5)

    metadata = load_cache_metadata()

    cached_script = (
        None if skip_cache else find_cached_script(instructions, data_sample, metadata)
    )

    if cached_script:
        script_path = cached_script
    else:
        client = anthropic.Anthropic()
        script_content = synthesize_script(instructions, data_sample, client)
        script_path = save_script(script_content, instructions, data_sample, metadata)

    result = subprocess.run(
        [sys.executable, script_path], input=data, text=True, capture_output=True
    )

    if result.returncode != 0:
        print(f"Error running script: {result.stderr}", file=sys.stderr)
        sys.exit(1)

    if result.stdout:
        print(result.stdout)


if __name__ == "__main__":
    main(parser.parse_args())
