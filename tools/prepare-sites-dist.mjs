import { access, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const distDir = path.join(root, "dist");
const hostingFile = path.join(root, ".openai", "hosting.json");
const workerFile = path.join(root, "worker", "index.js");

await access(path.join(distDir, "index.html"));
await access(hostingFile);
await access(workerFile);

await mkdir(path.join(distDir, "server"), { recursive: true });
await copyFile(workerFile, path.join(distDir, "server", "index.js"));

// Keep the metadata inside dist as well so the generated package is self-describing.
await mkdir(path.join(distDir, ".openai"), { recursive: true });
await copyFile(hostingFile, path.join(distDir, ".openai", "hosting.json"));

console.log("Prepared Sites runtime: dist/server/index.js");
