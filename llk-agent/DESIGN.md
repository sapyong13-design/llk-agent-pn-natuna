# LLK Agent — modern netral

Arah dipilih pengguna: modern netral. Mode antarmuka: Operate. Identitas dokumen dinas, stempel, serif, dan garis ganda diganti; aturan LLK dan konfirmasi pengiriman tidak berubah.

## Sistem visual

- Font lokal Public Sans, isi 15px/1.6; judul aplikasi 26px, judul bagian 22px. Waktu log memakai Consolas.
- Terang: latar #f5f7fa, permukaan #ffffff, teks #182333, sekunder #536174, garis #d7dee8.
- Biru #245dcc untuk pilihan; tombol utama #194daf dengan teks putih. Merah untuk kesalahan, hijau untuk status selesai.
- Gelap: latar #111820, permukaan #1a2430, teks #e9eef5, garis #3c4a5c, aksen #90b5ff.
- Sudut panel 8px, kontrol 6px. Jarak panel 24px; tanpa bayangan dekoratif.

## Susunan

Header ringkas: nama aplikasi, identitas akun, status sesi, Ganti akun, tema. Pada seluler identitas mendapat satu baris penuh.

Dua pilihan workflow berupa tab bergaris bawah. Radio native tetap menjaga interaksi keyboard; fokus terlihat.

Buat LLK: kalender kiri, ringkasan tanggal dan hari kerja kanan, kemudian sumber kegiatan dan Kelola daftar kegiatan. Pada seluler urut vertikal. Pratinjau dan konfirmasi tetap di halaman sama.

Verifikasi: daftar dan status terpisah secara visual, rincian bisa dibuka. Filter, pesan, dan tindakan tetap memakai kontrak aplikasi.

Log selalu terbuka di bawah area kerja. Desktop memakai waktu, status, aktivitas. Seluler memindahkan aktivitas ke baris penuh. Isi log ditulis sebagai teks, token disamarkan, gulir mengikuti hanya jika pembaca berada dekat bawah.

## Batas

Tidak menambah sidebar, dashboard, atau layar baru. Jangan menampilkan keberhasilan penyimpanan berdasarkan warna saja. Tema gelap dan terang memakai susunan sama. Gerakan dinonaktifkan ketika prefers-reduced-motion aktif.
