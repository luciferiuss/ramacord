// Запускает все *.test.js в текущей папке в одном процессе.
// Сделано так, чтобы `npm test` не зависел от спавна дочерних процессов.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith(".test.js"))
  .sort();

if (!files.length) {
  console.error("Не найдено ни одного *.test.js");
  process.exit(1);
}

for (const f of files) {
  await import(pathToFileURL(path.join(dir, f)).href);
}
