import { build } from "esbuild";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const result = await build({
  metafile: true,
  stdin: {
    contents:
      'export { default as WebTorrent } from "webtorrent"; export { default as SimplePeer } from "@thaunknown/simple-peer"; export { downloadZip } from "client-zip"; export { default as HTTPSeed } from "webtorrent/lib/webconn.js";',
    resolveDir: process.cwd(),
  },
  bundle: true,
  inject: ["scripts/browser-globals.mjs"],
  alias: { path: "path-browserify" },
  platform: "browser",
  format: "esm",
  minify: true,
  legalComments: "linked",
  outfile: "web/webtorrent.js",
  define: { global: "globalThis", "process.env.NODE_ENV": '"production"' },
});
const packages = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const parts = input.replaceAll("\\", "/").split("/");
  const at = parts.lastIndexOf("node_modules");
  if (at < 0) continue;
  packages.add(
    parts.slice(0, at + (parts[at + 1].startsWith("@") ? 3 : 2)).join("/"),
  );
}
const licenses = [];
for (const folder of [...packages].sort()) {
  const pkg = JSON.parse(
    await readFile(path.join(folder, "package.json"), "utf8"),
  );
  licenses.push(
    `=== ${pkg.name} ${pkg.version} (${pkg.license || "see notices"}) ===`,
  );
  const names = (await readdir(folder)).filter((name) =>
    /^(licen[cs]e|copying|notice)([.-]|$)/i.test(name),
  );
  if (!names.length) {
    // Preserve the published package declaration when upstream omits a license file.
    licenses.push(
      JSON.stringify(
        {
          license: pkg.license,
          author: pkg.author,
          contributors: pkg.contributors,
        },
        null,
        2,
      ),
    );
    const readme = (await readdir(folder)).find((name) =>
      /^readme\./i.test(name),
    );
    if (!readme || pkg.license !== "MIT")
      throw new Error(`Review bundled license for ${pkg.name}`);
    names.push(readme);
  }
  for (const name of names.sort())
    licenses.push(await readFile(path.join(folder, name), "utf8"));
}
await writeFile(
  "web/WEBTORRENT-LICENSES.txt",
  licenses.join("\n\n").replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, ""),
);
