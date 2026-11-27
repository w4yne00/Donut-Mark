import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "runtime-zip": { type: "string" },
    help: { type: "boolean" }
  }
});

if (values.help) {
  console.log("用法：node scripts/package-deb.mjs [--runtime-zip /path/to/electron-linux-arm64.zip]");
  console.log("本地 ZIP 同目录须提供同版本官方 SHASUMS256.txt；省略参数时从 Electron 官方发布下载。");
  process.exit(0);
}

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(appRoot, "../..");
const appPackage = JSON.parse(await readFile(join(appRoot, "package.json"), "utf8"));
const workspacePackage = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
const electronVersion = appPackage.devDependencies.electron;
const version = workspacePackage.version;

if (!/^\d+\.\d+\.\d+$/.test(electronVersion) || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error("应用和 Electron 必须使用完整的固定版本号。");
}
if (appPackage.version !== version) {
  throw new Error("Electron 入口的应用版本必须与仓库版本一致。");
}

for (const file of ["dist/index.html", "dist-electron/main.js", "dist-electron/preload.cjs"]) {
  if (!(await stat(join(appRoot, file))).isFile()) {
    throw new Error(`构建产物不存在：${file}。请先运行 Electron 入口的 build。`);
  }
}

const buildRoot = join(appRoot, "build");
await mkdir(buildRoot, { recursive: true });
const archiveName = `electron-v${electronVersion}-linux-arm64.zip`;
const runtimeZip = values["runtime-zip"]
  ? resolve(values["runtime-zip"])
  : join(buildRoot, archiveName);
const shasumsPath = join(dirname(runtimeZip), "SHASUMS256.txt");

async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Electron 下载失败：${response.status} ${url}`);
  }
  const file = await open(destination, "w");
  try {
    await pipeline(Readable.fromWeb(response.body), file.createWriteStream());
  } finally {
    await file.close();
  }
}

if (!values["runtime-zip"]) {
  const releaseUrl = `https://github.com/electron/electron/releases/download/v${electronVersion}`;
  console.log(`下载 Electron ${electronVersion} Linux ARM64 运行时。`);
  await download(`${releaseUrl}/SHASUMS256.txt`, shasumsPath);
  await download(`${releaseUrl}/${archiveName}`, runtimeZip);
}

const checksumEntries = (await readFile(shasumsPath, "utf8"))
  .split(/\r?\n/)
  .map((line) => line.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/));
const expectedChecksum = checksumEntries.find((entry) => entry?.[2] === archiveName)?.[1];
if (!expectedChecksum) {
  throw new Error(`官方 SHASUMS256.txt 缺少 ${archiveName}。`);
}
const hash = createHash("sha256");
for await (const chunk of createReadStream(runtimeZip)) {
  hash.update(chunk);
}
if (hash.digest("hex") !== expectedChecksum.toLowerCase()) {
  throw new Error("Electron ARM64 运行时校验失败，已停止打包。");
}

const stage = await mkdtemp(join(buildRoot, "deb-stage-"));
const dataRoot = join(stage, "data");
const controlRoot = join(stage, "control");
const runtimeRoot = join(dataRoot, "opt/donut-mark");
const installedApp = join(runtimeRoot, "app");
const run = (command, args, options = {}) => execFileSync(command, args, {
  stdio: "inherit",
  env: { ...process.env, COPYFILE_DISABLE: "1" },
  ...options
});

try {
  await mkdir(runtimeRoot, { recursive: true });
  await mkdir(controlRoot);
  run("unzip", ["-q", runtimeZip, "-d", runtimeRoot]);
  if ((await readFile(join(runtimeRoot, "version"), "utf8")).trim() !== electronVersion) {
    throw new Error("运行时内的版本与 Electron 依赖版本不一致。");
  }
  const executable = await open(join(runtimeRoot, "electron"), "r");
  try {
    const header = Buffer.alloc(20);
    await executable.read(header, 0, header.length, 0);
    if (header.readUInt32BE(0) !== 0x7f454c46 || header[4] !== 2 || header[5] !== 1 || header.readUInt16LE(18) !== 183) {
      throw new Error("运行时必须是 Linux ARM64 ELF 可执行文件。");
    }
  } finally {
    await executable.close();
  }
  await chmod(join(runtimeRoot, "electron"), 0o755);
  await chmod(join(runtimeRoot, "chrome-sandbox"), 0o4755);
  if (((await stat(join(runtimeRoot, "chrome-sandbox"))).mode & 0o7777) !== 0o4755) {
    throw new Error("构建环境未保留 chrome-sandbox 的 4755 权限，请在允许设置该权限的环境中重新打包。");
  }
  await mkdir(installedApp);
  await cp(join(appRoot, "dist"), join(installedApp, "dist"), { recursive: true });
  await cp(join(appRoot, "dist-electron"), join(installedApp, "dist-electron"), { recursive: true });
  await cp(join(repositoryRoot, "LICENSE"), join(installedApp, "LICENSE"));
  await writeFile(join(installedApp, "package.json"), JSON.stringify({
    name: "donut-mark",
    productName: "Donut Mark",
    version,
    type: "module",
    main: "dist-electron/main.js",
    license: workspacePackage.license
  }, null, 2) + "\n");

  const binDirectory = join(dataRoot, "usr/bin");
  const desktopDirectory = join(dataRoot, "usr/share/applications");
  const iconDirectory = join(dataRoot, "usr/share/icons/hicolor/256x256/apps");
  const documentationDirectory = join(dataRoot, "usr/share/doc/donut-mark");
  for (const directory of [binDirectory, desktopDirectory, iconDirectory, documentationDirectory]) {
    await mkdir(directory, { recursive: true });
  }
  await writeFile(join(binDirectory, "donut-mark"), '#!/bin/sh\nexec /opt/donut-mark/electron /opt/donut-mark/app --class=donut-mark "$@"\n', { mode: 0o755 });
  await writeFile(join(desktopDirectory, "donut-mark.desktop"), `[Desktop Entry]
Type=Application
Name=Donut Mark
Comment=离线 Markdown 编辑器
Exec=/usr/bin/donut-mark %F
Icon=donut-mark
Terminal=false
Categories=Office;TextEditor;
MimeType=text/markdown;text/x-markdown;
StartupWMClass=donut-mark
`);
  await cp(join(repositoryRoot, "apps/desktop/src-tauri/icons/128x128@2x.png"), join(iconDirectory, "donut-mark.png"));
  await cp(join(iconDirectory, "donut-mark.png"), join(installedApp, "icon.png"));
  await writeFile(join(documentationDirectory, "copyright"), `Donut Mark ${version}
Source: https://github.com/w4yne00/Donut-Mark
Application license: /opt/donut-mark/app/LICENSE
Electron license: /opt/donut-mark/LICENSE
Chromium and third-party notices: /opt/donut-mark/LICENSES.chromium.html
`);

  // These shared libraries are present in the target Kylin V10 SP1 2403 desktop.
  const dependencies = [
    "libc6 (>= 2.31)", "libasound2", "libatk-bridge2.0-0", "libatk1.0-0", "libatspi2.0-0",
    "libcairo2", "libcups2", "libdbus-1-3", "libexpat1", "libgbm1", "libgcc-s1",
    "libglib2.0-0", "libgtk-3-0", "libnspr4", "libnss3", "libpango-1.0-0", "libudev1",
    "libx11-6", "libxcb1", "libxcomposite1", "libxdamage1", "libxext6", "libxfixes3",
    "libxkbcommon0", "libxrandr2", "xdg-utils"
  ];
  await writeFile(join(controlRoot, "control"), `Package: donut-mark
Version: ${version}-1
Architecture: arm64
Section: editors
Priority: optional
Maintainer: Donut Mark maintainers <maintainers@donut-mark.invalid>
Homepage: https://github.com/w4yne00/Donut-Mark
Depends: ${dependencies.join(", ")}
Description: Donut Mark offline Markdown editor for Kylin
 Includes Electron and the shared Markra editor for Kylin V10 SP1 2403 ARM64.
`);
  await writeFile(join(stage, "debian-binary"), "2.0\n");
  const tarVersion = execFileSync("tar", ["--version"], { encoding: "utf8" });
  // Kylin's dpkg cannot unpack PAX headers, including macOS extended metadata.
  const archiveOptions = tarVersion.includes("bsdtar")
    ? [
      "--format=gnutar", "--no-xattrs", "--no-acls", "--no-fflags", "--no-mac-metadata",
      "--uid", "0", "--gid", "0", "--uname", "root", "--gname", "root"
    ]
    : ["--format=gnu", "--no-xattrs", "--no-acls", "--owner=0", "--group=0", "--numeric-owner"];
  run("tar", [...archiveOptions, "-czf", join(stage, "control.tar.gz"), "-C", controlRoot, "."]);
  run("tar", [...archiveOptions, "-czf", join(stage, "data.tar.gz"), "-C", dataRoot, "."]);
  const packageName = `donut-mark_${version}-1_arm64.deb`;
  run("ar", ["-rcS", packageName, "debian-binary", "control.tar.gz", "data.tar.gz"], { cwd: stage });
  const destination = join(buildRoot, packageName);
  await rename(join(stage, packageName), destination);
  console.log(`安装包：${destination}`);
} finally {
  await rm(stage, { recursive: true, force: true });
}
