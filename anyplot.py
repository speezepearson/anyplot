#!/usr/bin/env python3

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Dict, List, Optional, Tuple, TypedDict

import anthropic

client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))

class Metadata(TypedDict):
    instructionsToRegexToScriptId: Dict[str, Dict[str, str]]


def get_cache_dir() -> Path:
    cache_dir = Path.home() / ".cache" / "anyplot"
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir


def get_cache_metadata_file() -> Path:
    return get_cache_dir() / "metadata.json"


def load_cache_metadata() -> Metadata:
    metadata_file = get_cache_metadata_file()
    if metadata_file.exists():
        with open(metadata_file, "r") as f:
            data = json.load(f)
            return {"instructionsToRegexToScriptId": data.get("instructionsToRegexToScriptId", {})}
    return {"instructionsToRegexToScriptId": {}}


def save_cache_metadata(metadata: Metadata) -> None:
    with open(get_cache_metadata_file(), "w") as f:
        json.dump(metadata, f, indent=2)


def ask_claude(messages: List[anthropic.types.MessageParam]) -> str:
    response = client.messages.create(
        model="claude-opus-4-1-20250805",
        max_tokens=4000,
        messages=messages,
    )

    if len(response.content) > 1:
        raise ValueError("Unexpected response format from Claude")

    content = response.content[0]
    if hasattr(content, "text"):
        return content.text
    else:
        raise ValueError("Unexpected response format from Claude")


def get_final_code_block(text: str) -> str:
    import re
    match = re.search(r'```\w*\n(.*?)\n```\s*$', text, re.DOTALL)
    if not match:
        raise ValueError("No final code block found")
    return match.group(1)


def create_regex(lines: List[str], max_attempts: int = 5) -> Tuple[str, List[str]]:
    representative_lines = lines[:5]

    messages: List[anthropic.types.MessageParam] = [
        {
            "role": "user",
            "content": f"""Here are several strings, one per line:

```
{chr(10).join(representative_lines)}
```

Respond with a regular expression that matches all of the strings.
Return the regex in a code block (``` ... ```) at the end of your message.

Examples:

Input:

    ```
    123
    456
    789
    ```

Output:

    ```
    ^\\d+$
    ```

Input:

    ```
    123
    -45.6
    789
    ```

Output:

    ```
    ^-?\\d+(\\.\\d*)?$
    ```


Input:

    ```
    2020-01-02T03:04:05.678Z   1
    2020-01-02T03:05:05.678Z   2
    2020-01-02T03:08:05.678Z   1
    ```

Output:

    ```
    ^\\d{{4}}-\\d{{2}}-\\d{{2}}T\\d{{2}}:\\d{{2}}:\\d{{2}}\\.\\d+Z\\s+\\d+$
    ```

"""
        }
    ]

    response = ask_claude(messages)
    messages.append({"role": "assistant", "content": response})

    pattern = get_final_code_block(response)
    regex_obj = re.compile(pattern)

    print(f"Initial regex attempt: {pattern}", file=sys.stderr)

    for attempt in range(max_attempts):
        failures = [line for line in lines if not regex_obj.match(line)][:5]

        if not failures:
            print(f"Found a regex that matches all lines: {pattern}", file=sys.stderr)
            return pattern, representative_lines

        representative_lines.extend(failures)

        print(f"Regex failed to match: {json.dumps(failures)}", file=sys.stderr)

        messages.append({
            "role": "user",
            "content": f"The regex failed to match the following lines:\n\n{chr(10).join(failures)}\n\nPlease fix the regex."
        })

        response = ask_claude(messages)
        messages.append({"role": "assistant", "content": response})
        pattern = get_final_code_block(response)
        regex_obj = re.compile(pattern)

        print(f"Attempt {attempt + 1} at regex: {pattern}", file=sys.stderr)

    raise ValueError(f"Failed to generate valid regex after {max_attempts} attempts")


def find_cached_script(instructions: str, lines: List[str], metadata: Metadata) -> Optional[Path]:
    regex_to_script_id = metadata["instructionsToRegexToScriptId"].get(instructions)

    if not regex_to_script_id:
        return None

    for regex_pattern, script_id in regex_to_script_id.items():
        try:
            regex_obj = re.compile(regex_pattern, re.MULTILINE)
            if all(regex_obj.match(line) for line in lines[:10]):
                script_path = get_cache_dir() / "scripts" / f"{script_id}.py"
                if script_path.exists():
                    return script_path
        except re.error:
            continue

    return None


def write_script(content: str, path: Path) -> None:
    if not content.startswith("#!"):
        content = f"#!/usr/bin/env python3\n\n{content}"
    path.write_text(content)
    path.chmod(0o755)


def validate_script(script_path: Path, lines: List[str]) -> Tuple[bool, Optional[str]]:
    try:
        result = subprocess.run(
            [str(script_path), "--dry-run"],
            input="\n".join(lines),
            text=True,
            capture_output=True,
            timeout=30
        )

        if result.returncode != 0:
            return False, result.stderr
        return True, None
    except subprocess.TimeoutExpired:
        return False, "Script execution timed out"
    except Exception as e:
        return False, str(e)


def synthesize_script(instructions: str, lines: List[str], max_attempts: int = 5) -> str:
    initial_prompt = f"""Generate a Python script that uses plotly to create a visualization based on these instructions: "{instructions}"

Here are the first few lines of the data:
```
{chr(10).join(lines[:10])}
```

The script should:
1. Read data from stdin (using sys.stdin)
2. Parse the data appropriately based on the format shown
3. Create a plotly visualization according to the instructions
4. Display the plot using plotly.graph_objects or plotly.express
5. Accept an optional `--dry-run` flag; if given, it still makes almost all the Plotly calls, to reveal any errors; it just skips the `.show()` at the end.

Libraries available: plotly, numpy, scipy

Return the COMPLETE Python script in a code block (``` ... ```) at the end of your message. The script should be complete and runnable."""

    messages: List[anthropic.types.MessageParam] = [{"role": "user", "content": initial_prompt}]

    print(f"Synthesizing script...", file=sys.stderr)
    response = ask_claude(messages)
    messages.append({"role": "assistant", "content": response})

    with tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False) as temp_file:
        temp_path = Path(temp_file.name)
        write_script(get_final_code_block(response), temp_path)

        print(f"Script saved to {temp_path}:\n\n{temp_path.read_text()}", file=sys.stderr)

        try:
            for attempt in range(max_attempts):
                success, error = validate_script(temp_path, lines)

                if success:
                    result = temp_path.read_text()
                    return result

                print(f"Script failed with error:\n\n{error}", file=sys.stderr)

                messages.append({
                    "role": "user",
                    "content": f"""The script failed with this error:
```
{error}
```

Please fix the script and provide ONLY the corrected Python code, nothing else."""
                })

                response = ask_claude(messages)
                messages.append({"role": "assistant", "content": response})

                write_script(get_final_code_block(response), temp_path)

                print(f"Attempted fix saved to {temp_path}:\n\n{temp_path.read_text()}", file=sys.stderr)

            raise ValueError(f"Failed to generate valid script after {max_attempts} attempts")
        finally:
            temp_path.unlink(missing_ok=True)


def save_script(script_content: str, instructions: str, data_regex: str, metadata: Metadata) -> Path:
    if not script_content.startswith("#!"):
        script_content = f"#!/usr/bin/env python3\n\n{script_content}"

    script_id = hashlib.sha256(script_content.encode()).hexdigest()
    scripts_dir = get_cache_dir() / "scripts"
    scripts_dir.mkdir(parents=True, exist_ok=True)
    script_path = scripts_dir / f"{script_id}.py"

    write_script(script_content, script_path)

    if instructions not in metadata["instructionsToRegexToScriptId"]:
        metadata["instructionsToRegexToScriptId"][instructions] = {}

    metadata["instructionsToRegexToScriptId"][instructions][data_regex] = script_id

    save_cache_metadata(metadata)
    return script_path


def run_script(script_path: Path, lines: List[str]) -> None:
    print(f"Executing: {script_path}", file=sys.stderr)

    try:
        process = subprocess.Popen(
            [str(script_path)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True
        )

        stdout, stderr = process.communicate(input="\n".join(lines))

        if stdout:
            print(stdout, end='')

        if stderr:
            print(stderr, file=sys.stderr, end='')

        if process.returncode != 0:
            print(f"\nPython script failed with exit code {process.returncode}", file=sys.stderr)
            print(f"Script path: {script_path}", file=sys.stderr)
            sys.exit(process.returncode)

    except FileNotFoundError:
        print("Error: python3 not found. Please ensure Python 3 is installed and in your PATH.", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error spawning Python process: {e}", file=sys.stderr)
        sys.exit(1)


def read_stdin() -> str:
    return sys.stdin.read()


def main():
    parser = argparse.ArgumentParser(
        prog="anyplot",
        description="Command-line tool to plot anything using natural language",
        usage="%(prog)s INSTRUCTIONS [PATH]"
    )
    parser.add_argument("instructions", help="Instructions for creating the plot")
    parser.add_argument("path", nargs="?", help="Path to data file (reads from stdin if not provided)")
    parser.add_argument("--skip-cache", action="store_true", help="Skip cache and regenerate script")

    args = parser.parse_args()

    instructions = args.instructions
    skip_cache = args.skip_cache

    if args.path:
        file_path = Path(args.path)
        if not file_path.exists():
            print(f"Error: File {file_path} does not exist", file=sys.stderr)
            sys.exit(1)
        with open(file_path, "r") as f:
            data = f.read()
    else:
        data = read_stdin()

    lines = [line for line in data.split("\n") if line.strip()]

    if not lines:
        print("Error: No data provided", file=sys.stderr)
        sys.exit(1)

    metadata = load_cache_metadata()

    cached_script = None if skip_cache else find_cached_script(instructions, lines, metadata)

    if cached_script:
        script_path = cached_script
    else:
        print("No cached script found; finding representative lines...", file=sys.stderr)

        regex, representative_lines = create_regex(lines)

        if os.environ.get("DEBUG"):
            print(f"Representative lines: {json.dumps(representative_lines)}", file=sys.stderr)
            print(f"Regex: {regex}", file=sys.stderr)

        script_content = synthesize_script(instructions, representative_lines)
        script_path = save_script(script_content, instructions, regex, metadata)

    run_script(script_path, lines)


if __name__ == "__main__":
    main()