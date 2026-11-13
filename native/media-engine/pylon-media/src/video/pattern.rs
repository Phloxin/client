// The test pattern (D13): frames drawn on the CPU as BGRx, on any system. The producer that
// hands them to the encoder is the system's own (`linux/pattern.rs`, `windows/pattern.rs`).

use std::time::{SystemTime, UNIX_EPOCH};

use super::font;

/// Seconds between full changes of the picture.
pub(super) const SCENE_SECONDS: u64 = 10;
/// Pixels the stress pattern's field moves each frame.
pub(super) const STEP: usize = 1;

/// The stress pattern's two pictures, BGRx, `width` by `height`, packed.
pub(super) struct Scenes {
    width: usize,
    height: usize,
    pictures: [Vec<u8>; 2],
}

/// A cheap integer hash for the pattern's noise.
fn hash(x: u32, y: u32, seed: u32) -> u32 {
    let mut h = x.wrapping_mul(0x9e37_79b1) ^ y.wrapping_mul(0x85eb_ca77) ^ seed.wrapping_mul(0xc2b2_ae3d);
    h ^= h >> 15;
    h = h.wrapping_mul(0x2c1b_3c6d);
    h ^= h >> 12;
    h
}

fn clamp(v: i32) -> u8 {
    v.clamp(0, 255) as u8
}

impl Scenes {
    pub(super) fn new(width: usize, height: usize) -> Scenes {
        // Colours of the blocks of the first picture and the bands of the second, BGR.
        const BLOCKS: [[i32; 3]; 8] = [
            [200, 60, 40], [40, 180, 60], [40, 60, 200], [30, 200, 220],
            [200, 40, 200], [220, 200, 40], [120, 120, 120], [60, 130, 240],
        ];
        const BANDS: [[i32; 3]; 6] = [[250, 250, 250], [20, 20, 20], [40, 90, 250], [250, 140, 30], [90, 230, 90], [180, 40, 120]];
        let mut first = vec![0u8; width * height * 4];
        let mut second = vec![0u8; width * height * 4];
        for y in 0..height {
            for x in 0..width {
                let i = (y * width + x) * 4;
                let noise = (hash(x as u32, y as u32, 1) & 0x3f) as i32 - 32;
                // Blocks of 96 pixels with a fine grid every 16 and noise on top.
                let block = BLOCKS[(x / 96 + 3 * (y / 96)) % BLOCKS.len()];
                let grid = if x % 16 == 0 || y % 16 == 0 { -70 } else { 0 };
                for c in 0..3 {
                    first[i + c] = clamp(block[c] + noise + grid);
                }
                first[i + 3] = 255;

                // Diagonal bands with a 4 pixel checker and other noise.
                let noise = (hash(x as u32, y as u32, 2) & 0x3f) as i32 - 32;
                let band = BANDS[((x + 2 * y) / 64) % BANDS.len()];
                let checker = if (x / 4 + y / 4) % 2 == 0 { 30 } else { -30 };
                for c in 0..3 {
                    second[i + c] = clamp(band[c] + noise + checker);
                }
                second[i + 3] = 255;
            }
        }
        Scenes { width, height, pictures: [first, second] }
    }

    /// Copies scene `scene` moved left by `offset` pixels (wrapping) into a picture with `stride`.
    pub(super) fn copy(&self, scene: usize, offset: usize, picture: &mut [u8], stride: usize) {
        let row_bytes = self.width * 4;
        let cut = (offset % self.width) * 4;
        for y in 0..self.height {
            let source = &self.pictures[scene][y * row_bytes..(y + 1) * row_bytes];
            let line = &mut picture[y * stride..y * stride + row_bytes];
            line[..row_bytes - cut].copy_from_slice(&source[cut..]);
            line[row_bytes - cut..].copy_from_slice(&source[..cut]);
        }
    }
}

/// Which picture the pattern shows.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PatternKind {
    /// What a screen shows (D21): still colour bars with a small moving box, and every 10
    /// seconds a cut to or from a page of text that scrolls slowly after 2 seconds.
    #[default]
    Screen,
    /// The hard one: a field of fine detail and noise moving every frame, a full change
    /// every 10 seconds.
    Stress,
}

/// The side of the moving box and how far it moves each frame.
const BOX: usize = 96;
const BOX_STEP: usize = 16;
/// The text page waits this long after a cut, then scrolls this many lines a frame.
const SCROLL_AFTER_S: u64 = 2;
const SCROLL_STEP: usize = 2;

/// The screen pattern's two pictures: colour bars, and a page of text three screens tall.
pub(super) struct ScreenScenes {
    width: usize,
    height: usize,
    bars: Vec<u8>,
    page: Vec<u8>,
    page_height: usize,
}

/// Words for the page, drawn as lines of code.
const WORDS: [&str; 24] = [
    "let", "frame", "=", "encoder.encode(source,", "bitrate);", "if", "queue", ">", "limit", "{",
    "}", "return", "ok(packet);", "fn", "next_frame(control)", "->", "result", "match", "key",
    "self.meter.record(at,", "bytes);", "for", "row", "in",
];

impl ScreenScenes {
    pub(super) fn new(width: usize, height: usize) -> ScreenScenes {
        // 75 % bars, then a strip of the reverse bars, then the bottom blocks, BGR.
        const TOP: [[u8; 3]; 7] = [
            [191, 191, 191], [0, 191, 191], [191, 191, 0], [0, 191, 0], [191, 0, 191], [0, 0, 191], [191, 0, 0],
        ];
        const BOTTOM: [[u8; 3]; 4] = [[106, 33, 0], [255, 255, 255], [134, 0, 50], [16, 16, 16]];
        let mut bars = vec![0u8; width * height * 4];
        for y in 0..height {
            for x in 0..width {
                let colour = if y < height * 2 / 3 {
                    TOP[x * 7 / width]
                } else if y < height * 3 / 4 {
                    TOP[6 - x * 7 / width]
                } else {
                    BOTTOM[x * 4 / width]
                };
                let i = (y * width + x) * 4;
                bars[i..i + 3].copy_from_slice(&colour);
                bars[i + 3] = 255;
            }
        }

        // White, a sidebar of coloured entries, lines of text in a few colours.
        const SIDEBAR: [[u8; 4]; 8] = [
            [200, 80, 40, 255], [60, 170, 60, 255], [40, 60, 200, 255], [30, 190, 220, 255],
            [190, 50, 190, 255], [220, 200, 40, 255], [120, 120, 120, 255], [60, 130, 240, 255],
        ];
        const INK: [[u8; 4]; 4] = [[30, 30, 30, 255], [170, 60, 20, 255], [30, 30, 170, 255], [20, 120, 20, 255]];
        let page_height = height * 3;
        let mut page = vec![255u8; width * page_height * 4];
        let stride = width * 4;
        let sidebar = (width / 16).max(8) * 2;
        let entry = (height / 8).max(1);
        for (n, colour) in (0..page_height / entry + 1).map(|n| (n, SIDEBAR[n % SIDEBAR.len()])) {
            font::fill(&mut page, stride, width, page_height, 0, n * entry + 2, sidebar.saturating_sub(4), entry.saturating_sub(4), colour);
        }
        let scale = (height / 540).max(1) * 2;
        let line = 9 * scale;
        let advance = 6 * scale;
        for row in 0..page_height / line {
            let indent = (hash(row as u32, 0, 7) % 4) as usize * 4;
            let count = 3 + (hash(row as u32, 1, 7) % 7) as usize;
            let mut x = sidebar + 2 * advance + indent * advance;
            for w in 0..count {
                let word = WORDS[(hash(row as u32, w as u32, 9) % WORDS.len() as u32) as usize];
                let ink = INK[(hash(row as u32, w as u32, 11) % INK.len() as u32) as usize];
                if x + word.len() * advance >= width {
                    break;
                }
                font::draw(&mut page, stride, width, page_height, x, row * line + scale, scale, word, ink);
                x += (word.len() + 1) * advance;
            }
        }
        ScreenScenes { width, height, bars, page, page_height }
    }

    /// Frame `n` of a segment: the bars with the box at its place, or the page scrolled.
    pub(super) fn draw(&self, text: bool, n: u64, fps: u32, picture: &mut [u8], stride: usize) {
        let row_bytes = self.width * 4;
        if text {
            let wait = SCROLL_AFTER_S * fps as u64;
            let offset = (n.saturating_sub(wait) as usize * SCROLL_STEP) % self.page_height;
            for y in 0..self.height {
                let source = ((y + offset) % self.page_height) * row_bytes;
                picture[y * stride..y * stride + row_bytes].copy_from_slice(&self.page[source..source + row_bytes]);
            }
            return;
        }
        for y in 0..self.height {
            picture[y * stride..y * stride + row_bytes].copy_from_slice(&self.bars[y * row_bytes..(y + 1) * row_bytes]);
        }
        let span = self.width.saturating_sub(BOX).max(1);
        let x = (n as usize * BOX_STEP) % span;
        font::fill(picture, stride, self.width, self.height, x, self.height / 2, BOX, BOX, [255, 255, 255, 255]);
    }
}

/// The pattern of one size and kind as each system's producer draws it: which scene frame `n`
/// shows, drawn with the overlay into a BGRx picture.
pub(super) struct PatternDrawing {
    width: usize,
    height: usize,
    fps: u32,
    stress: Option<Scenes>,
    screen: Option<ScreenScenes>,
}

impl PatternDrawing {
    pub(super) fn new(width: usize, height: usize, fps: u32, kind: PatternKind) -> PatternDrawing {
        let (stress, screen) = match kind {
            PatternKind::Stress => (Some(Scenes::new(width, height)), None),
            PatternKind::Screen => (None, Some(ScreenScenes::new(width, height))),
        };
        PatternDrawing { width, height, fps, stress, screen }
    }

    /// Draws frame `n` into `picture`, `height` lines of `stride` bytes.
    pub(super) fn draw(&self, n: u64, picture: &mut [u8], stride: usize) {
        let segment_frames = SCENE_SECONDS * self.fps as u64;
        let segment = (n / segment_frames) % 2;
        if let Some(scenes) = &self.stress {
            scenes.copy(segment as usize, n as usize * STEP, picture, stride);
        }
        if let Some(screen) = &self.screen {
            let text = segment == 1;
            screen.draw(text, if text { n % segment_frames } else { n }, self.fps, picture, stride);
        }
        draw_overlay(picture, stride, self.width, self.height, n, &clock_text(SystemTime::now()));
    }
}

/// The wall clock as `HH:MM:SS.mmm`, UTC.
pub(super) fn clock_text(at: SystemTime) -> String {
    let since = at.duration_since(UNIX_EPOCH).unwrap_or_default();
    let ms = since.as_millis() % 86_400_000;
    format!("{:02}:{:02}:{:02}.{:03}", ms / 3_600_000, ms / 60_000 % 60, ms / 1000 % 60, ms % 1000)
}

/// Draws the frame counter and the clock in a black box at the top left.
pub(super) fn draw_overlay(picture: &mut [u8], stride: usize, width: usize, height: usize, frame: u64, clock: &str) {
    let scale = (height / 120).max(2);
    let counter = format!("F {frame:07}");
    let (w1, h1) = font::text_size(&counter, scale);
    let (w2, h2) = font::text_size(clock, scale);
    let pad = 2 * scale;
    let (x, y) = (2 * pad, 2 * pad);
    font::fill(picture, stride, width, height, x, y, w1.max(w2) + 2 * pad, h1 + h2 + 3 * pad, [0, 0, 0, 255]);
    font::draw(picture, stride, width, height, x + pad, y + pad, scale, &counter, [255, 255, 255, 255]);
    font::draw(picture, stride, width, height, x + pad, y + 2 * pad + h1, scale, clock, [255, 255, 255, 255]);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clock() {
        let at = UNIX_EPOCH + std::time::Duration::from_millis(86_400_000 * 3 + 13 * 3_600_000 + 5 * 60_000 + 7_042);
        assert_eq!(clock_text(at), "13:05:07.042");
    }

    #[test]
    fn scenes_move_and_differ() {
        let scenes = Scenes::new(64, 8);
        let stride = 64 * 4 + 16;
        let mut a = vec![0u8; stride * 8];
        let mut b = vec![0u8; stride * 8];
        scenes.copy(0, 0, &mut a, stride);
        scenes.copy(0, 1, &mut b, stride);
        // Moved by one pixel, wrapping around.
        assert_eq!(&a[4..64 * 4], &b[..63 * 4]);
        assert_eq!(&a[..4], &b[63 * 4..64 * 4]);
        let mut c = vec![0u8; stride * 8];
        scenes.copy(1, 0, &mut c, stride);
        let same = (0..64 * 8).filter(|p| a[(p / 64) * stride + (p % 64) * 4..][..3] == c[(p / 64) * stride + (p % 64) * 4..][..3]).count();
        assert!(same < 8, "{same} pixels alike");
    }

    #[test]
    fn smallest_sizes_draw() {
        // The sizes the protocol lets through, drawn on the CPU (a debug build checks overflow).
        for (w, h) in [(16, 16), (16, 30), (30, 16), (16, 4096), (4096, 16)] {
            let stride = w * 4;
            let mut picture = vec![0u8; stride * h];
            let screen = ScreenScenes::new(w, h);
            screen.draw(false, 7, 60, &mut picture, stride);
            screen.draw(true, 1000, 60, &mut picture, stride);
            Scenes::new(w, h).copy(1, 5, &mut picture, stride);
            draw_overlay(&mut picture, stride, w, h, 1234567, "23:59:59.999");
        }
    }

    #[test]
    fn overlay_fits_1080p() {
        let (w, h) = (1920, 1080);
        let mut picture = vec![7u8; w * h * 4];
        draw_overlay(&mut picture, w * 4, w, h, 1234567, "23:59:59.999");
        // The box starts at 36,36 for a scale of 9 and is black there.
        assert_eq!(&picture[(36 * w + 36) * 4..][..4], &[0, 0, 0, 255]);
    }
}
