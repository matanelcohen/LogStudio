import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("logstudio.svg", import.meta.url));
const sizes = [16, 32, 48, 64, 128, 256, 512, 1024];
const images = new Map(sizes.map((size) => [
  size,
  execFileSync("rsvg-convert", ["--width", String(size), "--height", String(size), source])
]));
writeFileSync(new URL("logstudio.png", import.meta.url), images.get(512));

const iconSizes = sizes.filter((size) => size <= 256);
const iconHeader = Buffer.alloc(6);
iconHeader.writeUInt16LE(1, 2);
iconHeader.writeUInt16LE(iconSizes.length, 4);
let offset = 6 + 16 * iconSizes.length;
const entries = iconSizes.map((size) => {
  const entry = Buffer.alloc(16);
  entry[0] = entry[1] = size % 256;
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(images.get(size).length, 8);
  entry.writeUInt32LE(offset, 12);
  offset += images.get(size).length;
  return entry;
});
writeFileSync(new URL("logstudio.ico", import.meta.url), Buffer.concat([
  iconHeader, ...entries, ...iconSizes.map((size) => images.get(size))
]));

const chunks = [[16, "icp4"], [32, "icp5"], [64, "icp6"], [128, "ic07"], [256, "ic08"], [512, "ic09"], [1024, "ic10"]]
  .map(([size, type]) => {
    const header = Buffer.alloc(8);
    header.write(type);
    header.writeUInt32BE(images.get(size).length + 8, 4);
    return Buffer.concat([header, images.get(size)]);
  });
const header = Buffer.alloc(8);
header.write("icns");
header.writeUInt32BE(8 + chunks.reduce((length, chunk) => length + chunk.length, 0), 4);
writeFileSync(new URL("logstudio.icns", import.meta.url), Buffer.concat([header, ...chunks]));
