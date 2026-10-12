import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const lock = JSON.parse(await readFile(resolve(root, "package-lock.json"), "utf8"));
const notices = ["Log Studio frontend: third-party licenses", "Dependencies are bundled locally. No external resources are loaded at runtime.", ""];
const upstreamLicenses = new Map([
  ["git+https://github.com/radix-ui/primitives.git", ["licenses/radix-ui.txt", "https://github.com/radix-ui/primitives/blob/main/LICENSE"]],
  ["https://github.com/theKashey/react-remove-scroll-bar", ["licenses/react-remove-scroll-bar.txt", "https://github.com/theKashey/react-remove-scroll-bar/blob/master/LICENSE"]]
]);

for (const [path, entry] of Object.entries(lock.packages)) {
  if (!path || entry.dev || !path.includes("node_modules/")) continue;
  const directory = resolve(root, path);
  const metadata = JSON.parse(await readFile(resolve(directory, "package.json"), "utf8"));
  notices.push(`${metadata.name} ${metadata.version} (${metadata.license ?? "see license below"})`);
  const files = (await readdir(directory)).filter(file => /^(license|licence|copying|notice)(\.|$)/i.test(file)).sort();
  if (files.length) {
    for (const file of files) notices.push(await readFile(resolve(directory, file), "utf8"));
  } else {
    const repository = typeof metadata.repository === "string" ? metadata.repository : metadata.repository?.url;
    const upstream = upstreamLicenses.get(repository);
    if (!upstream || metadata.license !== "MIT") throw new Error(`No verified license notice found for shipped dependency ${metadata.name}.`);
    notices.push(`Source: ${upstream[1]}`, await readFile(resolve(root, upstream[0]), "utf8"));
  }
  notices.push("------------------------------------------------------------", "");
}

await writeFile(resolve(root, "dist/third-party-notices.txt"), notices.join("\n"), "utf8");
console.log(`Bundled third-party notices written to ${dirname(resolve(root, "dist/third-party-notices.txt"))}.`);
