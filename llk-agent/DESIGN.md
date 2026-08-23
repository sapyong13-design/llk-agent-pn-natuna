---
name: LLK Agent — PN Natuna
description: Dokumen dinas hidup untuk otomasi LLK harian.
colors:
  seal-red: "#a72a25"
  seal-red-deep: "#7f1f1b"
  official-blue: "#1e3a6d"
  official-blue-deep: "#12294f"
  ink-blue-black: "#14202b"
  security-paper: "#f4f5f0"
  security-paper-bright: "#fbfcf8"
  security-paper-shadow: "#e8ebe5"
  rule-gray: "#aeb8b8"
  muted-ink: "#596873"
  verified-green: "#236142"
typography:
  display:
    fontFamily: "Marcellus, Georgia, serif"
    fontSize: "clamp(2.5rem, 6vw, 4.5rem)"
    fontWeight: 400
    lineHeight: 0.92
    letterSpacing: "-0.035em"
  body:
    fontFamily: "Public Sans, Segoe UI, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.58
  data:
    fontFamily: "JetBrains Mono, Consolas, monospace"
    fontWeight: 600
rounded:
  document: "0px"
  fine: "2px"
  seal: "50%"
spacing:
  tight: "8px"
  field: "14px"
  sheet: "24px"
  section: "32px"
components:
  button-primary:
    backgroundColor: "{colors.seal-red-deep}"
    textColor: "#ffffff"
    rounded: "{rounded.document}"
    padding: "8px 17px"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.ink-blue-black}"
    rounded: "{rounded.document}"
    padding: "8px 17px"
  document-sheet:
    backgroundColor: "{colors.security-paper-bright}"
    textColor: "{colors.ink-blue-black}"
    rounded: "{rounded.document}"
    padding: "22px 24px"
---

# Design System: LLK Agent — PN Natuna

## Overview

**Creative North Star: "Stempel & Tinta Dinas"**

LLK Agent terlihat seperti dokumen dinas yang hidup, bukan dashboard SaaS. Dunia visual berasal dari security printing dokumen resmi Indonesia: kertas terang, tinta biru-hitam, kop naskah, guilloche, microtext, perforasi, dan stempel merah sebagai bahasa status.

Antarmuka padat tetapi terdaftar rapi. Pengguna selalu melihat posisi pada alur tiga lembar: masuk SSO, pilih tanggal, periksa & kirim. Identitas resmi tetap manusiawi lewat judul berkarakter, humor footer, dan gerak stempel yang hanya muncul saat berhasil.

**Key Characteristics:**
- Lembar kerja bertumpuk, garis registrasi, dan kode formulir.
- Satu aksen merah stempel; biru resmi bertindak sebagai tinta struktural.
- Angka tanggal, waktu, dan NIP selalu tabular.
- Mode gelap otomatis mempertahankan metafora dokumen untuk pemakaian malam.
- Tidak ada kartu SaaS membulat, glassmorphism, gradient text, atau ikon dekoratif generik.

## Colors

Palet restrained: netral kertas + tinta biru-hitam + satu aksen status merah.

### Primary
- **Seal Red** (`#a72a25`): status aktif, pemilihan tanggal, fokus, dan tindakan utama.
- **Seal Red Deep** (`#7f1f1b`): permukaan tombol utama sebelum hover.

### Secondary
- **Official Blue** (`#1e3a6d`): navigasi, tautan, pilihan struktural, dan aturan identitas.
- **Official Blue Deep** (`#12294f`): tombol utilitas dan header kalender.

### Neutral
- **Ink Blue-Black** (`#14202b`): teks dan garis dokumen utama.
- **Security Paper** (`#f4f5f0`), **Bright** (`#fbfcf8`), **Shadow** (`#e8ebe5`): bidang dasar, lembar aktif, lembar pasif.
- **Rule Gray** (`#aeb8b8`): garis tabel dan pemisah.
- **Muted Ink** (`#596873`): keterangan sekunder.

**The Seal Rule.** Merah hanya menandai keputusan, status, atau fokus. Jangan menyebarkannya sebagai dekorasi.

## Typography

**Display Font:** Marcellus (fallback Georgia)
**Body Font:** Public Sans (fallback Segoe UI)
**Data Font:** JetBrains Mono (fallback Consolas)

Marcellus memberi rasa ukiran dokumen tanpa menjadi nostalgia dekoratif. Public Sans menjaga operasi padat tetap jelas. JetBrains Mono hanya untuk data yang perlu sejajar: tanggal, waktu, NIP, kode form, microtext.

- **Display:** 400, `clamp(40px, 6vw, 72px)`, line-height .92.
- **Step heading:** 400, `clamp(23px, 3vw, 34px)`, line-height 1.08.
- **Body:** 400, 14px/1.58; penjelasan dibatasi sekitar 72 karakter.
- **Label:** 600, 9–10px mono, uppercase, tracking .1–.14em.

## Layout

Kontainer maksimum 1180px. Header memakai kop naskah dua kolom; di bawah 760px berubah menjadi satu kolom. Workflow adalah tiga lembar terdaftar: lembar aktif naik dengan bayangan ambient dan pita merah tipis; lembar pasif merapat seperti arsip di bawahnya.

Kalender mempertahankan tujuh kolom pada semua ukuran. Pada 390px, tanggal mengecil tetapi struktur tidak berubah. Mode/source options menjadi satu kolom di bawah 760px. Pada 414px, rentang tanggal, ringkasan, dan daftar aktivitas menjadi satu kolom.

## Elevation & Depth

Depth bersifat struktural. Hanya kop naskah dan lembar aktif mendapat lift ambient dengan offset dan blur; kartu hari, hasil, dan panel data tetap datar seperti cetakan di atas kertas. Mode gelap memakai bayangan hitam lebih padat, bukan halo warna.

## Shapes

Sudut dokumen dan kontrol hampir selalu persegi (`0–2px`). Lingkaran hanya untuk nomor langkah dan metafora cap resmi. Garis ganda menandai batas dokumen besar; garis putus-putus menandai konfirmasi/perforasi.

## Components

- **Header/kop:** kode form, judul Marcellus, pita tanda merah-biru, microtext, watermark PN.
- **Workflow sheet:** kode `FORM LLK-0N`, nomor berbentuk cap, pita merah 3px pada lembar aktif.
- **Buttons:** persegi, biru untuk utilitas, merah untuk tindakan utama/destruktif; fokus 3px merah dengan offset 3px.
- **Calendar:** header biru tua, sel terdaftar, tanggal mono; awal/akhir rentang memakai merah penuh.
- **Status:** label mono, uppercase, sedikit berotasi seperti cap. Sukses menerima satu animasi `stamp-land`; hormati `prefers-reduced-motion`.
- **Inputs/tables:** garis bawah lebih gelap; tabel dan data numerik tabular.
- **Browser surfaces:** selection, scrollbar, caret/focus mengikuti palet.

## Do's and Don'ts

- **Do** pertahankan alur tiga langkah dan istilah resmi LLK, Satker, SSO, atasan langsung.
- **Do** gunakan geometri identik untuk kartu hari agar mudah dibandingkan.
- **Do** gunakan warna dan gerak untuk keadaan yang nyata.
- **Do** self-host aset; aplikasi lokal tidak boleh meminta aset visual dari pihak ketiga.
- **Don't** memakai rounded card generik, glass, glow, gradient text, atau grid dekoratif.
- **Don't** memakai mono untuk prosa atau sebagai kostum teknis.
- **Don't** membuat animasi masuk pada setiap elemen; stempel sukses adalah satu-satunya momen utama.
- **Don't** melemahkan kontras atau menghapus mode malam otomatis.
