# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Pegawai Pengadilan Negeri Natuna — saat ini pembuat + rekan sekantor, target ke depan dipakai semua pegawai. Situasi: hari kerja di kantor, campuran siang–malam (AC, layar pribadi), tugas rutin: isi & kirim LLK harian lewat SSO.

## Product Purpose

Otomasi pengisian dan pengiriman LLK harian: login SSO sekali per profil, pilih rentang tanggal di kalender kerja 2026 (libur nasional, cuti bersama SKB 3 Menteri, Sabtu/Minggu otomatis dilewati), pratinjau isian per hari, lalu verifikasi & kirim tanpa membuka situs LLK.

## Positioning

Agent lokal atau hosting HTTPS dengan seluruh operasi LLK melalui HTTP dan cookie sesi dalam memori server aplikasi. Password dan kode authenticator diteruskan ke SSO resmi tanpa disimpan. Tidak ada browser otomatis pada runtime; laporan dan audit tinggal di folder data privat server.

## Operating Context

- Node.js 20.19+, browser biasa untuk UI; lokal via `LLK Agent.cmd` pada `http://127.0.0.1:4545`, produksi `https://llk.pn-natuna.go.id` lewat CloudLinux/LiteSpeed Node.js 24.21.0 dan `passenger.cjs`. Runtime tidak memerlukan Edge/Chromium.
- Pemakaian campuran siang–malam; desain harus nyaman di keduanya.
- Istilah resmi yang dipakai pegawai: LLK, Satker, SSO, atasan langsung, NIP (18 digit).

## Capabilities and Constraints

- Workflow boleh dirapikan; fitur dan aturan tetap (persetujuan pengguna 15 September 2026). Dua pilihan utama: Buat LLK dan Verifikasi LLK Anggota. Sesi SSO tersedia dari header; satu tahap kerja tampil. Buat LLK tetap melalui tanggal, pratinjau/edit, dan konfirmasi kirim. Verifikasi melalui daftar, pesan, tindakan, dan hasil. Istilah resmi tetap.
- Pintu masuk: nama pengguna/password SSO dan NIP atasan langsung 18 digit; kode authenticator muncul jika CAS meminta MFA. Identitas dan kegiatan dibaca otomatis setelah sesi terbukti. Cookie aplikasi acak mengikat state ke browser; tab satu profil browser berbagi sesi, profil browser berbeda terisolasi. Akhiri sesi hanya menghapus sesi pemiliknya; UI membersihkan draf dan log. Login/MFA tertunda berakhir setelah 10 menit; sesi kedaluwarsa setelah 30 menit tanpa aktivitas API.
- Log aktivitas tetap terbuka, kronologis, dengan penyamaran token dan gulir mengikuti hanya saat pembaca berada di bawah. Daftar kegiatan berada dekat sumber isian.
- Identitas pegawai, cookie, dan template pribadi baru hanya dalam memori proses. Data profil lama tidak dipakai dan tidak dihapus. Laporan pengiriman serta audit lokal tetap disimpan.
- Sumber kegiatan: kegiatan unik dari satu halaman akun yang memuat tanggal kegiatan paling baru, dipilih setelah seluruh halaman diperiksa tanpa mengasumsikan urutan pagination; bukan nomor halaman terbesar. Pilihan lain: template umum per bagian pengadilan.
- Verifikasi LLK anggota & kirim dari dalam aplikasi; log & laporan lokal (JSON, bisa diekspor).
- Profil, lookup atasan, riwayat, seluruh tanggal terisi, kirim LLK, dan verifikasi anggota menggunakan HTTP. CSRF dimuat baru sebelum kirim; hasil harus dibaca kembali. POST tidak dicoba ulang otomatis. Cookie SSO, template, cache, progres, token tahap, dan lock dipisahkan per sesi, termasuk sesi NIP sama; laporan tiap pengiriman mempunyai nama unik. Kedaluwarsa menunggu operasi yang sudah berjalan selesai sebelum client ditutup.
- `ponytail:` state hanya memori satu proses Node.js. Hosting mengunci satu worker melalui LSAPI_CHILDREN=1 dan flock Linux privat; worker kedua ditolak. Restart meminta login ulang; scale multi-process memerlukan store bersama dan lock terdistribusi. HTTPS/Host/Origin/proxy secret ketat, cookie Secure, dan batas sesi/percobaan login publik aktif. Default lokal tetap loopback. Node.js 16 tidak didukung.
- Operasi upstream publik maksimum 8 bersamaan, 20/sesi/10 menit, 200/IP/10 menit; cache kalender dan progres tidak dihitung. 429 sebelum upstream, Retry-After tanpa retry otomatis. DNS tetap IDwebhost, tidak ada gateway pegawai. Mitigasi DDoS volumetrik membutuhkan penyedia dan belum terverifikasi dari cPanel akun.

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
