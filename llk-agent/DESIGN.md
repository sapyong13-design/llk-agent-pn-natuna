# LLK Agent — modern netral

Arah dipilih pengguna: modern netral. Mode antarmuka: Operate. Identitas dokumen dinas, stempel, serif, dan garis ganda diganti; aturan LLK dan konfirmasi pengiriman tidak berubah.

## Sistem visual

- Font lokal Public Sans, isi 15px/1.6; judul aplikasi 26px, judul bagian 22px. Waktu log memakai Consolas.
- Terang: latar #f5f7fa, permukaan #ffffff, teks #182333, sekunder #536174, garis #d7dee8.
- Biru #245dcc untuk pilihan; tombol utama #194daf dengan teks putih. Merah untuk kesalahan, hijau untuk status selesai.
- Gelap: latar #111820, permukaan #1a2430, teks #e9eef5, garis #3c4a5c, aksen #90b5ff.
- Sudut panel 8px, kontrol 6px. Jarak panel 24px; tanpa bayangan dekoratif.

## Susunan

Header ringkas: nama aplikasi, identitas akun, status sesi, Akhiri sesi, tema. Pada seluler identitas mendapat satu baris penuh. Onboarding memakai judul Mulai sesi LLK, kolom nama pengguna/password SSO dan NIP atasan, status nyata, serta satu tombol utama. Saat CAS meminta MFA, form kredensial diganti kolom kode authenticator dengan petunjuk kode terbaru. Input kode memakai autocomplete one-time-code; password/kode dibersihkan setelah dikirim. Kode salah tetap pada tahap MFA; sesi kedaluwarsa meminta login ulang. Sistem visual tetap modern netral.

Password memiliki tombol Tampilkan/Sembunyikan; pengiriman dan reset form mengembalikan mode tersembunyi. Pilihan pemeriksa menampilkan nama/jabatan; NIP muncul setelah dipilih. Sumber direktori serta rincian runtime memakai details native. Penjelasan HTTPS dan tidak disimpannya kredensial tetap terlihat.

Sesi diikat ke cookie browser; tab satu profil berbagi sesi, profil terpisah tidak berbagi state. Logout dan respons 401 membersihkan identitas, draf, template, progres, hasil, dan log sesi lama di UI; sesi browser lain tidak berubah. Login/MFA tertunda memiliki batas 10 menit, sesi idle 30 menit. Detail sesi menjelaskan batas memori satu proses dan restart.

Privasi berlaku untuk lokal maupun hosting: backend aplikasi meneruskan kredensial ke SSO resmi lewat HTTPS; cookie SSO hanya di memori server aplikasi. CSP mengizinkan script lokal dan hash script tema inline yang tetap; jangan mengubah script tema tanpa memperbarui hash server. Pesan 429 memberi petunjuk menunggu, bukan mengulang autentikasi otomatis.

429 menampilkan jumlah detik menunggu dari Retry-After. Verifikasi yang ditolak limiter disebut belum dikirim, bukan hasil belum pasti. Login tetap SSO biasa tanpa gateway pegawai tambahan.

Dua pilihan workflow berupa tab bergaris bawah. Radio native tetap menjaga interaksi keyboard; fokus terlihat.

Buat LLK memiliki tahap Tanggal, Periksa & kirim, Hasil. Kalender kiri dan pengaturan kanan; kalender diringkas setelah pratinjau. Ubah tanggal mempertahankan edit sampai rentang benar-benar berubah. Tombol kirim menyebut jumlah hari dan alasan jika belum dapat digunakan. Seluler mengikuti urutan baca vertikal.

Identitas pemeriksa memakai panel ringkas: status tepat di bawah nama, NIP terpisah, dan Detail pemeriksa untuk petunjuk panjang. Hijau hanya jika verified benar dan sumber llk-form, llk-select2, atau llk-api; selain itu peringatan Belum terkonfirmasi tetap terlihat. Peringatan hilangnya draf saat refresh tetap terbuka.

Kalender menampilkan ringkasan hari kerja terisi/belum terisi sampai hari ini serta waktu pemindaian. Tombol pembaruan di bawah grid; Detail pembacaan menyimpan jumlah halaman, total tanggal, waktu, dan batas interpretasi. Loading, kesalahan, dan peringatan tetap di atas grid; pembacaan gagal tidak dianggap kosong. Tanggal mendatang/nonkerja tetap terbaca tetapi tidak dapat dipilih. Label Terisi dan Dipilih, aria-pressed, serta fokus 3px membedakan status tanpa mengandalkan warna. Tombol Pratinjau LLK menyebut jumlah hari kerja, termasuk pilihan nonkontigu yang mengecualikan tanggal terisi; tanpa tanggal kerja tombol nonaktif. Sumber Halaman terbaru LLK memakai kegiatan unik dari satu halaman yang memuat tanggal kegiatan paling baru setelah seluruh halaman diperiksa, bukan nomor halaman terbesar. Kalender tetap memakai semua tanggal dari seluruh halaman.

Verifikasi dikelompokkan per pegawai dengan tanggal dan rincian. Siap dan ditahan terpisah. Hasil membedakan berhasil, gagal terbukti, dan belum pasti; belum pasti memakai warna amber serta instruksi pindai ulang, tanpa pengiriman ulang otomatis. Pesan wajib berada dekat tindakan.

Log selalu terbuka, tinggi mengikuti isi hingga batas gulir; tidak menyediakan kotak kosong besar. Desktop memakai waktu, status, aktivitas. Seluler memindahkan aktivitas ke baris penuh. Isi log ditulis sebagai teks, token disamarkan, gulir mengikuti hanya jika pembaca berada dekat bawah. Hasil pekerjaan tetap tersedia di area utama.

## Batas

Tidak menambah sidebar, dashboard, atau layar baru. Jangan menampilkan keberhasilan penyimpanan berdasarkan warna saja. Tema gelap dan terang memakai susunan sama. Gerakan dinonaktifkan ketika prefers-reduced-motion aktif.
