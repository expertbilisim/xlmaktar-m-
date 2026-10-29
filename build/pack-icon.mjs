import { readFileSync, writeFileSync } from "node:fs";

const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = sizes.map((size) => ({
  size,
  data: readFileSync(new URL(`./icon-${size}.png`, import.meta.url)),
}));

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);

let offset = 6 + images.length * 16;
const entries = images.map((image) => {
  const entry = Buffer.alloc(16);
  entry.writeUInt8(image.size === 256 ? 0 : image.size, 0);
  entry.writeUInt8(image.size === 256 ? 0 : image.size, 1);
  entry.writeUInt8(0, 2);
  entry.writeUInt8(0, 3);
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(image.data.length, 8);
  entry.writeUInt32LE(offset, 12);
  offset += image.data.length;
  return entry;
});

writeFileSync(new URL("./icon.ico", import.meta.url), Buffer.concat([header, ...entries, ...images.map((image) => image.data)]));
console.log("icon.ico", offset);
