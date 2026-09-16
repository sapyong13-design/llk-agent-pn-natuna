# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Pegawai Pengadilan Negeri Natuna — saat ini pembuat + rekan sekantor, target ke depan dipakai semua pegawai. Situasi: hari kerja di kantor, campuran siang–malam (AC, layar pribadi), tugas rutin: isi & kirim LLK harian lewat SSO.

## Product Purpose

Otomasi pengisian dan pengiriman LLK harian: login SSO sekali per profil, pilih rentang tanggal di kalender kerja 2026 (libur nasional, cuti bersama SKB 3 Menteri, Sabtu/Minggu otomatis dilewati), pratinjau isian per hari, lalu verifikasi & kirim tanpa membuka situs LLK.

## Positioning

Agent lokal yang memakai sesi browser asli pegawai (profil Edge terpisah per pegawai): membaca dan mengisi LLK resmi atas nama pengguna. Semua data — cookie SSO, profil, log — tinggal di folder lokal `data/`; tidak ada server eksternal selain situs LLK resmi.

## Operating Context

- Windows + Microsoft Edge + Node.js 20+, dijalankan via `LLK Agent.cmd` → `http://127.0.0.1:4545`.
- Pemakaian campuran siang–malam; desain harus nyaman di keduanya.
- Istilah resmi yang dipakai pegawai: LLK, Satker, SSO, atasan langsung, NIP (18 digit).

## Capabilities and Constraints

- Workflow boleh dirapikan; fitur dan aturan tetap (persetujuan pengguna 15 September 2026). Dua pilihan utama: Buat LLK dan Verifikasi LLK Anggota. Sesi SSO tersedia dari header; satu tahap kerja tampil. Buat LLK tetap melalui tanggal, pratinjau/edit, dan konfirmasi kirim. Verifikasi melalui daftar, pesan, tindakan, dan hasil. Istilah resmi tetap.
- Pintu masuk memakai akun terakhir pada browser lokal. Sesi aktif langsung menampilkan pilihan pekerjaan tanpa tombol Lanjut; kedaluwarsa meminta login; error pemeriksaan menawarkan coba lagi. Pemilih akun berpencarian menjadi satu akses akun. Ganti pekerjaan mempertahankan draf, sedangkan pergantian akun meminta konfirmasi dan menghapus konteks draf sebelumnya. Tahap tampil sebagai indikator, bukan tombol navigasi duplikat. Hasil menggantikan formulir tindakan; tombol verifikasi menyebut jumlah LLK siap.
- Profil per pegawai = konteks browser terpisah; nama, satker, atasan dibaca otomatis dari akun SSO.
- Sumber kegiatan: kegiatan unik dari halaman terakhir akun, atau template umum per bagian pengadilan.
- Verifikasi LLK anggota & kirim dari dalam aplikasi; log & laporan lokal (JSON, bisa diekspor).
- Otomasi hanya jalan di Edge; cookie sesi lokal di `data/`.

## Brand Commitments

- Nama "LLK Agent — Pengadilan Negeri Natuna".
- Footer: "dibuat karena **males nulis LLK tiap hari**", link github.com/sapyong13-design.
- Bahasa Indonesia untuk seluruh UI.

## Evidence on Hand

- `docs/screenshot-main.png` (tampilan lama), `README.md` (fitur terkonfirmasi), aplikasi hidup di `http://127.0.0.1:4545`.
- Tidak ada aset logo resmi; identitas visual saat ini murni CSS.

## Product Principles

1. Selesai dalam semenit: tujuan tiap sesi adalah LLK terkirim, bukan menjelajah.
2. Percaya tapi verifikasi: pratinjau selalu tampil sebelum kirim.
3. Data pegawai tidak pernah meninggalkan mesin lokal.
4. Istilah resmi tidak pernah diparafrasekan.

## Accessibility & Inclusion

Dipakai pegawai lintas usia dan tingkat kebiasaan digital: kontras kuat di kondisi siang & malam, target sentuh lega, fokus keyboard selalu terlihat.
