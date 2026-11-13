// The Windows preview's work on the CPU (.plans/native-media-engine-m6-preview-3-windows.md, W2,
// W4, W5): the picture area of an NV12 frame read back from the GPU, scaled down by an area
// average into a planar YUV 4:2:0 picture, and that small picture converted from BT.709 limited
// range (what the encoder's video processor writes) to BT.601 full range (what a JPEG viewer
// takes JPEG's YCbCr to be, as on Linux). Portable, so its tests run on any system.

use crate::Error;

/// An NV12 picture in memory: `width` by `height` (even), its Y plane's rows `y_pitch` bytes apart
/// and its interleaved UV plane's rows `uv_pitch` apart.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Nv12<'a> {
    pub(crate) y: &'a [u8],
    pub(crate) y_pitch: usize,
    pub(crate) uv: &'a [u8],
    pub(crate) uv_pitch: usize,
    pub(crate) width: usize,
    pub(crate) height: usize,
}

impl<'a> Nv12<'a> {
    /// The top left `width` by `height` of a mapped NV12 texture `rows` rows high whose rows are
    /// `pitch` bytes apart: the UV plane follows the Y plane's `rows` rows, at the same pitch. The
    /// rows below the picture (a texture taller than the picture) are not read.
    pub(crate) fn in_texture(data: &'a [u8], pitch: usize, rows: usize, width: usize, height: usize) -> Result<Nv12<'a>, Error> {
        if width == 0 || height == 0 || width % 2 != 0 || height % 2 != 0 || width > pitch || height > rows {
            return Err(Error::Media(format!("NV12 picture {width}x{height} in a texture of {rows} rows of {pitch} bytes")));
        }
        let uv_start = pitch * rows;
        // The last chroma row of the picture ends `width` bytes into its row.
        let needed = uv_start + pitch * (height / 2 - 1) + width;
        if data.len() < needed {
            return Err(Error::Media(format!("NV12 texture of {} bytes, {needed} needed", data.len())));
        }
        Ok(Nv12 { y: &data[..pitch * (height - 1) + width], y_pitch: pitch, uv: &data[uv_start..needed], uv_pitch: pitch, width, height })
    }
}

/// A planar YUV 4:2:0 picture to write: `width` by `height`, chroma planes half as wide and high
/// (rounded up), each plane's rows `*_stride` bytes apart.
#[derive(Debug)]
pub(crate) struct Planes<'a> {
    pub(crate) width: usize,
    pub(crate) height: usize,
    pub(crate) y: &'a mut [u8],
    pub(crate) y_stride: usize,
    pub(crate) u: &'a mut [u8],
    pub(crate) u_stride: usize,
    pub(crate) v: &'a mut [u8],
    pub(crate) v_stride: usize,
}

/// The source lines (or columns) `[start, end)` each of `to` outputs averages, of `from`:
/// together they cover every source line once, none is empty.
fn boxes(from: usize, to: usize) -> Vec<(usize, usize)> {
    (0..to)
        .map(|i| {
            let start = (i * from / to).min(from - 1);
            let end = ((i + 1) * from / to).clamp(start + 1, from);
            (start, end)
        })
        .collect()
}

/// The bits of the reciprocals `average_plane` divides by: `(n * reciprocal) >> 40` is `n / count`
/// rounded down, exactly, while `n * count` is below 2^40 (every box a preview has: `n` is at
/// most 256 times `count`, so up to boxes of 65535 samples).
const DIVIDE_SHIFT: u32 = 40;

/// The reciprocal of `count` and half of it, to divide a box's sum with rounding.
fn divisor(count: usize) -> (u64, u64) {
    ((1u64 << DIVIDE_SHIFT) / count as u64 + 1, (count / 2) as u64)
}

/// One plane of `CHANNELS` interleaved samples (1 for Y, 2 for NV12's UV) scaled down by an area
/// average into one output plane per channel (`(plane, stride)`), in integers (preview cost step,
/// part C1). For each output row: the source rows of its box are added into one row of sums,
/// sample by sample; the sums are made running totals per channel along the row, so that a
/// column box's sum is the difference of two of them; that is divided by multiplying with the
/// box's reciprocal. Same results as the per-box average it replaced.
fn average_plane<const CHANNELS: usize>(from: &[u8], pitch: usize, from_size: (usize, usize), mut to: [(&mut [u8], usize); CHANNELS], to_size: (usize, usize)) {
    let columns = boxes(from_size.0, to_size.0);
    let rows = boxes(from_size.1, to_size.1);
    let row_length = from_size.0 * CHANNELS;
    let mut sums = vec![0u32; row_length];
    // Per channel the running total before each source column, and after the last.
    let mut totals = vec![[0u32; CHANNELS]; from_size.0 + 1];
    // The divisors of each column box, for each box height there is (the heights of an output's
    // boxes differ by one line at most).
    let lowest = rows.iter().map(|&(y0, y1)| y1 - y0).min().unwrap_or(1);
    let highest = rows.iter().map(|&(y0, y1)| y1 - y0).max().unwrap_or(1);
    let divisors: Vec<Vec<(u64, u64)>> = (lowest..=highest).map(|height| columns.iter().map(|&(x0, x1)| divisor((x1 - x0) * height)).collect()).collect();
    for (out_y, &(y0, y1)) in rows.iter().enumerate() {
        sums.fill(0);
        for y in y0..y1 {
            let line = &from[y * pitch..y * pitch + row_length];
            for (sum, &sample) in sums.iter_mut().zip(line) {
                *sum += u32::from(sample);
            }
        }
        let mut running = [0u32; CHANNELS];
        for (total, samples) in totals[1..].iter_mut().zip(sums.chunks_exact(CHANNELS)) {
            for channel in 0..CHANNELS {
                running[channel] += samples[channel];
            }
            *total = running;
        }
        let divisors = &divisors[y1 - y0 - lowest];
        for (channel, (plane, stride)) in to.iter_mut().enumerate() {
            let out = &mut plane[out_y * *stride..out_y * *stride + to_size.0];
            for ((value, &(x0, x1)), &(reciprocal, half)) in out.iter_mut().zip(&columns).zip(divisors) {
                let sum = totals[x1][channel] - totals[x0][channel];
                *value = (((u64::from(sum) + half) * reciprocal) >> DIVIDE_SHIFT) as u8;
            }
        }
    }
}

/// `from` scaled down to `to`'s size (never up: `to` is at most `from`'s size) by an area average,
/// the colours as they are.
pub(crate) fn shrink(from: &Nv12, to: &mut Planes) {
    debug_assert!(to.width <= from.width && to.height <= from.height);
    let chroma_from = (from.width.div_ceil(2), from.height.div_ceil(2));
    let chroma_to = (to.width.div_ceil(2), to.height.div_ceil(2));
    average_plane::<1>(from.y, from.y_pitch, (from.width, from.height), [(&mut *to.y, to.y_stride)], (to.width, to.height));
    average_plane::<2>(from.uv, from.uv_pitch, chroma_from, [(&mut *to.u, to.u_stride), (&mut *to.v, to.v_stride)], chroma_to);
}

/// R'G'B' (0 to 1) of BT.709 Y' (0 to 1) and Pb, Pr (-0.5 to 0.5).
fn rgb_of_bt709(y: f64, pb: f64, pr: f64) -> [f64; 3] {
    let (kr, kb) = (0.2126, 0.0722);
    let r = y + 2.0 * (1.0 - kr) * pr;
    let b = y + 2.0 * (1.0 - kb) * pb;
    let g = (y - kr * r - kb * b) / (1.0 - kr - kb);
    [r, g, b]
}

/// BT.601 Y' (0 to 1) and Pb, Pr (-0.5 to 0.5) of R'G'B' (0 to 1).
fn bt601_of_rgb([r, g, b]: [f64; 3]) -> [f64; 3] {
    let (kr, kb) = (0.299, 0.114);
    let y = kr * r + (1.0 - kr - kb) * g + kb * b;
    [y, (b - y) / (2.0 * (1.0 - kb)), (r - y) / (2.0 * (1.0 - kr))]
}

/// BT.601 (Y', Pb, Pr) of BT.709 (Y', Pb, Pr): a linear map, its rows Y', Pb and Pr.
fn bt709_to_bt601() -> [[f64; 3]; 3] {
    let columns = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]].map(|[y, pb, pr]| bt601_of_rgb(rgb_of_bt709(y, pb, pr)));
    std::array::from_fn(|row| std::array::from_fn(|column| columns[column][row]))
}

/// The fixed point of `bt709_limited_to_jpeg`: values in 1/65536 of a level.
const FIXED_SHIFT: u32 = 16;

/// A fixed point value rounded down and clamped to a byte (the rounding half is in the offsets).
fn fixed_to_byte(value: i32) -> u8 {
    (value >> FIXED_SHIFT).clamp(0, 255) as u8
}

/// Converts `planes` in place from BT.709 limited range to BT.601 full range (W4). Each Y sample is
/// converted with the chroma of its 2x2 block. Chroma depends on chroma alone: a grey stays grey
/// in both matrices. In integers (preview cost step, part C1): the matrix in 1/65536 of a level,
/// each chroma sample's part of Y worked out once for its block, the loops plain enough for the
/// compiler to run several samples at once.
pub(crate) fn bt709_limited_to_jpeg(planes: &mut Planes) {
    let m = bt709_to_bt601();
    let fixed = |value: f64| (value * f64::from(1u32 << FIXED_SHIFT)).round() as i32;
    let half = 1 << (FIXED_SHIFT - 1);
    // Y' times 255 of a limited range Y (less 16), and Pb, Pr times 255 of a chroma sample (less
    // 128), by the matrix's entries.
    let luma = fixed(255.0 * m[0][0] / 219.0);
    let chroma = |row: usize, column: usize| fixed(255.0 * m[row][column] / 224.0);
    let (y_u, y_v, u_u, u_v, v_u, v_v) = (chroma(0, 1), chroma(0, 2), chroma(1, 1), chroma(1, 2), chroma(2, 1), chroma(2, 2));
    let luma_offset = half - 16 * luma;
    let chroma_offset = fixed(128.0) + half;
    let (width, height) = (planes.width, planes.height);
    let chroma_width = width.div_ceil(2);
    let mut y_part = vec![0i32; chroma_width];
    // `y_part` for each Y sample of the row.
    let mut y_parts = vec![0i32; 2 * chroma_width];
    for chroma_y in 0..height.div_ceil(2) {
        let u_line = &mut planes.u[chroma_y * planes.u_stride..chroma_y * planes.u_stride + chroma_width];
        let v_line = &mut planes.v[chroma_y * planes.v_stride..chroma_y * planes.v_stride + chroma_width];
        for ((part, u), v) in y_part.iter_mut().zip(u_line.iter_mut()).zip(v_line.iter_mut()) {
            let (du, dv) = (i32::from(*u) - 128, i32::from(*v) - 128);
            *part = y_u * du + y_v * dv + luma_offset;
            *u = fixed_to_byte(u_u * du + u_v * dv + chroma_offset);
            *v = fixed_to_byte(v_u * du + v_v * dv + chroma_offset);
        }
        for (pair, &part) in y_parts.chunks_exact_mut(2).zip(&y_part) {
            pair.fill(part);
        }
        for y in 2 * chroma_y..(2 * chroma_y + 2).min(height) {
            let line = &mut planes.y[y * planes.y_stride..y * planes.y_stride + width];
            for (value, &part) in line.iter_mut().zip(&y_parts) {
                *value = fixed_to_byte(luma * i32::from(*value) + part);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A planar picture of its own, with strides wider than its rows.
    struct Owned {
        width: usize,
        height: usize,
        y: Vec<u8>,
        u: Vec<u8>,
        v: Vec<u8>,
    }
    const STRIDE_EXTRA: usize = 3;
    impl Owned {
        fn new(width: usize, height: usize) -> Owned {
            let (cw, ch) = (width.div_ceil(2), height.div_ceil(2));
            Owned {
                width,
                height,
                y: vec![0xee; (width + STRIDE_EXTRA) * height],
                u: vec![0xee; (cw + STRIDE_EXTRA) * ch],
                v: vec![0xee; (cw + STRIDE_EXTRA) * ch],
            }
        }
        fn planes(&mut self) -> Planes<'_> {
            let cw = self.width.div_ceil(2);
            Planes {
                width: self.width,
                height: self.height,
                y: &mut self.y,
                y_stride: self.width + STRIDE_EXTRA,
                u: &mut self.u,
                u_stride: cw + STRIDE_EXTRA,
                v: &mut self.v,
                v_stride: cw + STRIDE_EXTRA,
            }
        }
        fn y(&self, x: usize, y: usize) -> u8 {
            self.y[y * (self.width + STRIDE_EXTRA) + x]
        }
        fn uv(&self, x: usize, y: usize) -> (u8, u8) {
            let stride = self.width.div_ceil(2) + STRIDE_EXTRA;
            (self.u[y * stride + x], self.v[y * stride + x])
        }
    }

    /// A mapped NV12 texture `rows` high with rows of `pitch` bytes, whose `width` by `height`
    /// picture is `y(x, y)` and `uv(x, y)`, and everything else (the pitch's padding, the rows
    /// below the picture) zeros, which would show green if read.
    fn texture(pitch: usize, rows: usize, width: usize, height: usize, y: impl Fn(usize, usize) -> u8, uv: impl Fn(usize, usize) -> (u8, u8)) -> Vec<u8> {
        let mut data = vec![0u8; pitch * rows * 3 / 2];
        for row in 0..height {
            for x in 0..width {
                data[row * pitch + x] = y(x, row);
            }
        }
        for row in 0..height / 2 {
            for x in 0..width / 2 {
                let (u, v) = uv(x, row);
                data[pitch * rows + row * pitch + 2 * x] = u;
                data[pitch * rows + row * pitch + 2 * x + 1] = v;
            }
        }
        data
    }

    #[test]
    fn boxes_cover_every_line_once() {
        for (from, to) in [(1920, 480), (1080, 270), (1000, 332), (1082, 270), (7, 7), (16, 2), (1920, 1)] {
            let boxes = boxes(from, to);
            assert_eq!(boxes.len(), to);
            assert_eq!(boxes[0].0, 0);
            assert_eq!(boxes[to - 1].1, from);
            for pair in boxes.windows(2) {
                assert_eq!(pair[0].1, pair[1].0, "{from} to {to}");
            }
            assert!(boxes.iter().all(|(start, end)| end > start));
        }
        assert_eq!(boxes(1920, 480)[1], (4, 8));
    }

    #[test]
    fn only_the_picture_area_of_a_taller_texture_with_a_wider_pitch_is_averaged() {
        // A 1920x1080 picture in a texture of 1088 rows of 2048 bytes, as Quick Sync's are: each
        // 4x4 block of the picture one value, so the 480x270 average is that value exactly.
        let (pitch, rows, width, height) = (2048, 1088, 1920, 1080);
        let luma = |x: usize, y: usize| (16 + (x / 4 + y / 4) % 200) as u8;
        // Chroma is scaled by 4 as well: each 4x4 block of the chroma plane one value.
        let chroma = |x: usize, y: usize| ((64 + (x / 4) % 100) as u8, (160 - (y / 4) % 100) as u8);
        let data = texture(pitch, rows, width, height, luma, chroma);
        let nv12 = Nv12::in_texture(&data, pitch, rows, width, height).unwrap();
        let mut out = Owned::new(480, 270);
        shrink(&nv12, &mut out.planes());
        for y in 0..270 {
            for x in 0..480 {
                assert_eq!(out.y(x, y), luma(4 * x, 4 * y), "Y at {x},{y}");
            }
        }
        for y in 0..135 {
            for x in 0..240 {
                assert_eq!(out.uv(x, y), chroma(4 * x, 4 * y), "UV at {x},{y}");
            }
        }
        // The last row and column too: no zero from the padding or the extra rows came in.
        assert!(out.y.chunks(480 + STRIDE_EXTRA).all(|line| line[..480].iter().all(|&v| v >= 16)));
        // The stride's padding is not written.
        assert_eq!(out.y[480], 0xee);
    }

    #[test]
    fn the_average_is_of_the_whole_box_and_rounded() {
        // 4x2 to 2x2: each output averages two columns; 4x4 of values 0..16 to 2x2.
        let (width, height) = (4, 4);
        let data = texture(8, 6, width, height, |x, y| (y * 4 + x) as u8 * 10, |x, y| ((x * 2 + y) as u8 * 3, 200));
        let nv12 = Nv12::in_texture(&data, 8, 6, width, height).unwrap();
        let mut out = Owned::new(2, 2);
        shrink(&nv12, &mut out.planes());
        // Top left box: 0, 10, 40, 50 -> 25.
        assert_eq!([out.y(0, 0), out.y(1, 0), out.y(0, 1), out.y(1, 1)], [25, 45, 105, 125]);
        // Chroma 2x2 to 1x1: U 0, 6, 3, 9 -> 4.5 -> 5.
        assert_eq!(out.uv(0, 0), (5, 200));
        // A picture that is not scaled stays as it is.
        let mut same = Owned::new(4, 4);
        shrink(&nv12, &mut same.planes());
        assert_eq!(same.y(3, 2), 110);
        assert_eq!(same.uv(1, 1), (9, 200));
    }

    #[test]
    fn a_texture_too_small_for_its_picture_is_refused() {
        let data = vec![0u8; 8 * 6 * 3 / 2];
        assert!(Nv12::in_texture(&data, 8, 6, 4, 4).is_ok());
        // The UV plane at 48, its last picture row ending at 48 + 8 + 4.
        assert!(Nv12::in_texture(&data[..60], 8, 6, 4, 4).is_ok());
        assert!(Nv12::in_texture(&data[..59], 8, 6, 4, 4).is_err());
        assert!(Nv12::in_texture(&data, 8, 6, 10, 4).is_err());
        assert!(Nv12::in_texture(&data, 8, 6, 4, 8).is_err());
        assert!(Nv12::in_texture(&data, 8, 6, 3, 4).is_err());
    }

    /// BT.709 limited range Y, Cb, Cr of R'G'B' (0 to 1).
    fn bt709_limited([r, g, b]: [f64; 3]) -> [u8; 3] {
        let y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        let (pb, pr) = ((b - y) / 1.8556, (r - y) / 1.5748);
        [16.0 + 219.0 * y, 128.0 + 224.0 * pb, 128.0 + 224.0 * pr].map(|v| v.round() as u8)
    }

    /// BT.601 full range (JPEG's) Y, Cb, Cr of R'G'B' (0 to 1), as JFIF defines them.
    fn jpeg_of([r, g, b]: [f64; 3]) -> [f64; 3] {
        let (r, g, b) = (255.0 * r, 255.0 * g, 255.0 * b);
        [
            0.299 * r + 0.587 * g + 0.114 * b,
            128.0 - 0.168736 * r - 0.331264 * g + 0.5 * b,
            128.0 + 0.5 * r - 0.418688 * g - 0.081312 * b,
        ]
    }

    #[test]
    fn grey_stays_grey_and_only_chroma_makes_chroma() {
        let m = bt709_to_bt601();
        assert!((m[0][0] - 1.0).abs() < 1e-12);
        assert!(m[1][0].abs() < 1e-12 && m[2][0].abs() < 1e-12);
    }

    #[test]
    fn colours_are_converted_to_jpeg_s_full_range_bt601() {
        // White, black, grey, the 75 % bars, full red and blue, a skin tone.
        let colours = [
            [1.0, 1.0, 1.0],
            [0.0, 0.0, 0.0],
            [0.5, 0.5, 0.5],
            [0.75, 0.75, 0.0],
            [0.0, 0.75, 0.75],
            [0.0, 0.75, 0.0],
            [0.75, 0.0, 0.75],
            [0.75, 0.0, 0.0],
            [0.0, 0.0, 0.75],
            [1.0, 0.0, 0.0],
            [0.0, 0.0, 1.0],
            [0.9, 0.7, 0.55],
        ];
        for rgb in colours {
            // A 2x2 picture of one colour.
            let [y, cb, cr] = bt709_limited(rgb);
            let mut picture = Owned::new(2, 2);
            {
                let mut planes = picture.planes();
                for row in 0..2 {
                    planes.y[row * planes.y_stride..row * planes.y_stride + 2].fill(y);
                }
                planes.u[0] = cb;
                planes.v[0] = cr;
                bt709_limited_to_jpeg(&mut planes);
            }
            let wanted = jpeg_of(rgb);
            let got = [picture.y(1, 1), picture.uv(0, 0).0, picture.uv(0, 0).1];
            for (g, w) in got.iter().zip(wanted) {
                // The limited range input is rounded to whole steps: within 2 of the exact value.
                assert!((f64::from(*g) - w.clamp(0.0, 255.0)).abs() <= 2.0, "{rgb:?}: {got:?} against {wanted:?}");
            }
        }
        // The extremes exactly.
        let mut picture = Owned::new(2, 2);
        {
            let mut planes = picture.planes();
            planes.y[0] = 235;
            planes.y[1] = 16;
            planes.u[0] = 128;
            planes.v[0] = 128;
            bt709_limited_to_jpeg(&mut planes);
        }
        assert_eq!((picture.y(0, 0), picture.y(1, 0), picture.uv(0, 0)), (255, 0, (128, 128)));
    }

    /// The code `shrink` and `bt709_limited_to_jpeg` replaced (M6 preview step 3), kept as the
    /// reference the new code is checked against (preview cost step, part C2).
    mod reference {
        use super::super::{Nv12, Planes, boxes, bt709_to_bt601};

        #[allow(clippy::too_many_arguments)]
        fn average_plane(
            from: &[u8],
            pitch: usize,
            step: usize,
            offset: usize,
            from_size: (usize, usize),
            to: &mut [u8],
            stride: usize,
            to_size: (usize, usize),
        ) {
            let columns = boxes(from_size.0, to_size.0);
            let rows = boxes(from_size.1, to_size.1);
            let mut sums = vec![0u32; to_size.0];
            for (out_y, &(y0, y1)) in rows.iter().enumerate() {
                sums.fill(0);
                for y in y0..y1 {
                    let line = &from[y * pitch..];
                    for (sum, &(x0, x1)) in sums.iter_mut().zip(&columns) {
                        *sum += (x0..x1).map(|x| u32::from(line[x * step + offset])).sum::<u32>();
                    }
                }
                let out = &mut to[out_y * stride..out_y * stride + to_size.0];
                for ((value, sum), &(x0, x1)) in out.iter_mut().zip(&sums).zip(&columns) {
                    let count = ((x1 - x0) * (y1 - y0)) as u32;
                    *value = ((sum + count / 2) / count) as u8;
                }
            }
        }

        pub(super) fn shrink(from: &Nv12, to: &mut Planes) {
            let chroma_from = (from.width.div_ceil(2), from.height.div_ceil(2));
            let chroma_to = (to.width.div_ceil(2), to.height.div_ceil(2));
            average_plane(from.y, from.y_pitch, 1, 0, (from.width, from.height), to.y, to.y_stride, (to.width, to.height));
            average_plane(from.uv, from.uv_pitch, 2, 0, chroma_from, to.u, to.u_stride, chroma_to);
            average_plane(from.uv, from.uv_pitch, 2, 1, chroma_from, to.v, to.v_stride, chroma_to);
        }

        fn to_byte(value: f32) -> u8 {
            value.round().clamp(0.0, 255.0) as u8
        }

        pub(super) fn bt709_limited_to_jpeg(planes: &mut Planes) {
            let m = bt709_to_bt601().map(|row| row.map(|v| v as f32));
            let luma = |y: u8| (f32::from(y) - 16.0) / 219.0;
            let chroma = |c: u8| (f32::from(c) - 128.0) / 224.0;
            for y in 0..planes.height {
                let (u_line, v_line) = (&planes.u[(y / 2) * planes.u_stride..], &planes.v[(y / 2) * planes.v_stride..]);
                let line = &mut planes.y[y * planes.y_stride..y * planes.y_stride + planes.width];
                for (x, value) in line.iter_mut().enumerate() {
                    let (pb, pr) = (chroma(u_line[x / 2]), chroma(v_line[x / 2]));
                    *value = to_byte(255.0 * (m[0][0] * luma(*value) + m[0][1] * pb + m[0][2] * pr));
                }
            }
            let (width, height) = (planes.width.div_ceil(2), planes.height.div_ceil(2));
            for y in 0..height {
                let u_line = &mut planes.u[y * planes.u_stride..y * planes.u_stride + width];
                let v_line = &mut planes.v[y * planes.v_stride..y * planes.v_stride + width];
                for (u, v) in u_line.iter_mut().zip(v_line.iter_mut()) {
                    let (pb, pr) = (chroma(*u), chroma(*v));
                    *u = to_byte(128.0 + 255.0 * (m[1][1] * pb + m[1][2] * pr));
                    *v = to_byte(128.0 + 255.0 * (m[2][1] * pb + m[2][2] * pr));
                }
            }
        }
    }

    /// Bytes from a fixed seed (a 64-bit LCG's high bits), the same on every run.
    fn noise(seed: u64) -> impl FnMut() -> u8 {
        let mut state = seed;
        move || {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (state >> 56) as u8
        }
    }

    /// The largest difference between two planar pictures of the same size, sample by sample.
    fn largest_difference(a: &Owned, b: &Owned) -> u8 {
        let mut largest = 0;
        for y in 0..a.height {
            for x in 0..a.width {
                largest = largest.max(a.y(x, y).abs_diff(b.y(x, y)));
            }
        }
        for y in 0..a.height.div_ceil(2) {
            for x in 0..a.width.div_ceil(2) {
                let ((au, av), (bu, bv)) = (a.uv(x, y), b.uv(x, y));
                largest = largest.max(au.abs_diff(bu)).max(av.abs_diff(bv));
            }
        }
        largest
    }

    /// Part C2: for each source (picture size, texture pitch and rows) and each output size, the
    /// new shrink, then the new conversion, against the reference's, on noise and on smooth
    /// content. Returns the largest difference seen in each stage.
    fn compare(cases: &[((usize, usize, usize, usize), &[(usize, usize)])]) -> (u8, u8) {
        let (mut shrink_most, mut colour_most) = (0, 0);
        for &((width, height, pitch, rows), outputs) in cases {
            for content in 0..2 {
                let mut next = noise((width * 31 + height + content) as u64);
                let data = if content == 0 {
                    let mut data = vec![0u8; pitch * rows * 3 / 2];
                    data.iter_mut().for_each(|b| *b = next());
                    data
                } else {
                    texture(pitch, rows, width, height, |x, y| (16 + (x * 3 + y * 5) % 220) as u8, |x, y| ((16 + (x * 7) % 225) as u8, (16 + (y * 11 + x) % 225) as u8))
                };
                let nv12 = Nv12::in_texture(&data, pitch, rows, width, height).unwrap();
                for &(to_width, to_height) in outputs {
                    let (mut new, mut old) = (Owned::new(to_width, to_height), Owned::new(to_width, to_height));
                    shrink(&nv12, &mut new.planes());
                    reference::shrink(&nv12, &mut old.planes());
                    shrink_most = shrink_most.max(largest_difference(&new, &old));
                    // The conversion of the same input, the reference's shrink output.
                    let mut converted = Owned::new(to_width, to_height);
                    converted.y.copy_from_slice(&old.y);
                    converted.u.copy_from_slice(&old.u);
                    converted.v.copy_from_slice(&old.v);
                    bt709_limited_to_jpeg(&mut converted.planes());
                    reference::bt709_limited_to_jpeg(&mut old.planes());
                    colour_most = colour_most.max(largest_difference(&converted, &old));
                    // The stride's padding is never written.
                    assert!(converted.y.chunks(to_width + STRIDE_EXTRA).all(|line| line[to_width..].iter().all(|&v| v == 0xee)));
                    assert!(new.u.chunks(to_width.div_ceil(2) + STRIDE_EXTRA).all(|line| line[to_width.div_ceil(2)..].iter().all(|&v| v == 0xee)));
                }
            }
        }
        (shrink_most, colour_most)
    }

    #[test]
    fn the_new_shrink_and_conversion_match_the_reference_at_the_preview_sizes() {
        let arms: &[(usize, usize)] = &[(480, 270), (960, 540), (1280, 720), (1920, 1080)];
        // A 1920x1080 picture as it is, in a texture of 1088 rows of 2048 bytes (Quick Sync's),
        // a window of 1282x759 with its fitted sizes, an odd output size.
        let window: Vec<(usize, usize)> = [(480, 270), (960, 540), (1280, 720), (333, 333)]
            .iter()
            .map(|&(w, h)| {
                let (w, h) = crate::video::sizing::output_size(1282, 759, w, h);
                (w as usize, h as usize)
            })
            .collect();
        let cases: &[((usize, usize, usize, usize), &[(usize, usize)])] = &[
            ((1920, 1080, 1920, 1080), arms),
            ((1920, 1080, 2048, 1088), arms),
            ((1282, 759 - 1, 1344, 768), &window),
            ((1920, 1080, 1920, 1080), &[(332, 186), (16, 16), (1278, 718)]),
        ];
        let (shrink_most, colour_most) = compare(cases);
        assert!(shrink_most <= 1 && colour_most <= 1, "shrink {shrink_most}, colour {colour_most}");
    }

    #[test]
    fn the_new_conversion_matches_the_reference_for_every_value() {
        // Every Y with every (U, V): a 512x512 picture holds each (U, V) pair once per 2x2 block,
        // 64 pictures give each block's four Y samples every value.
        let mut largest = 0;
        for round in 0..64usize {
            let (mut new, mut old) = (Owned::new(512, 512), Owned::new(512, 512));
            for picture in [&mut new, &mut old] {
                let stride = 512 + STRIDE_EXTRA;
                let chroma_stride = 256 + STRIDE_EXTRA;
                for y in 0..512 {
                    for x in 0..512 {
                        picture.y[y * stride + x] = (round * 4 + (y % 2) * 2 + x % 2) as u8;
                    }
                }
                for y in 0..256 {
                    for x in 0..256 {
                        picture.u[y * chroma_stride + x] = x as u8;
                        picture.v[y * chroma_stride + x] = y as u8;
                    }
                }
            }
            bt709_limited_to_jpeg(&mut new.planes());
            reference::bt709_limited_to_jpeg(&mut old.planes());
            largest = largest.max(largest_difference(&new, &old));
        }
        assert!(largest <= 1, "{largest}");
    }
}
