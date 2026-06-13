// Bundle the MCP App viewer into a single self-contained HTML file
// (mcp/dist/mcp-app.html) — the ui:// resource served to Claude Desktop.
import { build } from "esbuild";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const result = await build({
  entryPoints: [join(root, "mcp", "ui", "viewer.js")],
  bundle: true,
  format: "iife",
  minify: true,
  write: false,
});
// Guard against the bundle terminating the inline <script> tag early.
const js = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");

const css = await readFile(join(root, "public", "styles.css"), "utf-8");
const template = await readFile(join(root, "mcp", "ui", "viewer.html"), "utf-8");
const html = template.replace("/*__CSS__*/", () => css).replace("//__JS__", () => js);

await mkdir(join(root, "mcp", "dist"), { recursive: true });
await writeFile(join(root, "mcp", "dist", "mcp-app.html"), html);
console.log(`built mcp/dist/mcp-app.html (${(html.length / 1024).toFixed(0)} KB)`);
