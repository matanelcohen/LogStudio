import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SelectControl } from "./ui";

const require = createRequire(import.meta.url);
const directory = dirname(fileURLToPath(import.meta.url));

describe("OUI integration contracts", () => {
  it("uses OUI selects and preserves the empty/all choice", () => {
    let selected = "initial";
    render(<SelectControl label="Contract selection" value="one" choices={[
      { value: "", label: "All entries" }, { value: "one", label: "One entry" }
    ]} onChange={value => { selected = value; }} />);
    const trigger = screen.getByRole("combobox", { name: "Contract selection" });
    expect(trigger.getAttribute("data-slot")).toBe("select-trigger");
    fireEvent.keyDown(trigger, { key: "Enter" });
    const all = screen.getByRole("option", { name: "All entries" });
    expect(all.getAttribute("data-slot")).toBe("select-item");
    fireEvent.keyDown(all, { key: "Enter" });
    expect(selected).toBe("");
  });

  it("allowlists only the exact inline select stylesheet without relaxing CSP", () => {
    const source = readFileSync(require.resolve("@radix-ui/react-select"), "utf8");
    const style = source.match(/__html: `([^`]+)`/)?.[1];
    expect(style).toBeDefined();
    const hash = createHash("sha256").update(style!).digest("base64");
    const server = readFileSync(resolve(directory, "../../src/LogStudio/HttpLogServer.cs"), "utf8");
    expect(server).toContain(`'sha256-${hash}'`);
    expect(server).toContain(`'sha256-${createHash("sha256").update("").digest("base64")}'`);
    expect(server).toContain("style-src 'self' 'nonce-{0}'");
    expect(server).not.toMatch(/style-src [^;]*'unsafe-inline'/);
  });

  it("keeps OUI component CSS local and uses the supported React peer range", () => {
    const packagePath = require.resolve("@opensearch-project/oui/style.css");
    const css = readFileSync(packagePath, "utf8");
    const metadata = JSON.parse(readFileSync(resolve(directory, "../package.json"), "utf8"));
    const oui = JSON.parse(readFileSync(resolve(dirname(packagePath), "../package.json"), "utf8"));
    expect(metadata.dependencies["@opensearch-project/oui"]).toBe("2.0.0-alpha.2");
    expect(oui.peerDependencies.react).toContain("^19.0");
    expect(css).toContain("--oui-primary:");
    expect(css).toContain(".dark {");
    expect(css).not.toMatch(/@import\s+(?:url\()?["']?https?:/);
    expect(Object.keys(metadata.dependencies).some(name => name.startsWith("@radix-ui/"))).toBe(false);
  });
});
