# LLK Agent — PN Natuna

Otomasi pengisian LLK harian untuk pegawai Pengadilan Negeri Natuna — dibuat karena **males nulis LLK tiap hari**.

![Tampilan LLK Agent](docs/screenshot-main.png)

## Fitur

- **Pratinjau isian LLK per rentang tanggal** — sumber kegiatan default adalah kegiatan unik dari halaman terakhir akun LLK kamu; alternatifnya template umum per bagian pengadilan.
- **Kalender kerja 2026** — libur nasional, cuti bersama (SKB 3 Menteri 2026), dan Sabtu/Minggu ditandai langsung di kalender; hari nonkerja otomatis dilewati saat menyusun isian.
- **Profil per pegawai** — konteks browser terpisah; nama, satker, dan atasan dibaca otomatis dari akun SSO.
- **Verifikasi & kirim** — cek daftar verifikasi dari atasan langsung dan kirim LLK tanpa buka situs.
- **Log & laporan lokal** — riwayat aktivitas dan hasil kirim tersimpan di folder data lokal.

## Menjalankan

Prasyarat: [Node.js](https://nodejs.org) 20.19+ dan browser biasa untuk membuka UI. Runtime tidak membutuhkan Edge, Chromium, Playwright, atau desktop server.

```bash
cd llk-agent
npm install
npm start
```

Atau cukup jalankan dua-klik `LLK Agent.cmd` di folder utama, lalu buka <http://127.0.0.1:4545>.

Pertama kali:

1. Isi **Nama pengguna SSO**, **Password SSO**, dan NIP atasan langsung (18 digit), lalu klik **Login SSO**.
2. Jika SSO meminta MFA, kolom **Kode authenticator** muncul. Masukkan kode terbaru, lalu klik **Verifikasi kode authenticator**. Kode salah dapat dicoba kembali tanpa mengulang password selama sesi login masih aktif.
3. Identitas, atasan, dan kegiatan dibaca otomatis setelah autentikasi berhasil. Periksa identitas pemeriksa sebelum mengirim LLK.

Branch `built-in-auth` memakai HTTP langsung untuk autentikasi CAS, MFA, profil/atasan, kegiatan, kalender, kirim LLK, dan verifikasi anggota. Tidak ada browser otomatis pada runtime. Playwright hanya dependensi pengembangan untuk smoke UI. Tantangan login yang belum didukung, termasuk pendaftaran MFA, harus diselesaikan di SSO resmi. Aplikasi masih satu sesi lokal, bukan layanan multi-pengguna atau deploy Vercel siap pakai.

Login yang belum selesai berakhir setelah 10 menit. Refresh dapat melanjutkan tahap authenticator selama proses agent tetap hidup. Klik **Akhiri sesi** untuk membuang sesi; restart juga menghapusnya.

Form authenticator CAS memakai `token` dan `accountId`; pada halaman SSO saat ini `accountId` diisi oleh JavaScript inline. Klien HTTP membaca deklarasi numeriknya tanpa menjalankan script upstream. Regresi memastikan pilihan akun MFA ikut dikirim, termasuk saat kode dicoba ulang.

Kalender membaca seluruh halaman daftar LLK, menampilkan jumlah halaman dan waktu pembacaan. Tanggal tanpa label Terisi hanya dianggap belum terisi setelah pemindaian lengkap; pembacaan gagal tidak dianggap kosong. Sumber kegiatan default tetap halaman terakhir. Sebelum kirim, tanggal duplikat diperiksa pada seluruh halaman. Setiap tanggal memakai form/CSRF baru; keberhasilan harus terbukti dari tanggal dan isi yang terbaca kembali. Verifikasi anggota memindai filter Belum Terverifikasi, menahan target tidak valid, lalu memeriksa status dan pesan tersimpan setelah kirim. POST tidak dicoba ulang otomatis jika gagal atau hasil belum pasti.

Status verifikasi dibaca dari label daftar resmi, bukan hidden `verified=2` pada form edit. Field tersebut adalah tindakan yang akan dikirim dan dapat bernilai 2 ketika LLK masih Belum Terverifikasi. Pemeriksaan sebelum/sesudah POST mencocokkan ID numerik `hllk` dari form edit pada seluruh halaman daftar, bukan kesamaan URL `cid`; pesan juga dibaca kembali. Regresi memakai hidden `verified=2` dan URL `cid` berbeda sebelum/sesudah kirim.

Verifikasi memakai satu snapshot status sebelum batch dan satu setelah batch, bukan pemindaian ulang untuk setiap target. ID `hllk` tetap dicocokkan; form/CSRF dimuat baru tepat sebelum setiap POST, pengiriman tetap berurutan, dan status serta pesan tersimpan tetap wajib terbukti. Regresi 3 target membutuhkan 2 scan status, 9 pembacaan form, dan 3 POST; bukan ukuran durasi produksi.

Form login menyediakan **Nama Satker** dengan **Pengadilan Negeri Natuna** terpilih, serta pilihan 13 pejabat/hakim dan NIP dari profil resmi PN Natuna (dibaca 5 Oktober 2026). Pilihan mengisi NIP pemeriksa; NIP manual tetap tersedia. Daftar jabatan bukan penetapan otomatis atasan langsung. NIP hakim ad-hoc yang tidak dipublikasikan tidak ditebak. Lookup LLK tetap memverifikasi identitas pemeriksa setelah login.

Pemeriksa dipilih satu kali: NIP ditampilkan sebagai konfirmasi; opsi **Masukkan NIP manual** membuka kolom input. Kalender menampilkan hitungan hari kerja terisi/belum terisi sampai hari ini hanya setelah pemindaian lengkap. **Pilih hari kerja belum terisi** memilih tanggal nonkontigu yang belum terisi, mengecualikan libur dan akhir pekan; pratinjau serta konfirmasi kirim tetap wajib. Status verifikasi membedakan mengirim dan memastikan tersimpan; hasil dikelompokkan menjadi Belum pasti, Gagal, Berhasil (rincian tertutup), dan Ditahan. Log aktivitas tetap terbuka untuk tracking masalah.

## Privasi & data

Password dan kode authenticator diteruskan melalui backend lokal ke SSO resmi lewat HTTPS; tidak disimpan atau dicatat. Cookie sesi, identitas, dan template pribadi baru berada dalam memori proses. Laporan pengiriman dan audit tetap disimpan di `llk-agent/data/`. Folder `data/` dan `profiles/` lama diabaikan Git; jangan membagikan atau meng-commit isinya. Input sensitif dibersihkan setelah pengiriman, tetapi JavaScript tidak menjamin penghapusan byte dari memori secara langsung.

Akses aplikasi melalui `http://127.0.0.1:4545`; backend menolak Host lain dan POST lintas origin. Jangan membuka port ini ke internet. Bukti pengujian: halaman CAS resmi dicapai lewat HTTP; transisi MFA, percobaan ulang kode, dan redirect diuji dengan upstream sintetis. Pada 5 Oktober 2026, pengguna menyelesaikan login dan MFA akun nyata di aplikasi; backend membaca identitas akun serta memverifikasi atasan setelah perbaikan `accountId`. Pengujian ini tidak mengirim atau memverifikasi LLK.

Migrasi HTTP penuh diuji baca-saja dengan sesi nyata: profil/lookup atasan, 221 tanggal pada 9 halaman, dan 14 LLK anggota (10 siap, 4 ditahan). Pengiriman serta verifikasi diuji terisolasi: CSRF baru, status/isi tersimpan, HTTP 403, dan respons hilang tanpa pengiriman ulang. Tidak ada POST pengiriman/verifikasi ke produksi saat pengujian.

## Lapor bug

Gunakan [tab Issues](https://github.com/sapyong13-design/llk-agent-pn-natuna/issues) — pilih template **Laporan bug**, sertakan langkah reproduksi, screenshot, dan versi Node (`node --version`). Jangan lampirkan cookie, isi folder `data/`, maupun data pribadi.

Usulan fitur juga lewat Issues dengan template **Usulan fitur**. Pull Request diterima: fork → branch → PR, akan direview pemilik repo.

## Lisensi

[MIT](LICENSE)
