#!/usr/bin/env node

import { spawn } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Command } from "commander";
import Anthropic from "@anthropic-ai/sdk";
import {
  Instructions,
  InstructionsSchema,
  DataRegex,
  DataRegexSchema,
  ScriptIdSchema,
  Metadata,
  MetadataSchema,
} from "./types";
import { MessageParam } from "@anthropic-ai/sdk/resources";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

function getCacheDir(): string {
  const cacheDir = path.join(
    process.env.HOME || process.env.USERPROFILE || ".",
    ".cache",
    "anyplot"
  );
  fs.mkdirSync(cacheDir, { recursive: true });
  return cacheDir;
}

function getCacheMetadataFile(): string {
  return path.join(getCacheDir(), "metadata.json");
}

function loadCacheMetadata(): Metadata {
  const metadataFile = getCacheMetadataFile();
  if (fs.existsSync(metadataFile)) {
    const rawData = fs.readFileSync(metadataFile, "utf-8");
    const parsed = JSON.parse(rawData);
    return MetadataSchema.parse(parsed);
  }
  return {
    instructionsToRegexToScriptId: {},
  };
}

function saveCacheMetadata(metadata: Metadata): void {
  fs.writeFileSync(getCacheMetadataFile(), JSON.stringify(metadata, null, 2));
}

async function askClaude(messages: MessageParam[]): Promise<string> {
  const response = await client.messages.create({
    model: "claude-opus-4-1-20250805",
    max_tokens: 4000,
    messages: messages,
  });
  if (response.content.length > 1) {
    throw new Error("Unexpected response format from Claude");
  }
  const content = response.content[0];
  if (content?.type !== "text") {
    throw new Error("Unexpected response format from Claude");
  }
  return content.text;
}

const maxFixRegexAttempts = 5;
async function createRegex(
  lines: string[]
): Promise<{ regex: DataRegex; representativeLines: string[] }> {
  const representativeLines = lines.slice(0, 5);
  const messages: MessageParam[] = [
    {
      role: "user",
      content: `
Here are several strings, one per line:

\`\`\`
${representativeLines.join("\n")}
\`\`\`

Respond with a regular expression that matches all of the strings.

Examples:

Input:

    \`\`\`
    123
    456
    789
    \`\`\`

Output:

    \`\`\`
    ^\\d+$
    \`\`\`

Input:

    \`\`\`
    123
    -45.6
    789
    \`\`\`

Output:

    \`\`\`
    ^-?\\d+(\\.\\d*)?$
    \`\`\`


Input:

    \`\`\`
    2020-01-02T03:04:05.678Z   1
    2020-01-02T03:05:05.678Z   2
    2020-01-02T03:08:05.678Z   1
    \`\`\`

Output:

    \`\`\`
    ^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d+Z\\s+\\d+$
    \`\`\`

      `,
    },
  ];

  const response = await askClaude(messages);
  messages.push({ role: "assistant", content: response });
  let pat = DataRegexSchema.parse(getFinalCodeBlock(response));
  let re = new RegExp(pat);
  console.debug(`Initial regex attempt: ${pat}`);

  for (let attempt = 0; attempt < maxFixRegexAttempts; attempt++) {
    const failures = lines.filter((line) => !re.test(line)).slice(0, 5);
    if (failures.length === 0) {
      console.debug(`Found a regex that matches all lines: ${pat}`);
      return { regex: pat, representativeLines };
    }

    representativeLines.push(...failures);

    console.debug(`Regex failed to match: ${JSON.stringify(failures)}`);

    messages.push({
      role: "user",
      content: `The regex failed to match the following lines:\n\n${failures.join(
        "\n"
      )}\n\nPlease fix the regex and provide ONLY the corrected regular expression, nothing else.`,
    });

    const response = await askClaude(messages);
    messages.push({ role: "assistant", content: response });
    pat = DataRegexSchema.parse(getFinalCodeBlock(response));
    re = new RegExp(pat);
    console.debug(`Attempt ${attempt + 1} at regex: ${pat}`);
  }

  throw new Error(
    `Failed to generate valid regex after ${maxFixRegexAttempts} attempts`
  );
}

function findCachedScript(
  instructions: Instructions,
  lines: string[],
  metadata: Metadata
): string | null {
  const instructionsToRegexToScriptId = metadata.instructionsToRegexToScriptId;
  const regexToScriptId = instructionsToRegexToScriptId[instructions];

  if (!regexToScriptId) {
    return null;
  }

  for (const [regex, scriptId] of Object.entries(regexToScriptId)) {
    const regexObj = new RegExp(regex, "m");
    if (lines.every((line) => regexObj.test(line))) {
      const res = path.join(getCacheDir(), `scripts`, `${scriptId}.py`);
      if (fs.existsSync(res)) {
        return res;
      }
    }
  }

  return null;
}

function writeScript(content: string, path: string): void {
  if (!content.startsWith("#!")) {
    content = `#!/usr/bin/env python3\n\n${content}`;
  }
  fs.writeFileSync(path, content);
  fs.chmodSync(path, 0o755);
}

const finalCodeBlockRegex = /```\w*\n(.*)\n```\s*$/s;
function getFinalCodeBlock(text: string): string {
  const match = text.match(finalCodeBlockRegex);
  if (!match) {
    throw new Error("No final code block found");
  }
  return match[1]!;
}

const maxFixScriptAttempts = 5;
async function synthesizeScript(
  instructions: string,
  lines: string[]
): Promise<string> {
  const initialPrompt = `Generate a Python script that uses plotly to create a visualization based on these instructions: "${instructions}"

Here are the first few lines of the data:
\`\`\`
${lines.slice(0, 10).join("\n")}
\`\`\`

The script should:
1. Read data from stdin (using sys.stdin)
2. Parse the data appropriately based on the format shown
3. Create a plotly visualization according to the instructions
4. Display the plot using plotly.graph_objects or plotly.express
5. Accept an optional \`--dry-run\` flag; if given, it still makes almost all the Plotly calls, to reveal any errors; it just skips the \`.show()\` at the end.

Return ONLY the Python script code, nothing else. The script should be complete and runnable.`;

  const messages: MessageParam[] = [{ role: "user", content: initialPrompt }];

  const response = await askClaude(messages);
  messages.push({ role: "assistant", content: response });

  const tempFile = path.join(os.tmpdir(), `anyplot_test_${Date.now()}.py`);
  const read = () => fs.promises.readFile(tempFile, "utf-8");

  writeScript(getFinalCodeBlock(response), tempFile);
  console.debug(`Script saved to ${tempFile}:\n\n${await read()}`);

  for (let attempt = 0; attempt < maxFixScriptAttempts; attempt++) {
    const { success, error } = await validateScript(tempFile, lines);

    if (success) {
      const res = await read();
      fs.unlinkSync(tempFile);
      return res;
    }

    console.debug(`Script failed with error:\n\n${error}`);

    messages.push({
      role: "user",
      content: `The script failed with this error:
\`\`\`
${error}
\`\`\`

Please fix the script and provide ONLY the corrected Python code, nothing else.`,
    });

    const response = await askClaude(messages);
    messages.push({ role: "assistant", content: response });

    writeScript(getFinalCodeBlock(response), tempFile);
    console.debug(`Attempated fix saved to ${tempFile}:\n\n${await read()}`);
  }

  throw new Error(
    `Failed to generate valid script after ${maxFixScriptAttempts} attempts`
  );
}

async function saveScript(
  scriptContent: string,
  instructions: Instructions,
  dataRegex: DataRegex,
  metadata: Metadata
): Promise<string> {
  if (!scriptContent.startsWith("#!")) {
    scriptContent = `#!/usr/bin/env python3\n\n${scriptContent}`;
  }

  const scriptId = ScriptIdSchema.parse(
    createHash("sha256").update(`${scriptContent}`).digest("hex")
  );
  const scriptsDir = path.join(getCacheDir(), "scripts");
  fs.mkdirSync(scriptsDir, { recursive: true });
  const scriptPath = path.join(scriptsDir, `${scriptId}.py`);

  writeScript(scriptContent, scriptPath);

  if (!metadata.instructionsToRegexToScriptId[instructions]) {
    metadata.instructionsToRegexToScriptId[instructions] = {};
  }
  metadata.instructionsToRegexToScriptId[instructions]![dataRegex] = scriptId;

  saveCacheMetadata(metadata);
  return scriptPath;
}

async function readStdin(): Promise<string> {
  const chunks: string[] = [];
  process.stdin.setEncoding("utf-8");

  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }

  return chunks.join("");
}

async function validateScript(
  scriptPath: string,
  lines: string[]
): Promise<
  { success: true; error?: undefined } | { success: false; error: string }
> {
  return new Promise((resolve) => {
    const pythonProcess = spawn(scriptPath, ["--dry-run"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    pythonProcess.stdin.write(lines.join("\n"));
    pythonProcess.stdin.end();

    let stderr = "";

    pythonProcess.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    pythonProcess.on("close", (code) => {
      if (code !== 0) {
        resolve({ success: false, error: stderr });
      } else {
        resolve({ success: true });
      }
    });

    pythonProcess.on("error", (err) => {
      resolve({ success: false, error: err.message });
    });
  });
}

async function runScript(scriptPath: string, lines: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    console.debug(`Executing: ${scriptPath}`);
    const pythonProcess = spawn(scriptPath, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    pythonProcess.stdin.write(lines.join("\n"));
    pythonProcess.stdin.end();

    let stdout = "";
    let stderr = "";

    pythonProcess.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      process.stdout.write(chunk);
    });

    pythonProcess.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      process.stderr.write(chunk);
    });

    pythonProcess.on("close", (code) => {
      if (code !== 0) {
        console.error(`\nPython script failed with exit code ${code}`);
        if (stderr && !stderr.trim().endsWith("\n")) {
          console.error();
        }
        console.error(`Script path: ${scriptPath}`);
        reject(new Error(`Script execution failed with code ${code}`));
      } else {
        resolve();
      }
    });

    pythonProcess.on("error", (err) => {
      if (err.message.includes("ENOENT")) {
        console.error(
          "Error: python3 not found. Please ensure Python 3 is installed and in your PATH."
        );
      } else {
        console.error(`Error spawning Python process: ${err.message}`);
      }
      reject(err);
    });
  });
}

async function main(): Promise<void> {
  const program = new Command();

  program
    .name("anyplot")
    .description("Command-line tool to plot anything using natural language")
    .usage("<instructions> [path]")
    .argument("<instructions>", "Instructions for creating the plot")
    .argument("[path]", "Path to data file (reads from stdin if not provided)")
    .option("--skip-cache", "Skip cache and regenerate script", false)
    .parse(process.argv);

  const [instructionsArg, filePath] = program.args;
  const options = program.opts();

  const instructions = InstructionsSchema.parse(instructionsArg);
  const skipCache = options.skipCache;

  let lines: string[];

  if (filePath) {
    if (!fs.existsSync(filePath)) {
      console.error(`Error: File ${filePath} does not exist`);
      process.exit(1);
    }
    lines = fs.readFileSync(filePath, "utf-8").split("\n");
  } else {
    lines = (await readStdin()).split("\n");
  }

  lines = lines.filter((l) => l.trim() !== "");

  const metadata = loadCacheMetadata();

  const cachedScript = skipCache
    ? null
    : findCachedScript(instructions, lines, metadata);
  let scriptPath: string;

  if (cachedScript) {
    scriptPath = cachedScript;
  } else {
    console.log(`No cached script found; finding representative lines...`);
    const { regex, representativeLines } = await createRegex(lines);
    console.debug(
      `Representative lines: ${JSON.stringify(representativeLines)}`
    );
    console.debug(`Regex: ${regex}`);
    const scriptContent = await synthesizeScript(
      instructions,
      representativeLines
    );
    scriptPath = await saveScript(scriptContent, instructions, regex, metadata);
  }

  await runScript(scriptPath, lines);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
