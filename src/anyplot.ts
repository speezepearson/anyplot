#!/usr/bin/env node

import { spawn } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs";
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

function readFirstLines(data: string, numLines: number = 5): string {
  const lines = data.split("\n");
  return lines.slice(0, Math.min(numLines, lines.length)).join("\n");
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createRegexFromSample(sample: string): DataRegex {
  const lines = sample.split("\n");
  const regexLines: string[] = [];

  for (const line of lines) {
    if (!line) {
      regexLines.push("^\\s*$");
      continue;
    }

    let escaped = escapeRegex(line);
    escaped = escaped.replace(/\\d+/g, "\\d+");
    escaped = escaped.replace(/\\\s+/g, "\\s+");
    regexLines.push(`^${escaped}$`);
  }

  return DataRegexSchema.parse(
    regexLines.map((pattern) => `(${pattern})`).join("|")
  );
}

function findCachedScript(
  instructions: Instructions,
  dataSample: string,
  metadata: Metadata
): string | null {
  const instructionsToRegexToScriptId = metadata.instructionsToRegexToScriptId;
  const regexToScriptId = instructionsToRegexToScriptId[instructions];

  if (!regexToScriptId) {
    return null;
  }

  for (const [regex, scriptId] of Object.entries(regexToScriptId)) {
    const regexObj = new RegExp(regex, "m");
    if (regexObj.test(dataSample)) {
      return path.join(getCacheDir(), `scripts`, `${scriptId}.py`);
    }
  }

  return null;
}

async function synthesizeScript(
  instructions: string,
  dataSample: string,
  client: Anthropic
): Promise<string> {
  const prompt = `Generate a Python script that uses plotly to create a visualization based on these instructions: "${instructions}"

Here are the first few lines of the data:
\`\`\`
${dataSample}
\`\`\`

The script should:
1. Read data from stdin (using sys.stdin)
2. Parse the data appropriately based on the format shown
3. Create a plotly visualization according to the instructions
4. Display the plot using plotly.graph_objects or plotly.express

Return ONLY the Python script code, nothing else. The script should be complete and runnable.`;

  const response = await client.messages.create({
    model: "claude-opus-4-1-20250805",
    max_tokens: 4000,
    messages: [{ role: "user", content: prompt }],
  });

  const content = response.content[0];
  if (content && "text" in content) {
    let scriptText = content.text;

    if (scriptText.startsWith("```")) {
      const lines = scriptText.split("\n");
      if (lines[0]?.startsWith("```")) {
        lines.shift();
      }
      if (lines.length > 0 && lines[lines.length - 1]?.trim() === "```") {
        lines.pop();
      }
      scriptText = lines.join("\n");
    }

    return scriptText;
  } else {
    throw new Error("Unexpected response format from Claude");
  }
}

function saveScript(
  scriptContent: string,
  instructions: Instructions,
  dataSample: string,
  metadata: Metadata
): string {
  const scriptId = ScriptIdSchema.parse(
    createHash("sha256").update(`${instructions}${scriptContent}`).digest("hex")
  );
  const scriptPath = path.join(getCacheDir(), "scripts", `${scriptId}.py`);

  fs.writeFileSync(scriptPath, scriptContent);

  const dataRegex = createRegexFromSample(dataSample);

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

async function runScript(scriptPath: string, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const pythonProcess = spawn("python3", [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    pythonProcess.stdin.write(data);
    pythonProcess.stdin.end();

    let stdout = "";
    let stderr = "";

    pythonProcess.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    pythonProcess.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    pythonProcess.on("close", (code) => {
      if (code !== 0) {
        console.error(`Error running script: ${stderr}`);
        process.exit(1);
      }
      if (stdout) {
        console.log(stdout);
      }
      resolve();
    });

    pythonProcess.on("error", (err) => {
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

  let data: string;

  if (filePath) {
    if (!fs.existsSync(filePath)) {
      console.error(`Error: File ${filePath} does not exist`);
      process.exit(1);
    }
    data = fs.readFileSync(filePath, "utf-8");
  } else {
    data = await readStdin();
  }

  const dataSample = readFirstLines(data, 5);
  const metadata = loadCacheMetadata();

  const cachedScript = skipCache
    ? null
    : findCachedScript(instructions, dataSample, metadata);

  let scriptPath: string;

  if (cachedScript) {
    scriptPath = cachedScript;
  } else {
    const client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
    const scriptContent = await synthesizeScript(
      instructions,
      dataSample,
      client
    );
    scriptPath = saveScript(scriptContent, instructions, dataSample, metadata);
  }

  await runScript(scriptPath, data);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
