import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { queryJson as vegaSorgu, connectionSummary } from "./lib/db.js";

const require = createRequire(import.meta.url);
const PORT = Number(process.env.PORT || 3855);
const root = dirname(fileURLToPath(import.meta.url));

function veriKlasoru() {
  if (!process.versions.electron) return root;
  try {
    const { app } = require("electron");
    if (app?.isPackaged) return app.getPath("userData");
  } catch {
    // node ile çalışırken electron yoktur.
  }
  return root;
}

const ayarDosya = join(veriKlasoru(), "ayar.json");
const baglanti = connectionSummary();
const oturumlar = new Map();

function dbAdi(value) {
  const ad = String(value ?? "").trim();
  return /^[A-Za-z0-9_]+$/.test(ad) ? ad : "";
}

function ayarOku() {
  try {
    const data = JSON.parse(readFileSync(ayarDosya, "utf8"));
    return dbAdi(data.veritabani) || baglanti.database;
  } catch {
    return baglanti.database;
  }
}

let veritabani = ayarOku();

function queryJson(sql) {
  const ad = dbAdi(veritabani) || baglanti.database;
  return vegaSorgu(`USE [${ad}];\n${sql}`);
}

async function veritabanlari() {
  return vegaSorgu(`
SET NOCOUNT ON;
SELECT name AS ad
FROM sys.databases
WHERE database_id > 4 AND state = 0 AND HAS_DBACCESS(name) = 1
ORDER BY name
FOR JSON PATH;
`);
}

async function baglantiDene(ad) {
  const rows = await vegaSorgu(`
SET NOCOUNT ON;
USE [${ad}];
SELECT DB_NAME() AS veritabani, @@SERVERNAME AS sunucu,
  CASE WHEN OBJECT_ID(N'dbo.TBLFIRMA') IS NULL THEN 0 ELSE 1 END AS vega
FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;
`);
  return rows[0] || null;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  trimValues: true,
  isArray: (name) => ["CreditNoteLine", "PartyIdentification", "Note", "TaxSubtotal"].includes(name),
});

function sqlText(value, max = 200) {
  return String(value ?? "").replace(/'/g, "''").slice(0, max);
}

function sqlNum(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  return String(Math.round(n * 10000) / 10000);
}

function firmaNo(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 9999) return null;
  return n;
}

function tablo(firma, donem, ad) {
  const f = String(firma).padStart(4, "0");
  if (!donem) return `F${f}${ad}`;
  return `F${f}D${String(donem).padStart(4, "0")}${ad}`;
}

function metin(node) {
  if (node == null) return "";
  if (typeof node === "object") return String(node["#text"] ?? "").trim();
  return String(node).trim();
}

function kimlik(party, scheme) {
  const list = party?.PartyIdentification || [];
  const found = list.find((item) => item?.ID?.["@_schemeID"] === scheme);
  return metin((found || list[0])?.ID);
}

function parseMakbuz(xml) {
  const doc = parser.parse(xml);
  const note = doc?.CreditNote;
  if (!note || metin(note.CreditNoteTypeCode) !== "MUSTAHSILMAKBUZ") {
    throw new Error("Dosya e-müstahsil makbuzu değil.");
  }
  const supplier = note.AccountingSupplierParty?.Party || {};
  const customer = note.AccountingCustomerParty?.Party || {};
  const person = customer.Person || {};
  const uretici = [metin(person.FirstName), metin(person.FamilyName)].filter(Boolean).join(" ").replace(/\s+/g, " ").trim()
    || metin(customer.PartyName?.Name);
  const adres = customer.PostalAddress || {};
  const vergi = (note.TaxTotal?.TaxSubtotal || [])[0] || {};
  const kalemler = (note.CreditNoteLine || []).map((line) => {
    const miktarNode = line.CreditedQuantity;
    const unit = miktarNode?.["@_unitCode"] || "KGM";
    return {
      ad: metin(line.Item?.Name),
      miktar: Number(metin(miktarNode) || 0),
      birim: unit === "KGM" ? "KG" : unit,
      fiyat: Number(metin(line.Price?.PriceAmount) || 0),
      tutar: Number(metin(line.LineExtensionAmount) || 0),
      kunye: metin(line.Item?.AdditionalItemIdentification?.ID),
    };
  });
  const notlar = (note.Note || []).map(metin).filter(Boolean);
  return {
    belgeNo: metin(note.ID),
    tarih: metin(note.IssueDate),
    uuid: metin(note.UUID),
    duzenleyen: metin(supplier.PartyName?.Name),
    duzenleyenTc: kimlik(supplier, "TCKN") || kimlik(supplier, "VKN"),
    uretici,
    tckn: kimlik(customer, "TCKN"),
    ilce: metin(adres.CitySubdivisionName),
    il: metin(adres.CityName),
    matrah: Number(metin(note.LegalMonetaryTotal?.LineExtensionAmount) || 0),
    odenecek: Number(metin(note.LegalMonetaryTotal?.PayableAmount) || 0),
    stopaj: Number(metin(note.TaxTotal?.TaxAmount) || 0),
    stopajOran: Number(metin(vergi.Percent) || 0),
    not: notlar[0] || "",
    kalemler,
  };
}

function okuIstek(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 2_000_000) {
        reject(new Error("Dosya çok büyük."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function gonder(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(json);
}

function oturum(req) {
  const header = String(req.headers.authorization || "");
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  return token ? oturumlar.get(token) : null;
}

async function firmalar() {
  return queryJson(`
SET NOCOUNT ON;
SELECT IND AS no, KOD AS kod, ISNULL(KISAAD, N'') AS kisaAd, ISNULL(AD1, N'') AS ad
FROM TBLFIRMA
ORDER BY IND
FOR JSON PATH;
`);
}

async function kullanicilar() {
  return queryJson(`
SET NOCOUNT ON;
SELECT IND AS no, USERNAME AS kullanici, ISNULL(AD, N'') AS ad, ISNULL(SOYAD, N'') AS soyad,
  ISNULL(FIRMA, 0) AS firma, ISNULL(DONEM, 0) AS donem
FROM TBLUSERS
WHERE ISNULL(USERNAME, N'') <> N''
ORDER BY USERNAME
FOR JSON PATH;
`);
}

async function donemler(firma) {
  return queryJson(`
SET NOCOUNT ON;
SELECT IND AS no, DONEM AS yil
FROM TBLDONEM
WHERE FIND = ${firma}
ORDER BY DONEM
FOR JSON PATH;
`);
}

async function subeler(firma) {
  const ad = tablo(firma, null, "TBLKRDSUBELER");
  if (!(await tabloVar(ad))) return [];
  return queryJson(`
SET NOCOUNT ON;
SELECT IND AS no, SUBEADI AS ad
FROM ${ad}
WHERE ISNULL(SUBEADI, N'') <> N''
ORDER BY IND
FOR JSON PATH;
`);
}

async function kasalar(firma, subeNo) {
  const ad = tablo(firma, null, "TBLKRDKASALAR");
  if (!(await tabloVar(ad))) return [];
  const filtre = subeNo ? `AND SUBENO = ${subeNo}` : "";
  return queryJson(`
SET NOCOUNT ON;
SELECT IND AS no, SUBENO AS subeNo, SUBEADI AS sube, KASAADI AS ad
FROM ${ad}
WHERE ISNULL(KASAADI, N'') <> N''
${filtre}
ORDER BY IND
FOR JSON PATH;
`);
}

async function yerler(kullanici, firma) {
  return queryJson(`
SET NOCOUNT ON;
SELECT SUBEIND AS subeNo, SUBEADI AS sube, KASAIND AS kasaNo, KASAADI AS kasa
FROM TBLKULLANICISUBEAYARLARI
WHERE USERNAME COLLATE Latin1_General_CI_AS = N'${sqlText(kullanici, 80)}' COLLATE Latin1_General_CI_AS
  AND FIRMAIND = ${firma}
ORDER BY CASE WHEN ISNULL(VARSAYILANSUBE, 0) = 1 THEN 0 ELSE 1 END, KASAIND
FOR JSON PATH;
`);
}

async function donemBul(firma, yil) {
  const rows = await queryJson(`
SET NOCOUNT ON;
SELECT IND AS no, DONEM AS yil
FROM TBLDONEM
WHERE FIND = ${firma} AND DONEM = ${yil}
FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;
`);
  return rows[0] || null;
}

async function tabloVar(ad) {
  const rows = await queryJson(`
SET NOCOUNT ON;
SELECT 1 AS var
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_NAME = N'${sqlText(ad, 128)}'
FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;
`);
  return Boolean(rows[0]);
}

async function cariBul(firma, tckn, ad) {
  const cari = tablo(firma, null, "TBLCARI");
  const rows = await queryJson(`
SET NOCOUNT ON;
SELECT TOP 1 IND AS ind, FIRMAKODU AS kod, FIRMAADI AS ad
FROM ${cari}
WHERE REPLACE(ISNULL(VERGINO, N''), N' ', N'') = N'${sqlText(tckn, 20)}'
   OR FIRMAADI = N'${sqlText(ad, 120)}'
ORDER BY CASE WHEN REPLACE(ISNULL(VERGINO, N''), N' ', N'') = N'${sqlText(tckn, 20)}' THEN 0 ELSE 1 END
FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;
`);
  return rows[0] || null;
}

async function stokBul(firma, ad) {
  const stok = tablo(firma, null, "TBLSTOKLAR");
  const rows = await queryJson(`
SET NOCOUNT ON;
SELECT TOP 1 IND AS ind, STOKKODU AS kod, MALINCINSI AS ad
FROM ${stok}
WHERE MALINCINSI = N'${sqlText(ad, 120)}' AND ISNULL(DELETED, 0) = 0
FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;
`);
  return rows[0] || null;
}

async function depoNo(firma) {
  const depo = tablo(firma, null, "TBLDEPOLAR");
  if (!(await tabloVar(depo))) return 1;
  const rows = await queryJson(`
SET NOCOUNT ON;
SELECT TOP 1 IND AS ind FROM ${depo} ORDER BY IND
FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;
`);
  return Number(rows[0]?.ind || 1);
}

async function onizle(session, xml) {
  const makbuz = parseMakbuz(xml);
  const yil = Number(String(makbuz.tarih).slice(0, 4));
  if (session.yil && yil !== session.yil) {
    throw new Error(`Makbuz yılı ${yil}. Seçilen dönem ${session.yil}.`);
  }
  const donem = session.donem
    ? { no: session.donem, yil: session.yil }
    : await donemBul(session.firma, yil);
  const mus = donem ? await tabloVar(tablo(session.firma, donem.no, "TBLMUSORANLARI")) : false;
  const cari = await cariBul(session.firma, makbuz.tckn, makbuz.uretici);
  const kalemler = [];
  for (const kalem of makbuz.kalemler) {
    kalemler.push({ ...kalem, stok: await stokBul(session.firma, kalem.ad) });
  }
  let uyari = "";
  if (donem && mus) {
    const baslik = tablo(session.firma, donem.no, "TBLALFATBASLIK");
    const varMi = await queryJson(`
SET NOCOUNT ON;
SELECT TOP 1 IND AS ind FROM ${baslik} WHERE BELGENO = N'${sqlText(makbuz.belgeNo, 30)}'
FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;
`);
    if (varMi[0]) uyari = `${makbuz.belgeNo} daha önce aktarılmış. Yine de aktarılacak.`;
  }
  return { ...makbuz, donem, musTablolari: mus, cari, kalemler, uyari };
}

function stokKodu(ad, sira) {
  const temiz = String(ad || "")
    .replace(/[^0-9A-Za-zÇĞİÖŞÜçğıöşü]/g, "")
    .slice(0, 24);
  return temiz || `MM${sira}`;
}

async function aktar(session, xml) {
  const on = await onizle(session, xml);
  if (!on.donem) throw new Error(`${on.tarih.slice(0, 4)} dönemi bu firmada yok.`);
  if (!on.musTablolari) throw new Error("Bu firma ve dönemde müstahsil tabloları yok.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(on.tarih)) throw new Error("Makbuz tarihi okunamadı.");
  const cariTablo = tablo(session.firma, null, "TBLCARI");
  const stokTablo = tablo(session.firma, null, "TBLSTOKLAR");
  const birimTablo = tablo(session.firma, null, "TBLBIRIMLEREX");
  const baslik = tablo(session.firma, on.donem.no, "TBLALFATBASLIK");
  const hareket = tablo(session.firma, on.donem.no, "TBLALFATHAREKET");
  const oran = tablo(session.firma, on.donem.no, "TBLMUSORANLARI");
  const bilgi = tablo(session.firma, on.donem.no, "TBLMUSCARIBILGI");
  const cariHar = tablo(session.firma, on.donem.no, "TBLCARIHAREKETLERI");
  const cariGenel = tablo(session.firma, on.donem.no, "TBLCARIGENELHAREKET");
  const stokHar = tablo(session.firma, on.donem.no, "TBLSTOKHAREKETLERI");

  const depo = await depoNo(session.firma);
  const adres = [on.ilce, on.il].filter(Boolean).join(" / ");
  const parca = String(on.uretici || "").trim().split(/\s+/).filter(Boolean);
  const adi = parca[0] || "";
  const soyadi = parca.slice(1).join(" ");
  const stokSql = on.kalemler.map((kalem, index) => {
    const kod = stokKodu(kalem.ad, index + 1);
    return `
  IF NOT EXISTS (SELECT 1 FROM ${stokTablo} WHERE MALINCINSI = N'${sqlText(kalem.ad, 200)}' AND ISNULL(DELETED, 0) = 0)
  BEGIN
    DECLARE @kod${index} nvarchar(50) = N'${sqlText(kod, 40)}';
    IF EXISTS (SELECT 1 FROM ${stokTablo} WHERE STOKKODU = @kod${index})
      SET @kod${index} = LEFT(@kod${index}, 20) + N'-${index + 1}';
    INSERT INTO ${stokTablo} (STOKKODU, MALINCINSI, ALISKDVORANI, STATUS, DELETED)
    VALUES (@kod${index}, N'${sqlText(kalem.ad, 200)}', 0, 1, 0);
  END
  DECLARE @stok${index} int, @stokKod${index} nvarchar(200), @birim${index} int;
  SELECT TOP 1 @stok${index} = IND, @stokKod${index} = STOKKODU
  FROM ${stokTablo}
  WHERE MALINCINSI = N'${sqlText(kalem.ad, 200)}' AND ISNULL(DELETED, 0) = 0;
  SELECT TOP 1 @birim${index} = IND FROM ${birimTablo}
  WHERE STOKNO = @stok${index} AND BIRIMADI = N'${sqlText(kalem.birim, 10)}';
  IF @birim${index} IS NULL
  BEGIN
    INSERT INTO ${birimTablo} (
      BIRIMADI, CARPAN, BARCODESTD, STOKNO, SATISFIYATI, ACIKLAMA, KDV, KDVDAHIL, SPARABIRIMI,
      EN, BOY, YUKSEKLIK, AGIRLIK, HACIM, VARSAYILAN, ANABIRIM, ACIKLAMAIND, PB1, PB2, PB3, PB4, PB5, PB6
    ) VALUES (
      N'${sqlText(kalem.birim, 10)}', 1, 0, @stok${index}, 0, N'FIYAT', 0, 0, 1,
      0, 0, 0, 0, 0, 1, 1, 1, N'TL', N'TL', N'TL', N'TL', N'TL', N'TL'
    );
    SET @birim${index} = SCOPE_IDENTITY();
  END
  UPDATE ${birimTablo}
  SET VARSAYILAN = 1, ANABIRIM = 1
  WHERE IND = @birim${index};
  UPDATE ${stokTablo}
  SET ANABIRIM = CASE WHEN ISNULL(ANABIRIM, 0) = 0 THEN @birim${index} ELSE ANABIRIM END,
      BIRIMEX = CASE WHEN ISNULL(BIRIMEX, 0) = 0 THEN @birim${index} ELSE BIRIMEX END
  WHERE IND = @stok${index};
  INSERT INTO ${hareket} (
    TARIH, EVRAKNO, FIRMANO, STOKNO, STOKKODU, MALINCINSI, MIKTAR, BIRIMMIKTAR, BIRIM, BIRIMEX,
    KDV, FIYATI, AFIYATI, DEPO, PARABIRIMI, KUR, ACIKLAMA, GERCEKTOPLAM, SATIRNO,
    DETAY, STOKTIPI, ISK1, ISK2, ISK3, ISK4, ISK5, ISK6, PERSONEL, PIRIM, OPSIYON, PROMOSYON,
    SATISKOSULU, SERIMIKTAR, ENVANTER, MASRAF, OIV, INDIRIM, OTV, GK, GRUPMIKTAR,
    TEVKIFATUYG, TEVKIFATTUTAR, YS, KDVTUTAR
  ) VALUES (
    '${on.tarih}', @ind, @cari, @stok${index}, @stokKod${index}, N'${sqlText(kalem.ad, 200)}',
    ${sqlNum(kalem.miktar)}, 1, N'${sqlText(kalem.birim, 5)}', @birim${index},
    0, ${sqlNum(kalem.fiyat)}, ${sqlNum(kalem.fiyat)}, ${depo}, N'TL', 1,
    N'${sqlText(kalem.kunye, 80)}', ${sqlNum(kalem.tutar)}, ${index + 1},
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    1, 1, ${sqlNum(kalem.miktar)}, 0, 0, 0, 0, 0, 1,
    0, 0, 1, 0
  );
  DECLARE @satir${index} int = SCOPE_IDENTITY();
  INSERT INTO ${stokHar} (
    EVRAKNO, IZAHAT, TARIH, GIREN, CIKAN, TUTAR, FIRMANO, STOKNO, BELGENO, LN, DEPO,
    KDV, PERSONEL, IADE, OPSIYON, BIRIMFIYAT, BIRIMMALIYET, SIRALAMATARIHI, KUR, PARABIRIMI,
    BIRIMEX, STOKTIPI, SIRALAMATARIHIEX, GUNCELLEMETARIHI
  ) VALUES (
    N'${sqlText(on.belgeNo, 30)}', N'108', '${on.tarih}', ${sqlNum(kalem.miktar)}, 0, ${sqlNum(kalem.tutar)},
    @cari, @stok${index}, @ind, @satir${index}, ${depo},
    0, 0, 0, 0, ${sqlNum(kalem.fiyat)}, ${sqlNum(kalem.fiyat)}, @simdi, 1, N'TL',
    @birim${index}, 0, CAST(CAST(@simdi AS float) + 2 AS decimal(28,8)), @simdi
  );`;
  }).join("\n");

  const inserted = await queryJson(`
SET NOCOUNT ON;
BEGIN TRY
  BEGIN TRAN;
  DECLARE @yeni bit = 0;
  DECLARE @cari int;
  SELECT TOP 1 @cari = IND
  FROM ${cariTablo}
  WHERE REPLACE(ISNULL(VERGINO, N''), N' ', N'') = N'${sqlText(on.tckn, 15)}'
     OR FIRMAADI = N'${sqlText(on.uretici, 50)}'
  ORDER BY CASE WHEN REPLACE(ISNULL(VERGINO, N''), N' ', N'') = N'${sqlText(on.tckn, 15)}' THEN 0 ELSE 1 END;
  IF @cari IS NULL
  BEGIN
    SET @yeni = 1;
    INSERT INTO ${cariTablo} (
      FIRMAKODU, FIRMAADI, ADI, SOYADI, UNVAN, VERGINO, SEHIR, IL,
      ADRESFATURA, ADRESPOSTA, PARABIRIMI, FIRMATIPI, STATUS, DELETED,
      SATISYAPILMASIN, TAHSILATYAPILMASIN, ODEMEYAPILMASIN, ALISYAPILMASIN, SIPARISYAPILMASIN,
      IADEFATURASIKESILMESIN, BAGKURCALISMASIN, EFATURAKULLANICISI, ETICARET, EIRSALIYE,
      KDVMUAFIYATI, KREDILIMITIKONTROL, SMSGONDER, EMAILGONDER, ISLETMETURU,
      SUBEADI, KAYITTARIHI, RISKLIMITI, KREDILIMITI, ISKONTO, AYLIKVADE, OPSIYON,
      ZIMFIYAT, ODEMESEKLI, DEPOIND, EFATURASENARYO, EARSIVTESLIMTIPI, UID, GUNCELLEMETARIHI,
      STATU, TAKSITTIPI, TAKSITGUNU, SATISKARTI, ASKSATISKARTI, SEKTOR, MARKA, PERSONELNO,
      DEPO, PRIM, ODEMEBAKIYESI, BAKIYE, GECIKMEFAIZI, SERMAYE, HEDEFCIRO, CARIPOZISYON, KURTIPI
    )
    VALUES (
      N'${sqlText(on.tckn, 50)}',
      N'${sqlText(on.uretici, 50)}',
      N'${sqlText(adi, 40)}',
      N'${sqlText(soyadi, 40)}',
      N'${sqlText(on.uretici, 50)}',
      N'${sqlText(on.tckn, 15)}',
      N'${sqlText(on.il || adres, 25)}',
      N'${sqlText(on.il, 60)}',
      N'${sqlText(adres, 250)}',
      N'${sqlText(adres, 250)}',
      N'TL',
      1, 1, 0,
      0, 0, 0, 0, 0,
      0, 0, 0, 0, 0,
      0, 0, 1, 1, 2,
      N'${sqlText(session.sube || "MERKEZ", 50)}',
      GETDATE(), 0, 0, 0, 0, 0,
      0, 0, 1, 0, 2, CONVERT(nvarchar(40), NEWID()), GETDATE(),
      0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0
    );
    SET @cari = SCOPE_IDENTITY();
  END
  ELSE
  BEGIN
    UPDATE ${cariTablo}
    SET ADI = CASE WHEN ISNULL(ADI, N'') = N'' THEN N'${sqlText(adi, 40)}' ELSE ADI END,
        SOYADI = CASE WHEN ISNULL(SOYADI, N'') = N'' THEN N'${sqlText(soyadi, 40)}' ELSE SOYADI END,
        UNVAN = CASE WHEN ISNULL(UNVAN, N'') = N'' THEN N'${sqlText(on.uretici, 50)}' ELSE UNVAN END,
        PARABIRIMI = CASE WHEN ISNULL(PARABIRIMI, N'') = N'' THEN N'TL' ELSE PARABIRIMI END,
        FIRMATIPI = 1,
        STATUS = 1,
        DELETED = 0,
        SATISYAPILMASIN = 0,
        TAHSILATYAPILMASIN = 0,
        ODEMEYAPILMASIN = 0,
        ALISYAPILMASIN = 0,
        SIPARISYAPILMASIN = 0,
        IADEFATURASIKESILMESIN = 0,
        BAGKURCALISMASIN = 0,
        EFATURAKULLANICISI = 0,
        ETICARET = 0,
        EIRSALIYE = 0,
        KDVMUAFIYATI = 0,
        KREDILIMITIKONTROL = 0,
        SMSGONDER = 1,
        EMAILGONDER = 1,
        ISLETMETURU = 2,
        RISKLIMITI = ISNULL(RISKLIMITI, 0),
        KREDILIMITI = ISNULL(KREDILIMITI, 0),
        ISKONTO = ISNULL(ISKONTO, 0),
        AYLIKVADE = ISNULL(AYLIKVADE, 0),
        OPSIYON = ISNULL(OPSIYON, 0),
        ZIMFIYAT = ISNULL(ZIMFIYAT, 0),
        ODEMESEKLI = ISNULL(ODEMESEKLI, 0),
        DEPOIND = ISNULL(DEPOIND, 1),
        EFATURASENARYO = ISNULL(EFATURASENARYO, 0),
        EARSIVTESLIMTIPI = ISNULL(EARSIVTESLIMTIPI, 2),
        UID = CASE WHEN ISNULL(UID, N'') = N'' THEN CONVERT(nvarchar(40), NEWID()) ELSE UID END,
        GUNCELLEMETARIHI = ISNULL(GUNCELLEMETARIHI, GETDATE()),
        STATU = ISNULL(STATU, 0),
        TAKSITTIPI = ISNULL(TAKSITTIPI, 0),
        TAKSITGUNU = ISNULL(TAKSITGUNU, 0),
        SATISKARTI = ISNULL(SATISKARTI, 0),
        ASKSATISKARTI = ISNULL(ASKSATISKARTI, 0),
        SEKTOR = ISNULL(SEKTOR, 0),
        MARKA = ISNULL(MARKA, 0),
        PERSONELNO = ISNULL(PERSONELNO, 0),
        DEPO = ISNULL(DEPO, 0),
        PRIM = ISNULL(PRIM, 0),
        ODEMEBAKIYESI = ISNULL(ODEMEBAKIYESI, 0),
        BAKIYE = ISNULL(BAKIYE, 0),
        GECIKMEFAIZI = ISNULL(GECIKMEFAIZI, 0),
        SERMAYE = ISNULL(SERMAYE, 0),
        HEDEFCIRO = ISNULL(HEDEFCIRO, 0),
        CARIPOZISYON = ISNULL(CARIPOZISYON, 0),
        KURTIPI = ISNULL(KURTIPI, 0),
        IL = CASE WHEN ISNULL(IL, N'') = N'' THEN N'${sqlText(on.il, 60)}' ELSE IL END,
        ADRESFATURA = CASE WHEN DATALENGTH(ADRESFATURA) IS NULL OR DATALENGTH(ADRESFATURA) = 0 THEN N'${sqlText(adres, 250)}' ELSE ADRESFATURA END,
        SUBEADI = CASE WHEN ISNULL(SUBEADI, N'') = N'' THEN N'${sqlText(session.sube || "MERKEZ", 50)}' ELSE SUBEADI END
    WHERE IND = @cari;
  END
  DECLARE @ind int;
  INSERT INTO ${baslik} (
    FIRMAADI, TUTAR, ARATOPLAM, BELGENO, TARIH, ODEMETARIHI, KDV, ALTNOT,
    FIRMANO, PARABIRIMI, KUR, BELGETIPI, EKBELGETIPI, DEPO, HAREKETDEPOSU,
    EFATURA, EFATURANO, EFATURAUUID, EFATURANUMBER, GIRIS, IPTAL, IADE,
    STOKHAREKETEYAZ, CARIHAREKETEYAZ, ENVANTERUPDATE, USERNO, OZELKOD1, OZELKOD2,
    AK, ODMODIFIED, ALT1, ALT2, ALT3, ALT4, CONVERTED, YUVARLAMA, ALLOWYUVARLAMA, ODENEN,
    MASRAF1, MASRAF2, MASRAF3, MASRAF4, MASRAFKDV1, MASRAFKDV2, MASRAFKDV3, MASRAFKDV4,
    ENTEGRE, KDVISK, SATISSEKLI, YURTDISI, MUHASEBELESMEYECEK, KAYNAK, KDVYUVARLAMA, TEVKIFATISTISNA
  )
  VALUES (
    N'${sqlText(on.uretici, 20)}', ${sqlNum(on.odenecek)}, ${sqlNum(on.matrah)},
    N'${sqlText(on.belgeNo, 30)}', '${on.tarih}', '${on.tarih}', 0,
    N'${sqlText(on.not, 400)}', @cari, N'TL', 1, 108, 0,
    ${depo}, ${depo}, 1, N'${sqlText(on.belgeNo, 30)}', N'${sqlText(on.uuid, 60)}',
    N'${sqlText(on.belgeNo, 30)}', 1, 0, 0, 1, 1, 0, ${Number(session.no)},
    N'${sqlText(session.sube || "MERKEZ", 15)}', N'${sqlText(session.kasa || "MERKEZ", 15)}',
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0
  );
  SET @ind = SCOPE_IDENTITY();
  DECLARE @simdi datetime = GETDATE();
  ${stokSql}
  INSERT INTO ${oran} (BELGENO, STOPAJ, STOPAJORANSAL, BAGKUR, BAGKURORANSAL, BORSA, BORSAORANSAL, SSDF, KOMISYON, KDV)
  VALUES (@ind, ${sqlNum(on.stopajOran)}, 1, 0, 1, 0, 1, 0, 0, 0);
  INSERT INTO ${bilgi} (BELGENO, SATICIADI, ADRES)
  VALUES (@ind, N'${sqlText(on.uretici, 40)}', N'${sqlText(adres, 250)}');
  INSERT INTO ${cariHar} (
    FIRMANO, TARIH, IZAHAT, EVRAKNO, BORC, ALACAK, IADE, LN,
    PARABIRIMI, KUR, ODEMETARIHI, ISLEMTARIHI, SIRALAMATARIHI, SIRALAMATARIHIEX, OZELKOD1, OZELKOD2
  )
  VALUES (
    @cari, '${on.tarih}', N'108', N'${sqlText(on.belgeNo, 30)}', 0, ${sqlNum(on.odenecek)}, 0, @ind,
    N'TL', 1, '${on.tarih}', @simdi, @simdi, CAST(CAST(@simdi AS float) + 2 AS decimal(28,8)),
    N'${sqlText(session.sube || "MERKEZ", 15)}', N'${sqlText(session.kasa || "MERKEZ", 15)}'
  );
  INSERT INTO ${cariGenel} (
    FIRMANO, TARIH, VADE, BELGEIND, ISLEMIND, BELGEIZAHAT, ISLEMIZAHAT,
    BORC, ALACAK, AYLIKVADE, BELGENO, ISLEMNO, CONVERTED, IPTAL,
    SIRALAMATARIHI, PARABIRIMI, KUR, BASLIKPARABIRIMI, BASLIKKURU, ACIKLAMA, SIRALAMATARIHIEX
  )
  VALUES (
    @cari, '${on.tarih}', '${on.tarih}', @ind, @ind, 108, 108,
    0, ${sqlNum(on.odenecek)}, 0, N'${sqlText(on.belgeNo, 30)}', N'${sqlText(on.belgeNo, 30)}', 0, 0,
    @simdi, N'TL', 1, N'TL', 1, N'', CAST(CAST(@simdi AS float) + 2 AS decimal(28,8))
  );
  COMMIT;
  SELECT @ind AS ind, N'${sqlText(on.belgeNo, 30)}' AS belgeNo, @cari AS cariNo, @yeni AS cariYeni
  FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK;
  THROW;
END CATCH
`);
  return {
    ok: true,
    ...inserted[0],
    firma: session.firma,
    donem: on.donem,
    uretici: on.uretici,
    odenecek: on.odenecek,
    stopaj: on.stopaj,
    uyari: on.uyari || "",
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  try {
    if (req.method === "GET" && url.pathname === "/") {
      const html = readFileSync(join(root, "public", "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(html);
      return;
    }
    if (req.method === "GET" && url.pathname === "/ayar") {
      gonder(res, 200, { sunucu: baglanti.server, veritabani, kaynak: baglanti.source });
      return;
    }
    if (req.method === "GET" && url.pathname === "/veritabanlari") {
      gonder(res, 200, { items: await veritabanlari() });
      return;
    }
    if (req.method === "POST" && url.pathname === "/baglanti") {
      const body = JSON.parse(await okuIstek(req) || "{}");
      const ad = dbAdi(body.veritabani);
      if (!ad) {
        gonder(res, 400, { error: "Veritabanı seçin." });
        return;
      }
      const sonuc = await baglantiDene(ad);
      if (!sonuc) {
        gonder(res, 500, { error: "Bağlantı denemesi sonuç vermedi." });
        return;
      }
      gonder(res, 200, sonuc);
      return;
    }
    if (req.method === "POST" && url.pathname === "/ayar") {
      const body = JSON.parse(await okuIstek(req) || "{}");
      const ad = dbAdi(body.veritabani);
      if (!ad) {
        gonder(res, 400, { error: "Veritabanı seçin." });
        return;
      }
      const sonuc = await baglantiDene(ad);
      if (!sonuc?.vega) {
        gonder(res, 400, { error: "Bağlantı oldu ama bu veritabanında Vega firma tablosu yok." });
        return;
      }
      veritabani = ad;
      writeFileSync(ayarDosya, JSON.stringify({ veritabani: ad }, null, 2));
      gonder(res, 200, { sunucu: sonuc.sunucu, veritabani: sonuc.veritabani });
      return;
    }
    if (req.method === "GET" && url.pathname === "/firmalar") {
      gonder(res, 200, { items: await firmalar() });
      return;
    }
    if (req.method === "GET" && url.pathname === "/kullanicilar") {
      gonder(res, 200, { items: await kullanicilar() });
      return;
    }
    if (req.method === "GET" && url.pathname === "/donemler") {
      const firma = firmaNo(url.searchParams.get("firma"));
      if (!firma) {
        gonder(res, 400, { error: "Firma seçin." });
        return;
      }
      gonder(res, 200, { items: await donemler(firma) });
      return;
    }
    if (req.method === "GET" && url.pathname === "/subeler") {
      const firma = firmaNo(url.searchParams.get("firma"));
      if (!firma) {
        gonder(res, 400, { error: "Firma seçin." });
        return;
      }
      gonder(res, 200, { items: await subeler(firma) });
      return;
    }
    if (req.method === "GET" && url.pathname === "/kasalar") {
      const firma = firmaNo(url.searchParams.get("firma"));
      if (!firma) {
        gonder(res, 400, { error: "Firma seçin." });
        return;
      }
      gonder(res, 200, { items: await kasalar(firma, firmaNo(url.searchParams.get("sube"))) });
      return;
    }
    if (req.method === "GET" && url.pathname === "/yer") {
      const firma = firmaNo(url.searchParams.get("firma"));
      const kullanici = sqlText(url.searchParams.get("kullanici"), 80).trim();
      if (!firma || !kullanici) {
        gonder(res, 400, { error: "Kullanıcı ve firma seçin." });
        return;
      }
      gonder(res, 200, { items: await yerler(kullanici, firma) });
      return;
    }
    if (req.method === "POST" && url.pathname === "/giris") {
      const body = JSON.parse(await okuIstek(req) || "{}");
      const kullanici = sqlText(body.kullanici, 80).trim();
      const firma = firmaNo(body.firma);
      const donem = firmaNo(body.donem);
      if (!kullanici || !firma || !donem) {
        gonder(res, 400, { error: "Kullanıcı, firma ve dönem seçin." });
        return;
      }
      const rows = await queryJson(`
SET NOCOUNT ON;
SELECT TOP 1 IND AS no, USERNAME AS kullanici, ISNULL(AD, N'') AS ad, ISNULL(SOYAD, N'') AS soyad
FROM TBLUSERS
WHERE USERNAME COLLATE Latin1_General_CI_AS = N'${kullanici}' COLLATE Latin1_General_CI_AS
FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;
`);
      const user = rows[0];
      if (!user) {
        gonder(res, 401, { error: "Kullanıcı bulunamadı." });
        return;
      }
      const firmaKaydi = (await firmalar()).find((item) => Number(item.no) === firma);
      const donemKaydi = (await donemler(firma)).find((item) => Number(item.no) === donem);
      if (!firmaKaydi || !donemKaydi) {
        gonder(res, 400, { error: "Seçilen firma veya dönem bulunamadı." });
        return;
      }
      const token = randomBytes(24).toString("hex");
      const firmaAd = firmaKaydi.kisaAd || firmaKaydi.kod;
      oturumlar.set(token, {
        no: user.no,
        kullanici: user.kullanici,
        firma,
        firmaAd,
        donem,
        yil: Number(donemKaydi.yil),
        sube: sqlText(body.sube, 40),
        kasa: sqlText(body.kasa, 40),
      });
      gonder(res, 200, {
        token,
        kullanici: user.kullanici,
        ad: [user.ad, user.soyad].filter(Boolean).join(" "),
        firma,
        firmaAd,
        donem,
        yil: Number(donemKaydi.yil),
      });
      return;
    }

    const session = oturum(req);
    if (!session) {
      gonder(res, 401, { error: "Giriş gerekli." });
      return;
    }
    if (req.method === "POST" && url.pathname === "/onizle") {
      gonder(res, 200, await onizle(session, await okuIstek(req)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/aktar") {
      gonder(res, 200, await aktar(session, await okuIstek(req)));
      return;
    }
    gonder(res, 404, { error: "Sayfa bulunamadı." });
  } catch (error) {
    gonder(res, 500, { error: error.message || "İşlem yapılamadı." });
  }
});

export function start(port = PORT) {
  return new Promise((resolveListen, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      resolveListen(port);
    });
  });
}

export function stop() {
  return new Promise((resolveStop) => {
    if (!server.listening) {
      resolveStop();
      return;
    }
    server.close(() => resolveStop());
  });
}

const dogrudan = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (dogrudan) {
  start()
    .then((port) => {
      console.log(`http://127.0.0.1:${port}`);
    })
    .catch((error) => {
      console.error(error.message || error);
      process.exit(1);
    });
}
