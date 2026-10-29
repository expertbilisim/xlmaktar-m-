import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function sqlcmdBul() {
  const adaylar = [
    process.env.SQLCMD,
    "C:\\Program Files\\Microsoft SQL Server\\Client SDK\\ODBC\\180\\Tools\\Binn\\SQLCMD.EXE",
    "C:\\Program Files\\Microsoft SQL Server\\Client SDK\\ODBC\\170\\Tools\\Binn\\SQLCMD.EXE",
    "C:\\Program Files\\Microsoft SQL Server\\Client SDK\\ODBC\\130\\Tools\\Binn\\SQLCMD.EXE",
    "C:\\Program Files\\Microsoft SQL Server\\Client SDK\\ODBC\\110\\Tools\\Binn\\SQLCMD.EXE",
    "C:\\Program Files\\Microsoft SQL Server\\160\\Tools\\Binn\\SQLCMD.EXE",
    "C:\\Program Files\\Microsoft SQL Server\\150\\Tools\\Binn\\SQLCMD.EXE",
    "C:\\Program Files\\Microsoft SQL Server\\140\\Tools\\Binn\\SQLCMD.EXE",
    "C:\\Program Files\\Microsoft SQL Server\\130\\Tools\\Binn\\SQLCMD.EXE",
    "C:\\Program Files\\Microsoft SQL Server\\120\\Tools\\Binn\\SQLCMD.EXE",
    "C:\\Program Files\\Microsoft SQL Server\\110\\Tools\\Binn\\SQLCMD.EXE",
    "C:\\Program Files (x86)\\Microsoft SQL Server\\Client SDK\\ODBC\\170\\Tools\\Binn\\SQLCMD.EXE",
    "C:\\Program Files (x86)\\Microsoft SQL Server\\Client SDK\\ODBC\\130\\Tools\\Binn\\SQLCMD.EXE",
  ].filter(Boolean);
  return adaylar.find((yol) => existsSync(yol)) || "";
}

const SQLCMD = sqlcmdBul();

const DEFAULT_UDL =
  "C:\\Program Files (x86)\\Common Files\\System\\Ole DB\\Data Links\\vegacon.udl";

function readUdlText(filePath) {
  const buffer = readFileSync(filePath);
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.toString("utf16le");
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.alloc(buffer.length - 2);
    for (let i = 2; i + 1 < buffer.length; i += 2) {
      swapped[i - 2] = buffer[i + 1];
      swapped[i - 1] = buffer[i];
    }
    return swapped.toString("utf16le");
  }
  return buffer.toString("utf8");
}

function parseUdl(filePath) {
  const line = readUdlText(filePath)
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item && !item.startsWith(";") && !item.startsWith("["));
  if (!line) {
    throw new Error("UDL bağlantı satırı bulunamadı");
  }

  const fields = {};
  for (const part of line.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    fields[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim();
  }

  return {
    server: fields["data source"] || "(local)",
    database: fields["initial catalog"] || "VEGADB",
    user: fields["user id"] || "",
    password: fields.password || "",
  };
}

function loadConnection() {
  const udlPath = process.env.VEGA_UDL || DEFAULT_UDL;
  try {
    const fromUdl = parseUdl(udlPath);
    return {
      server: process.env.SQL_SERVER || fromUdl.server,
      database: process.env.SQL_DATABASE || fromUdl.database,
      user: process.env.SQL_USER || fromUdl.user,
      password: process.env.SQL_PASSWORD || fromUdl.password,
      source: udlPath,
    };
  } catch (error) {
    if (process.env.VEGA_UDL) throw error;
    return {
      server: process.env.SQL_SERVER || "(local)",
      database: process.env.SQL_DATABASE || "VEGADB",
      user: process.env.SQL_USER || "",
      password: process.env.SQL_PASSWORD || "",
      source: "env",
    };
  }
}

const connection = loadConnection();
const SERVER = connection.server;
const DATABASE = connection.database;
const SQL_USER = connection.user;
const SQL_PASSWORD = connection.password;

function sanitizeSearch(value) {
  return String(value ?? "")
    .replace(/['\[\];]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

const CP857 = [
  0x00c7, 0x00fc, 0x00e9, 0x00e2, 0x00e4, 0x00e0, 0x00e5, 0x00e7, 0x00ea, 0x00eb, 0x00e8, 0x00ef, 0x00ee, 0x0131, 0x00c4, 0x00c5,
  0x00c9, 0x00e6, 0x00c6, 0x00f4, 0x00f6, 0x00f2, 0x00fb, 0x00f9, 0x0130, 0x00d6, 0x00dc, 0x00f8, 0x00a3, 0x00d8, 0x015e, 0x015f,
  0x00e1, 0x00ed, 0x00f3, 0x00fa, 0x00f1, 0x00d1, 0x011e, 0x011f, 0x00bf, 0x00ae, 0x00ac, 0x00bd, 0x00bc, 0x00a1, 0x00ab, 0x00bb,
  0x2591, 0x2592, 0x2593, 0x2502, 0x2524, 0x00c1, 0x00c2, 0x00c0, 0x00a9, 0x2563, 0x2551, 0x2557, 0x255d, 0x00a2, 0x00a5, 0x2510,
  0x2514, 0x2534, 0x252c, 0x251c, 0x2500, 0x253c, 0x00e3, 0x00c3, 0x255a, 0x2554, 0x2569, 0x2566, 0x2560, 0x2550, 0x256c, 0x00a4,
  0x00ba, 0x00aa, 0x00ca, 0x00cb, 0x00c8, 0xf8bb, 0x00cd, 0x00ce, 0x00cf, 0x2518, 0x250c, 0x2588, 0x2584, 0x00a6, 0x00cc, 0x2580,
  0x00d3, 0x00df, 0x00d4, 0x00d2, 0x00f5, 0x00d5, 0x00b5, 0xf8bc, 0x00d7, 0x00da, 0x00db, 0x00d9, 0x00ec, 0x00ff, 0x00af, 0x00b4,
  0x00ad, 0x00b1, 0xf8bd, 0x00be, 0x00b6, 0x00a7, 0x00f7, 0x00b8, 0x00b0, 0x00a8, 0x00b7, 0x00b9, 0x00b3, 0x00b2, 0x25a0, 0x00a0,
];

function decodeSql(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ""), "latin1");
  let text = "";
  for (const byte of buffer) {
    text += byte < 0x80 ? String.fromCharCode(byte) : String.fromCharCode(CP857[byte - 0x80]);
  }
  return text;
}

function parseJsonRows(stdout) {
  const text = decodeSql(stdout)
    .replace(/^\uFEFF/, "")
    .replace(/[\u0000-\u001F]+/g, "")
    .trim();
  if (!text) return [];

  const slices = [text];
  const objectStart = text.indexOf("{");
  const objectEnd = text.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    slices.push(text.slice(objectStart, objectEnd + 1));
  }
  const arrayStart = text.indexOf("[");
  const arrayEnd = text.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    slices.push(text.slice(arrayStart, arrayEnd + 1));
  }

  for (const slice of slices) {
    try {
      const parsed = JSON.parse(slice);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      // sqlcmd bazen JSON öncesine başlık satırı ekler.
    }
  }
  throw new Error("SQL sonuç JSON olarak okunamadı");
}

export async function queryJson(sql) {
  if (!SQLCMD) {
    throw new Error("SQLCMD bulunamadı. Diğer bilgisayarda Vega ve SQL istemcisi kurulu olmalı.");
  }
  const args = [
    "-S",
    SERVER,
    "-d",
    DATABASE,
    "-b",
    "-r",
    "1",
    "-y",
    "0",
    "-Q",
    sql,
  ];
  if (SQL_USER) {
    args.push("-U", SQL_USER, "-P", SQL_PASSWORD);
  } else {
    args.push("-E");
  }

  try {
    const { stdout } = await execFileAsync(SQLCMD, args, {
      windowsHide: true,
      encoding: "buffer",
      maxBuffer: 8 * 1024 * 1024,
    });
    return parseJsonRows(stdout);
  } catch (error) {
    const rawOut = error?.stdout;
    if (rawOut && (Buffer.isBuffer(rawOut) ? rawOut.length : String(rawOut).trim())) {
      try {
        return parseJsonRows(rawOut);
      } catch {
        // stdout hata metni olabilir.
      }
    }
    const stdout = decodeSql(rawOut).trim();
    const stderr = decodeSql(error?.stderr).trim();
    const detail = [stderr, stdout.trim()]
      .filter(Boolean)
      .join(" ")
      .replace(/-P\s+\S+/gi, "-P ***");
    throw new Error(
      detail.split(/\r?\n/).filter(Boolean).slice(-4).join(" ").slice(0, 400) || "SQL sorgusu çalışmadı"
    );
  }
}

export function connectionSummary() {
  return {
    server: SERVER,
    database: DATABASE,
    auth: SQL_USER ? "sql" : "windows",
    source: connection.source,
  };
}

export { sanitizeSearch };
