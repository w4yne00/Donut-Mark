import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export async function atomicWrite(path: string, contents: string, mode: number, beforeReplace?: () => Promise<unknown>) {
  const temporaryPath = join(dirname(path), `.${basename(path)}-${randomUUID()}.tmp`);
  const file = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
  try {
    try {
      await file.chmod(mode);
      await file.writeFile(contents, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await beforeReplace?.();
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
