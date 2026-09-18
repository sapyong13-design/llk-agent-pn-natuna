# LLK Agent — modern netral

Arah dipilih pengguna: modern netral. Mode antarmuka: Operate. Identitas dokumen dinas, stempel, serif, dan garis ganda diganti; aturan LLK dan konfirmasi pengiriman tidak berubah.

## Sistem visual

- Font lokal Public Sans, isi 15px/1.6; judul aplikasi 26px, judul bagian 22px. Waktu log memakai Consolas.
- Terang: latar #f5f7fa, permukaan #ffffff, teks #182333, sekunder #536174, garis #d7dee8.
- Biru #245dcc untuk pilihan; tombol utama #194daf dengan teks putih. Merah untuk kesalahan, hijau untuk status selesai.
- Gelap: latar #111820, permukaan #1a2430, teks #e9eef5, garis #3c4a5c, aksen #90b5ff.
- Sudut panel 8px, kontrol 6px. Jarak panel 24px; tanpa bayangan dekoratif.

## Susunan

Header ringkas: nama aplikasi, identitas akun, status sesi, Akhiri sesi, tema. Pada seluler identitas mendapat satu baris penuh. Onboarding memakai judul Mulai sesi LLK, satu kolom NIP atasan, status nyata, serta satu tombol utama.

Dua pilihan workflow berupa tab bergaris bawah. Radio native tetap menjaga interaksi keyboard; fokus terlihat.

Buat LLK memiliki tahap Tanggal, Periksa & kirim, Hasil. Kalender kiri dan pengaturan kanan; kalender diringkas setelah pratinjau. Ubah tanggal mempertahankan edit sampai rentang benar-benar berubah. Tombol kirim menyebut jumlah hari dan alasan jika belum dapat digunakan. Seluler mengikuti urutan baca vertikal.

Identitas pemeriksa mendapat panel tersendiri: nama tebal, NIP terpisah, status konfirmasi dari LLK, serta petunjuk memeriksa kecocokan. Kalender menandai tanggal yang terlihat di halaman pertama dengan Terisi. Tanggal tanpa penanda bukan bukti kosong; cakupan halaman 1, waktu pembacaan, dan Perbarui isian LLK selalu dijelaskan. Data gagal dibaca tidak dianggap kosong.

Verifikasi dikelompokkan per pegawai dengan tanggal dan rincian. Siap dan ditahan terpisah. Hasil membedakan berhasil, gagal terbukti, dan belum pasti; belum pasti memakai warna amber serta instruksi pindai ulang, tanpa pengiriman ulang otomatis. Pesan wajib berada dekat tindakan.

Log selalu terbuka, tinggi mengikuti isi hingga batas gulir; tidak menyediakan kotak kosong besar. Desktop memakai waktu, status, aktivitas. Seluler memindahkan aktivitas ke baris penuh. Isi log ditulis sebagai teks, token disamarkan, gulir mengikuti hanya jika pembaca berada dekat bawah. Hasil pekerjaan tetap tersedia di area utama.

## Batas

Tidak menambah sidebar, dashboard, atau layar baru. Jangan menampilkan keberhasilan penyimpanan berdasarkan warna saja. Tema gelap dan terang memakai susunan sama. Gerakan dinonaktifkan ketika prefers-reduced-motion aktif.
