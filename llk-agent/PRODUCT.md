# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Pegawai Pengadilan Negeri Natuna — saat ini pembuat + rekan sekantor, target ke depan dipakai semua pegawai. Situasi: hari kerja di kantor, campuran siang–malam (AC, layar pribadi), tugas rutin: isi & kirim LLK harian lewat SSO.

## Product Purpose

Otomasi pengisian dan pengiriman LLK harian: login SSO sekali per profil, pilih rentang tanggal di kalender kerja 2026 (libur nasional, cuti bersama SKB 3 Menteri, Sabtu/Minggu otomatis dilewati), pratinjau isian per hari, lalu verifikasi & kirim tanpa membuka situs LLK.

## Positioning

Agent lokal dengan seluruh operasi LLK melalui HTTP dan cookie sesi dalam memori. Password dan kode authenticator diteruskan ke SSO resmi tanpa disimpan. Tidak ada browser otomatis pada runtime; laporan dan audit tinggal di folder lokal `data/`.

## Operating Context

- Node.js 20.19+, browser biasa untuk UI, dijalankan via `LLK Agent.cmd` → `http://127.0.0.1:4545`; tidak memerlukan Edge/Chromium pada runtime.
- Pemakaian campuran siang–malam; desain harus nyaman di keduanya.
- Istilah resmi yang dipakai pegawai: LLK, Satker, SSO, atasan langsung, NIP (18 digit).

## Capabilities and Constraints

- Workflow boleh dirapikan; fitur dan aturan tetap (persetujuan pengguna 15 September 2026). Dua pilihan utama: Buat LLK dan Verifikasi LLK Anggota. Sesi SSO tersedia dari header; satu tahap kerja tampil. Buat LLK tetap melalui tanggal, pratinjau/edit, dan konfirmasi kirim. Verifikasi melalui daftar, pesan, tindakan, dan hasil. Istilah resmi tetap.
- Pintu masuk: nama pengguna/password SSO dan NIP atasan langsung 18 digit; kode authenticator muncul jika CAS meminta MFA. Identitas dan kegiatan dibaca otomatis setelah sesi terbukti. Tidak ada pemilih akun tersimpan. Refresh meneruskan sesi runtime dan tahap MFA; Akhiri sesi menghapus identitas, cookie, dan draf sementara. Login tertunda berakhir setelah 10 menit.
- Log aktivitas tetap terbuka, kronologis, dengan penyamaran token dan gulir mengikuti hanya saat pembaca berada di bawah. Daftar kegiatan berada dekat sumber isian.
- Identitas pegawai, cookie, dan template pribadi baru hanya dalam memori proses. Data profil lama tidak dipakai dan tidak dihapus. Laporan pengiriman serta audit lokal tetap disimpan.
- Sumber kegiatan: kegiatan unik dari halaman terakhir akun, atau template umum per bagian pengadilan.
- Verifikasi LLK anggota & kirim dari dalam aplikasi; log & laporan lokal (JSON, bisa diekspor).
- Profil, lookup atasan, riwayat, seluruh tanggal terisi, kirim LLK, dan verifikasi anggota menggunakan HTTP. CSRF dimuat baru sebelum kirim; hasil harus dibaca kembali. POST tidak dicoba ulang otomatis. Sesi berakhir ketika proses LLK Agent berhenti, bukan ketika tab ditutup.

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
